from __future__ import annotations

import logging
from typing import Any

from app.core.config import settings
from app.repositories.catalog_repository import CatalogRepository

logger = logging.getLogger(__name__)

COLLECTION_NAME = "awb_threats"
REPORTS_COLLECTION = "awb_reports"
VECTOR_SIZE = 1024  # mistral-embed output dimension


def _get_qdrant_client():
    from qdrant_client import QdrantClient
    return QdrantClient(url=settings.QDRANT_URL)


def _embed_texts(texts: list[str]) -> list[list[float]]:
    from mistralai.client import Mistral
    client = Mistral(api_key=settings.MISTRAL_API_KEY)
    response = client.embeddings.create(model="mistral-embed", inputs=texts)
    return [item.embedding for item in response.data]


def _build_threat_documents() -> list[dict[str, Any]]:
    threats = CatalogRepository.list_threats_for_analysis()
    docs = []
    for threat in (threats or []):
        if not threat:
            continue
        threat_id = threat.get("id_menace")
        name = str(threat.get("nom_menace") or "").strip()
        description = str(threat.get("description") or "").strip()
        if not name or threat_id is None:
            continue

        mitigations = [
            str(m.get("description_mitigation") or "").strip()
            for m in (threat.get("mitigations") or [])
            if str(m.get("description_mitigation") or "").strip()
        ]
        scenarios = [
            str(s.get("description_scenario") or "").strip()
            for s in (threat.get("scenarios") or [])
            if str(s.get("description_scenario") or "").strip()
        ]

        text = f"Menace: {name}\nDescription: {description}"
        if scenarios:
            text += "\nScénarios d'attaque:\n" + "\n".join(f"- {s}" for s in scenarios[:3])
        if mitigations:
            text += "\nMitigations:\n" + "\n".join(f"- {m}" for m in mitigations[:5])

        docs.append({"id": int(threat_id), "text": text, "name": name})
    return docs


def index_report(report_id: str, app_name: str, description: str, selected_threats: list[dict]) -> None:
    if not settings.MISTRAL_API_KEY or not settings.QDRANT_URL:
        return
    try:
        from qdrant_client import QdrantClient
        from qdrant_client.models import Distance, VectorParams, PointStruct

        client = _get_qdrant_client()
        existing = [c.name for c in client.get_collections().collections]
        if REPORTS_COLLECTION not in existing:
            client.create_collection(
                collection_name=REPORTS_COLLECTION,
                vectors_config=VectorParams(size=VECTOR_SIZE, distance=Distance.COSINE),
            )

        threat_lines = []
        for t in selected_threats[:20]:
            name = str(t.get("name") or "").strip()
            desc = str(t.get("description") or "").strip()
            mitigations = t.get("mitigations") or []
            if name:
                line = f"- {name}: {desc}"
                if mitigations:
                    line += " | Mitigations: " + "; ".join(str(m).strip() for m in mitigations[:3] if str(m).strip())
                threat_lines.append(line)

        text = f"Application: {app_name}\nDescription: {description}"
        if threat_lines:
            text += "\nMenaces identifiees:\n" + "\n".join(threat_lines)

        vectors = _embed_texts([text])
        if not vectors:
            return

        point_id = abs(hash(report_id)) % (2 ** 53)
        client.upsert(
            collection_name=REPORTS_COLLECTION,
            points=[PointStruct(
                id=point_id,
                vector=vectors[0],
                payload={"text": text, "report_id": report_id, "app_name": app_name},
            )],
        )
        logger.info("RAG: rapport '%s' indexe dans Qdrant", app_name)
    except Exception:
        logger.exception("Erreur indexation rapport RAG")


def build_index() -> None:
    if not settings.MISTRAL_API_KEY:
        logger.warning("RAG désactivé: MISTRAL_API_KEY manquant")
        return
    if not settings.QDRANT_URL:
        logger.warning("RAG désactivé: QDRANT_URL manquant")
        return

    try:
        from qdrant_client import QdrantClient
        from qdrant_client.models import Distance, VectorParams, PointStruct

        client = _get_qdrant_client()

        existing = [c.name for c in client.get_collections().collections]
        if COLLECTION_NAME not in existing:
            client.create_collection(
                collection_name=COLLECTION_NAME,
                vectors_config=VectorParams(size=VECTOR_SIZE, distance=Distance.COSINE),
            )
            logger.info("Collection Qdrant '%s' créée", COLLECTION_NAME)

        # Skip indexation if collection already has points (data persisted)
        current_count = client.get_collection(COLLECTION_NAME).points_count or 0
        if current_count > 0:
            logger.info("RAG: collection '%s' déjà indexée (%d points), skip", COLLECTION_NAME, current_count)
            return

        docs = _build_threat_documents()
        if not docs:
            logger.warning("RAG: aucune menace à indexer dans le catalogue")
            return

        import time
        batch_size = 5
        points = []
        for i in range(0, len(docs), batch_size):
            batch = docs[i:i + batch_size]
            for attempt in range(4):
                try:
                    vectors = _embed_texts([d["text"] for d in batch])
                    break
                except Exception as exc:
                    if attempt == 3:
                        raise
                    wait = 2 ** attempt * 3
                    logger.warning("RAG embed retry %d après %ds: %s", attempt + 1, wait, exc)
                    time.sleep(wait)
            for doc, vector in zip(batch, vectors):
                points.append(PointStruct(
                    id=doc["id"],
                    vector=vector,
                    payload={"text": doc["text"], "name": doc["name"]},
                ))
            if i + batch_size < len(docs):
                time.sleep(1.2)

        client.upsert(collection_name=COLLECTION_NAME, points=points)
        logger.info("RAG: %d menaces indexées dans Qdrant", len(docs))

    except Exception:
        logger.exception("Erreur lors de l'indexation RAG — le chatbot fonctionnera sans RAG")


def query_context(question: str, top_k: int = 4) -> str:
    if not settings.MISTRAL_API_KEY or not settings.QDRANT_URL:
        return ""

    try:
        client = _get_qdrant_client()
        vectors = _embed_texts([question])
        if not vectors:
            return ""

        query_vector = vectors[0]
        existing = {c.name for c in client.get_collections().collections}
        chunks: list[str] = []

        if COLLECTION_NAME in existing:
            results = client.query_points(collection_name=COLLECTION_NAME, query=query_vector, limit=top_k).points
            chunks += [hit.payload.get("text", "") for hit in results if hit.payload and hit.payload.get("text")]

        if REPORTS_COLLECTION in existing:
            results = client.query_points(collection_name=REPORTS_COLLECTION, query=query_vector, limit=2).points
            chunks += [hit.payload.get("text", "") for hit in results if hit.payload and hit.payload.get("text")]

        return "\n\n".join(chunks)

    except Exception:
        logger.exception("Erreur lors de la requête RAG")
        return ""

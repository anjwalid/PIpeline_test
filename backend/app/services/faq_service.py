from __future__ import annotations

import logging
from typing import Any

from app.core.config import settings

logger = logging.getLogger(__name__)

FAQ_COLLECTION = "awb_faq"
VECTOR_SIZE = 1024
FAQ_THRESHOLD = 0.72   # score minimum pour une reponse directe FAQ
SCOPE_THRESHOLD = 0.50  # score minimum pour considerer la question dans le scope


def _get_qdrant_client():
    from qdrant_client import QdrantClient
    return QdrantClient(url=settings.QDRANT_URL)


def _embed_texts(texts: list[str]) -> list[list[float]]:
    from mistralai.client import Mistral
    client = Mistral(api_key=settings.MISTRAL_API_KEY)
    response = client.embeddings.create(model="mistral-embed", inputs=texts)
    return [item.embedding for item in response.data]


def _fetch_faq_from_db() -> list[dict[str, Any]]:
    import psycopg2
    from app.core.config import settings as s
    conn = psycopg2.connect(
        host=s.DB_HOST, port=s.DB_PORT,
        dbname=s.DB_NAME, user=s.DB_USER, password=s.DB_PASSWORD,
    )
    cur = conn.cursor()
    cur.execute(
        "SELECT id, question, answer, action_id, action_label, category "
        "FROM chatbot_faq WHERE is_active = TRUE ORDER BY id"
    )
    rows = cur.fetchall()
    conn.close()
    return [
        {
            "id": row[0],
            "question": row[1],
            "answer": row[2],
            "action_id": row[3],
            "action_label": row[4],
            "category": row[5],
        }
        for row in rows
    ]


def build_faq_index(force: bool = False) -> None:
    if not settings.MISTRAL_API_KEY or not settings.QDRANT_URL:
        return
    try:
        from qdrant_client import QdrantClient
        from qdrant_client.models import Distance, VectorParams, PointStruct

        client = _get_qdrant_client()
        existing = [c.name for c in client.get_collections().collections]

        if FAQ_COLLECTION not in existing:
            client.create_collection(
                collection_name=FAQ_COLLECTION,
                vectors_config=VectorParams(size=VECTOR_SIZE, distance=Distance.COSINE),
            )

        current_count = client.get_collection(FAQ_COLLECTION).points_count or 0
        if current_count > 0 and not force:
            logger.info("FAQ Qdrant deja indexe (%d points), skip", current_count)
            return

        entries = _fetch_faq_from_db()
        if not entries:
            logger.warning("Aucune entree FAQ en base")
            return

        questions = [e["question"] for e in entries]
        vectors = _embed_texts(questions)

        points = [
            PointStruct(
                id=entry["id"],
                vector=vector,
                payload={
                    "question": entry["question"],
                    "answer": entry["answer"],
                    "action_id": entry["action_id"],
                    "action_label": entry["action_label"],
                    "category": entry["category"],
                },
            )
            for entry, vector in zip(entries, vectors)
        ]

        client.upsert(collection_name=FAQ_COLLECTION, points=points)
        logger.info("FAQ: %d questions indexees dans Qdrant", len(points))

    except Exception:
        logger.exception("Erreur indexation FAQ")


_STOPWORDS = set([
    "je", "tu", "il", "elle", "on", "nous", "vous", "ils", "elles",
    "me", "te", "se", "le", "la", "les", "un", "une", "des", "du", "de", "da",
    "et", "ou", "mais", "donc", "or", "ni", "car", "que", "qui", "quoi",
    "est", "sont", "ai", "as", "a", "avons", "avez", "ont",
    "ce", "ca", "cest", "mon", "ma", "mes", "ton", "ta", "tes",
    "dans", "sur", "sous", "par", "pour", "avec", "sans", "en", "au", "aux",
    "veux", "puis", "peux", "fais", "faire", "aller", "voir",
    "pas", "ne", "non", "oui", "si", "bien", "tres", "tout",
    "comment", "quand", "pourquoi", "combien", "quel", "quelle", "quels", "quelles",
    "ici", "la", "voici", "cela", "celui", "celle",
])


def _query_faq_keywords(question: str) -> "dict[str, Any] | None":
    import unicodedata as _ud

    def _norm(s: str) -> str:
        s = _ud.normalize("NFD", s.lower())
        s = "".join(c for c in s if _ud.category(c) != "Mn")
        for ch in ("‘", "’", "`", "´"):
            s = s.replace(ch, " ")
        return s

    def _words(s: str) -> "set[str]":
        return {w for w in _norm(s).split() if w not in _STOPWORDS and len(w) > 2}

    entries = _fetch_faq_from_db()
    if not entries:
        return None

    q_words = _words(question)
    if not q_words:
        return None

    best_entry = None
    best_score = 0.0

    for entry in entries:
        kw = entry.get("question", "")
        kw_words = _words(kw)
        if not kw_words:
            continue
        common = len(kw_words & q_words)
        score = common / len(kw_words)
        if score > best_score and score >= 0.5:
            best_score = score
            best_entry = entry

    if best_entry:
        return {
            "answer": best_entry.get("answer", ""),
            "action_id": best_entry.get("action_id"),
            "action_label": best_entry.get("action_label"),
            "category": best_entry.get("category"),
            "score": best_score,
        }
    return None


def query_faq(question: str) -> dict[str, Any] | None:
    """
    Recherche dans le FAQ — sémantique via Qdrant si disponible, mots-clés sinon.
    Retourne { answer, action_id, action_label } ou None.
    """
    if not settings.MISTRAL_API_KEY or not settings.QDRANT_URL:
        return _query_faq_keywords(question)
    try:
        client = _get_qdrant_client()
        existing = {c.name for c in client.get_collections().collections}
        if FAQ_COLLECTION not in existing:
            return None

        vectors = _embed_texts([question])
        if not vectors:
            return None

        results = client.query_points(
            collection_name=FAQ_COLLECTION,
            query=vectors[0],
            limit=1,
        ).points

        if not results:
            return None

        best = results[0]
        score = best.score if hasattr(best, "score") else 0.0
        logger.debug("FAQ score=%.3f pour: %s", score, question[:60])

        if score >= FAQ_THRESHOLD and best.payload:
            return {
                "answer": best.payload.get("answer", ""),
                "action_id": best.payload.get("action_id"),
                "action_label": best.payload.get("action_label"),
                "category": best.payload.get("category"),
                "score": score,
            }
        return None

    except Exception:
        logger.exception("Erreur recherche FAQ")
        return None


def is_in_scope_semantic(question: str) -> bool:
    """
    Verifie si la question est dans le scope SecOps via similarite semantique.
    Cherche dans FAQ + menaces. Si score > SCOPE_THRESHOLD → in scope.
    """
    if not settings.MISTRAL_API_KEY or not settings.QDRANT_URL:
        return True  # fallback permissif si RAG indisponible

    try:
        from app.services.rag_service import COLLECTION_NAME as THREATS_COLLECTION
        client = _get_qdrant_client()
        existing = {c.name for c in client.get_collections().collections}

        vectors = _embed_texts([question])
        if not vectors:
            return True

        query_vector = vectors[0]

        for collection in [FAQ_COLLECTION, THREATS_COLLECTION]:
            if collection not in existing:
                continue
            results = client.query_points(
                collection_name=collection,
                query=query_vector,
                limit=1,
            ).points
            if results:
                score = results[0].score if hasattr(results[0], "score") else 0.0
                logger.debug("Scope check [%s] score=%.3f", collection, score)
                if score >= SCOPE_THRESHOLD:
                    return True

        return False

    except Exception:
        logger.exception("Erreur scope check semantique")
        return True  # fallback permissif

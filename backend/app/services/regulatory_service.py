from __future__ import annotations

import logging
import re
import time
from pathlib import Path
from typing import Any

from app.core.config import settings
from app.core.database import get_connection

logger = logging.getLogger(__name__)

COLLECTION_NAME = "awb_regulatory"
VECTOR_SIZE = 1024
CHUNK_MAX = 1800       # taille max d'un chunk (caractères)
CHUNK_MIN = 150        # taille min avant fusion avec le suivant
CHUNK_OVERLAP_WORDS = 40
REGULATORY_THRESHOLD = 0.45

# Patterns de titres de section — ordonnés du plus spécifique au plus général
_SECTION_PATTERNS = [
    # PCI-DSS (FR) : "Exigence 1 :", "Exigence 10.2"
    re.compile(r'^Exigence\s+\d[\d.]*', re.IGNORECASE),
    # Sous-exigences numérotées : "1.1", "1.1.1", "10.3.2"
    re.compile(r'^\d{1,2}\.\d{1,2}(\.\d{1,2})?\s+\S'),
    # Articles (lois, directives) : "Article 1", "Art. 3"
    re.compile(r'^Art(?:icle|\.)\s*\d+', re.IGNORECASE),
    # Chapitres / Sections / Titres
    re.compile(r'^(?:Chapitre|Section|Titre|Partie)\s+[IVXivx\d]+', re.IGNORECASE),
    # Numérotation romaine : "I.", "II.", "III."
    re.compile(r'^[IVX]{1,5}\.\s+\S'),
    # Numérotation simple niveau 1 : "1.", "2.", "12." (pas "1.1")
    re.compile(r'^\d{1,2}\.\s+[A-ZÀ-Ü\d]'),
]

REGULATORY_KEYWORDS = {
    "pci", "pci-dss", "pci dss", "carte", "paiement", "cardholder",
    "loi 09-08", "loi09-08", "loi 08-09", "loi08-09",
    "09-08", "09 08", "08-09", "08 09",
    "cndp", "donnees personnelles", "données personnelles",
    "rgpd", "gdpr", "consentement", "bam", "bank al-maghrib", "bank al maghrib",
    "circulaire", "directive", "reglementation", "réglementation", "compliance",
    "conformite", "conformité", "audit", "exigence", "controle", "contrôle",
    "securite bancaire", "sécurité bancaire", "cloud", "externalisation",
    "risque informatique", "gouvernance si",
}


def _get_qdrant_client():
    from qdrant_client import QdrantClient
    return QdrantClient(url=settings.QDRANT_URL)


def _embed_texts(texts: list[str]) -> list[list[float]]:
    from mistralai.client import Mistral
    client = Mistral(api_key=settings.MISTRAL_API_KEY)
    BATCH = 4
    all_embeddings: list[list[float]] = []
    for i in range(0, len(texts), BATCH):
        batch = texts[i:i + BATCH]
        for attempt in range(5):
            try:
                response = client.embeddings.create(model="mistral-embed", inputs=batch)
                all_embeddings.extend([item.embedding for item in response.data])
                time.sleep(1.5)
                break
            except Exception as exc:
                if "429" in str(exc) or "rate" in str(exc).lower():
                    wait = 10 * (attempt + 1)
                    logger.warning("Rate limit Mistral, attente %ds (tentative %d/5)", wait, attempt + 1)
                    time.sleep(wait)
                else:
                    raise
        else:
            raise RuntimeError("Rate limit Mistral persistant apres 5 tentatives")
    return all_embeddings


def _extract_text_from_pdf(file_bytes: bytes) -> str:
    import io
    import pdfplumber
    full_text: list[str] = []
    with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
        for page in pdf.pages:
            text = page.extract_text()
            if text:
                full_text.append(text.strip())
    return "\n\n".join(full_text)


def _is_section_header(line: str) -> bool:
    stripped = line.strip()
    if not stripped or len(stripped) > 120:
        return False
    return any(p.match(stripped) for p in _SECTION_PATTERNS)


def _split_large_chunk(text: str) -> list[str]:
    """Découpe un chunk trop grand en sous-chunks avec chevauchement."""
    if len(text) <= CHUNK_MAX:
        return [text]
    sub_chunks: list[str] = []
    paragraphs = [p.strip() for p in re.split(r'\n{2,}', text) if p.strip()]
    current = ""
    for para in paragraphs:
        if len(current) + len(para) > CHUNK_MAX and current:
            sub_chunks.append(current.strip())
            overlap = " ".join(current.split()[-CHUNK_OVERLAP_WORDS:])
            current = overlap + "\n\n" + para
        else:
            current = current + "\n\n" + para if current else para
    if current.strip():
        sub_chunks.append(current.strip())
    return sub_chunks or [text[:CHUNK_MAX]]


def _chunk_text(text: str, doc_id: int) -> list[dict]:
    """
    Chunking structuré : détecte les titres de section (Exigence, Article, etc.)
    et crée un chunk par section. Les sections trop grandes sont sous-découpées,
    les trop petites fusionnées avec la suivante.
    """
    lines = text.split("\n")
    sections: list[str] = []
    current_lines: list[str] = []

    for line in lines:
        if _is_section_header(line) and current_lines:
            block = "\n".join(current_lines).strip()
            if block:
                sections.append(block)
            current_lines = [line]
        else:
            current_lines.append(line)
    if current_lines:
        block = "\n".join(current_lines).strip()
        if block:
            sections.append(block)

    # Fallback : si aucun titre détecté, chunking par paragraphe
    if len(sections) <= 1:
        logger.info("Chunking structurel: aucun titre detecte, fallback paragraphes")
        sections = [p.strip() for p in re.split(r'\n{3,}', text) if p.strip()]

    # Post-traitement : fusionner les trop petits, découper les trop grands
    merged: list[str] = []
    pending = ""
    for section in sections:
        if pending:
            candidate = pending + "\n\n" + section
            if len(pending) < CHUNK_MIN:
                pending = candidate
                continue
            merged.append(pending)
            pending = section
        else:
            pending = section
    if pending:
        merged.append(pending)

    # Découper les chunks encore trop grands
    final_sections: list[str] = []
    for section in merged:
        final_sections.extend(_split_large_chunk(section))

    chunks: list[dict] = []
    for idx, section_text in enumerate(final_sections):
        if section_text.strip():
            chunks.append({
                "id": f"doc{doc_id}_chunk{idx}",
                "text": section_text.strip(),
                "doc_id": doc_id,
                "chunk_index": idx,
            })

    logger.info("Chunking: %d sections detectees -> %d chunks finaux", len(sections), len(chunks))
    return chunks


def _ensure_collection():
    from qdrant_client.models import Distance, VectorParams
    client = _get_qdrant_client()
    existing = [c.name for c in client.get_collections().collections]
    if COLLECTION_NAME not in existing:
        client.create_collection(
            collection_name=COLLECTION_NAME,
            vectors_config=VectorParams(size=VECTOR_SIZE, distance=Distance.COSINE),
        )


def _save_doc_to_db(display_name: str, category: str, filename: str, file_size: int, uploaded_by: str) -> int:
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO regulatory_documents
                    (display_name, category, original_filename, file_size, status, uploaded_by)
                VALUES (%s, %s, %s, %s, 'indexing', %s)
                RETURNING id
                """,
                (display_name, category, filename, file_size, uploaded_by),
            )
            doc_id = cur.fetchone()["id"]
        conn.commit()
        return doc_id
    finally:
        conn.close()


def _generate_shortcuts(chunks: list[dict], display_name: str) -> list[str]:
    """
    Demande à Mistral de générer 4 raccourcis spécifiques au contenu du document.
    Utilise les 5 premiers chunks (intro + premières sections).
    """
    try:
        from app.services.llm_clients import call_mistral
        import json as _json
        sample = "\n\n---\n\n".join(c["text"] for c in chunks[:5])
        sample = sample[:3000]
        prompt = (
            f"Tu es un assistant securite pour une banque marocaine.\n"
            f"Voici un extrait du document reglementaire '{display_name}':\n\n"
            f"{sample}\n\n"
            f"Genere exactement 4 raccourcis de questions SPECIFIQUES et PERTINENTES "
            f"qu'un ingenieur SecOps voudrait poser sur CE document precis.\n"
            f"Les raccourcis doivent etre courts (max 6 mots), en francais, et reflechir "
            f"le contenu reel du document.\n"
            f"Reponds UNIQUEMENT avec un tableau JSON de 4 chaines. Exemple:\n"
            f'["Exigence 8 : gestion des identites", "Controles reseau requis", '
            f'"Sanctions en cas de non-conformite", "Comment implementer le controle 6.3"]\n'
            f"Tableau JSON:"
        )
        raw = call_mistral(prompt).strip()
        raw = raw[raw.find("["):raw.rfind("]") + 1]
        shortcuts = _json.loads(raw)
        if isinstance(shortcuts, list):
            return [str(s).strip() for s in shortcuts[:4] if str(s).strip()]
    except Exception:
        logger.warning("Erreur generation raccourcis pour '%s'", display_name)
    return ["Vue d'ensemble", "Principales obligations", "Sanctions", "Comment se conformer"]


def _save_shortcuts(doc_id: int, shortcuts: list[str]):
    import json as _json
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE regulatory_documents SET shortcuts = %s WHERE id = %s",
                (_json.dumps(shortcuts, ensure_ascii=False), doc_id),
            )
        conn.commit()
    finally:
        conn.close()


def _update_doc_status(doc_id: int, status: str, chunk_count: int = 0, error: str | None = None):
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE regulatory_documents
                SET status = %s, chunk_count = %s, error_message = %s,
                    indexed_at = CASE WHEN %s = 'indexed' THEN NOW() ELSE indexed_at END
                WHERE id = %s
                """,
                (status, chunk_count, error, status, doc_id),
            )
        conn.commit()
    finally:
        conn.close()


def upload_and_index(
    file_bytes: bytes,
    filename: str,
    display_name: str,
    category: str,
    uploaded_by: str,
) -> dict:
    doc_id = _save_doc_to_db(display_name, category, filename, len(file_bytes), uploaded_by)
    try:
        if not settings.MISTRAL_API_KEY or not settings.QDRANT_URL:
            raise ValueError("MISTRAL_API_KEY ou QDRANT_URL manquant")

        _ensure_collection()
        text = _extract_text_from_pdf(file_bytes)
        if not text.strip():
            raise ValueError("Impossible d'extraire du texte du PDF")

        chunks = _chunk_text(text, doc_id)
        if not chunks:
            raise ValueError("Aucun chunk genere")

        texts = [c["text"] for c in chunks]
        embeddings = _embed_texts(texts)

        from qdrant_client.models import PointStruct
        client = _get_qdrant_client()
        points = [
            PointStruct(
                id=abs(hash(c["id"])) % (10 ** 9),
                vector=emb,
                payload={
                    "text": c["text"],
                    "doc_id": doc_id,
                    "display_name": display_name,
                    "category": category,
                    "chunk_index": c["chunk_index"],
                },
            )
            for c, emb in zip(chunks, embeddings)
        ]
        client.upsert(collection_name=COLLECTION_NAME, points=points)
        _update_doc_status(doc_id, "indexed", len(chunks))

        logger.info("Generation raccourcis pour '%s'...", display_name)
        shortcuts = _generate_shortcuts(chunks, display_name)
        _save_shortcuts(doc_id, shortcuts)
        logger.info("Document %d indexe: %d chunks, %d raccourcis", doc_id, len(chunks), len(shortcuts))
        return {"id": doc_id, "chunk_count": len(chunks), "status": "indexed"}

    except Exception as exc:
        logger.exception("Erreur indexation document %d", doc_id)
        _update_doc_status(doc_id, "error", error=str(exc))
        raise


def list_documents() -> list[dict]:
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT * FROM regulatory_documents ORDER BY uploaded_at DESC"
            )
            return [dict(row) for row in cur.fetchall()]
    finally:
        conn.close()


def delete_document(doc_id: int) -> bool:
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM regulatory_documents WHERE id = %s", (doc_id,))
            if not cur.fetchone():
                return False

        if settings.QDRANT_URL:
            try:
                from qdrant_client.models import Filter, FieldCondition, MatchValue
                client = _get_qdrant_client()
                existing = [c.name for c in client.get_collections().collections]
                if COLLECTION_NAME in existing:
                    client.delete(
                        collection_name=COLLECTION_NAME,
                        points_selector=Filter(
                            must=[FieldCondition(key="doc_id", match=MatchValue(value=doc_id))]
                        ),
                    )
            except Exception:
                logger.warning("Erreur suppression Qdrant pour doc %d", doc_id)

        with conn.cursor() as cur:
            cur.execute("DELETE FROM regulatory_documents WHERE id = %s", (doc_id,))
        conn.commit()
        return True
    finally:
        conn.close()


def query_regulatory(question: str, top_k: int = 3) -> str:
    print(f"[QREG] APPELÉ avec: '{question[:60]}'", flush=True)
    if not settings.MISTRAL_API_KEY or not settings.QDRANT_URL:
        print("[QREG] RETOUR EARLY: clés manquantes", flush=True)
        return ""
    try:
        client = _get_qdrant_client()
        existing = {c.name for c in client.get_collections().collections}
        if COLLECTION_NAME not in existing:
            return ""
        vectors = _embed_texts([question])
        if not vectors:
            return ""
        results = client.query_points(
            collection_name=COLLECTION_NAME,
            query=vectors[0],
            limit=top_k,
        ).points
        if not results:
            print(f"[QDRANT-REG] 0 résultat pour: '{question[:60]}'", flush=True)
            return ""
        scores = [round(r.score, 3) for r in results]
        print(f"[QDRANT-REG] Scores pour '{question[:60]}': {scores} | seuil={REGULATORY_THRESHOLD}", flush=True)
        chunks = []
        for r in results:
            if r.score < REGULATORY_THRESHOLD:
                continue
            payload = r.payload or {}
            source = payload.get("display_name", "Document reglementaire")
            text = payload.get("text", "")
            chunks.append(f"[{source}]\n{text}")
        return "\n\n---\n\n".join(chunks)
    except Exception:
        logger.exception("Erreur query_regulatory")
        return ""


def is_regulatory_question(message: str) -> bool:
    lowered = (message or "").casefold()
    return any(kw in lowered for kw in REGULATORY_KEYWORDS)

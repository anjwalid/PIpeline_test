from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.auth import AuthenticatedUser, get_current_user
from app.core.database import get_connection

router = APIRouter(prefix="/admin/knowledge", tags=["admin-knowledge"])


# ── FAQ ──────────────────────────────────────────────────────────────────────

class FaqItem(BaseModel):
    id: int
    category: str
    question: str
    answer: str
    action_id: str | None
    action_label: str | None
    is_active: bool


class FaqCreate(BaseModel):
    category: str
    question: str
    answer: str
    action_id: str | None = None
    action_label: str | None = None
    is_active: bool = True


class FaqUpdate(BaseModel):
    category: str | None = None
    question: str | None = None
    answer: str | None = None
    action_id: str | None = None
    action_label: str | None = None
    is_active: bool | None = None


@router.get("/faq", response_model=list[FaqItem])
def list_faq(_: Annotated[AuthenticatedUser, Depends(get_current_user)]):
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, category, question, answer, action_id, action_label, is_active "
                "FROM chatbot_faq ORDER BY category, id"
            )
            rows = cur.fetchall()
    return [
        FaqItem(id=r['id'], category=r['category'], question=r['question'], answer=r['answer'],
                action_id=r['action_id'], action_label=r['action_label'], is_active=r['is_active'])
        for r in rows
    ]


@router.post("/faq", response_model=FaqItem)
def create_faq(body: FaqCreate, _: Annotated[AuthenticatedUser, Depends(get_current_user)]):
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO chatbot_faq (category, question, answer, action_id, action_label, is_active) "
                "VALUES (%s,%s,%s,%s,%s,%s) RETURNING id",
                (body.category, body.question, body.answer, body.action_id, body.action_label, body.is_active)
            )
            new_id = cur.fetchone()['id']
        conn.commit()
    return FaqItem(id=new_id, **body.model_dump())


@router.put("/faq/{faq_id}", response_model=FaqItem)
def update_faq(faq_id: int, body: FaqUpdate, _: Annotated[AuthenticatedUser, Depends(get_current_user)]):
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, category, question, answer, action_id, action_label, is_active FROM chatbot_faq WHERE id=%s",
                (faq_id,)
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="FAQ introuvable.")
            existing = FaqItem(id=row['id'], category=row['category'], question=row['question'],
                               answer=row['answer'], action_id=row['action_id'],
                               action_label=row['action_label'], is_active=row['is_active'])
            updated = existing.model_copy(update={k: v for k, v in body.model_dump().items() if v is not None})
            cur.execute(
                "UPDATE chatbot_faq SET category=%s, question=%s, answer=%s, action_id=%s, action_label=%s, is_active=%s WHERE id=%s",
                (updated.category, updated.question, updated.answer, updated.action_id, updated.action_label, updated.is_active, faq_id)
            )
        conn.commit()
    return updated


@router.delete("/faq/{faq_id}")
def delete_faq(faq_id: int, _: Annotated[AuthenticatedUser, Depends(get_current_user)]):
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM chatbot_faq WHERE id=%s RETURNING id", (faq_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="FAQ introuvable.")
        conn.commit()
    return {"deleted": True}


# ── GUIDE STEPS ──────────────────────────────────────────────────────────────

class GuideStep(BaseModel):
    id: int
    tour_id: str
    step_order: int
    title: str
    description: str
    nav_section: str | None
    target: str | None = None


class GuideStepCreate(BaseModel):
    tour_id: str
    step_order: int
    title: str
    description: str
    nav_section: str | None = None
    target: str | None = None


class GuideStepUpdate(BaseModel):
    title: str | None = None
    description: str | None = None
    nav_section: str | None = None
    target: str | None = None
    step_order: int | None = None


@router.get("/guide-steps", response_model=list[GuideStep])
def list_guide_steps(_: Annotated[AuthenticatedUser, Depends(get_current_user)]):
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, tour_id, step_order, title, description, nav_section, target "
                "FROM chatbot_guide_step ORDER BY tour_id, step_order"
            )
            rows = cur.fetchall()
    return [GuideStep(id=r['id'], tour_id=r['tour_id'], step_order=r['step_order'],
                      title=r['title'], description=r['description'], nav_section=r['nav_section'],
                      target=r['target'])
            for r in rows]


@router.post("/guide-steps", response_model=GuideStep)
def create_guide_step(body: GuideStepCreate, _: Annotated[AuthenticatedUser, Depends(get_current_user)]):
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO chatbot_guide_step (tour_id, step_order, title, description, nav_section, target) "
                "VALUES (%s,%s,%s,%s,%s,%s) RETURNING id",
                (body.tour_id, body.step_order, body.title, body.description, body.nav_section, body.target)
            )
            new_id = cur.fetchone()['id']
        conn.commit()
    return GuideStep(id=new_id, **body.model_dump())


@router.put("/guide-steps/{step_id}", response_model=GuideStep)
def update_guide_step(step_id: int, body: GuideStepUpdate, _: Annotated[AuthenticatedUser, Depends(get_current_user)]):
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, tour_id, step_order, title, description, nav_section FROM chatbot_guide_step WHERE id=%s",
                (step_id,)
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Etape introuvable.")
            existing = GuideStep(id=row['id'], tour_id=row['tour_id'], step_order=row['step_order'],
                                 title=row['title'], description=row['description'], nav_section=row['nav_section'])
            patch = {k: v for k, v in body.model_dump().items() if v is not None}
            updated = existing.model_copy(update=patch)
            cur.execute(
                "UPDATE chatbot_guide_step SET step_order=%s, title=%s, description=%s, nav_section=%s, target=%s, updated_at=NOW() WHERE id=%s",
                (updated.step_order, updated.title, updated.description, updated.nav_section, updated.target, step_id)
            )
        conn.commit()
    return updated


@router.delete("/guide-steps/{step_id}")
def delete_guide_step(step_id: int, _: Annotated[AuthenticatedUser, Depends(get_current_user)]):
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM chatbot_guide_step WHERE id=%s RETURNING id", (step_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Etape introuvable.")
        conn.commit()
    return {"deleted": True}


# ── REGULATORY DOC SHORTCUTS ─────────────────────────────────────────────────

class ShortcutsUpdate(BaseModel):
    shortcuts: list[str]


@router.put("/regulatory/{doc_id}/shortcuts")
def update_doc_shortcuts(
    doc_id: int,
    body: ShortcutsUpdate,
    _: Annotated[AuthenticatedUser, Depends(get_current_user)],
):
    import json
    with get_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM regulatory_documents WHERE id=%s", (doc_id,))
            if cur.fetchone() is None:
                raise HTTPException(status_code=404, detail="Document introuvable.")
            cur.execute(
                "UPDATE regulatory_documents SET shortcuts=%s WHERE id=%s",
                (json.dumps(body.shortcuts, ensure_ascii=False), doc_id)
            )
        conn.commit()
    return {"updated": True}

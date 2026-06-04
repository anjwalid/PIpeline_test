from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from app.core.auth import AuthenticatedUser, get_current_user
from app.schemas.regulatory import RegulatoryDocumentResponse
from app.services.regulatory_service import delete_document, list_documents, upload_and_index

router = APIRouter(prefix="/admin/regulatory", tags=["admin-regulatory"])

ALLOWED_TYPES = {"application/pdf", "application/octet-stream"}
MAX_SIZE_MB = 50


@router.get("/documents", response_model=list[RegulatoryDocumentResponse])
def get_documents(_: Annotated[AuthenticatedUser, Depends(get_current_user)]):
    return list_documents()


@router.post("/documents", response_model=RegulatoryDocumentResponse)
async def upload_document(
    file: Annotated[UploadFile, File()],
    display_name: Annotated[str, Form()],
    category: Annotated[str, Form()],
    current_user: Annotated[AuthenticatedUser, Depends(get_current_user)],
):
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Seuls les fichiers PDF sont acceptes.")

    file_bytes = await file.read()
    if len(file_bytes) > MAX_SIZE_MB * 1024 * 1024:
        raise HTTPException(status_code=400, detail=f"Fichier trop volumineux (max {MAX_SIZE_MB} Mo).")
    if not display_name.strip():
        raise HTTPException(status_code=400, detail="Le nom du document est obligatoire.")
    if not category.strip():
        raise HTTPException(status_code=400, detail="La categorie est obligatoire.")

    try:
        result = upload_and_index(
            file_bytes=file_bytes,
            filename=file.filename,
            display_name=display_name.strip(),
            category=category.strip(),
            uploaded_by=current_user.display_name or current_user.username,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Erreur d'indexation: {str(exc)}")

    docs = list_documents()
    doc = next((d for d in docs if d["id"] == result["id"]), None)
    if not doc:
        raise HTTPException(status_code=500, detail="Document introuvable apres indexation.")
    return doc


@router.delete("/documents/{doc_id}", responses={404: {"description": "Document introuvable"}})
def remove_document(
    doc_id: int,
    _: Annotated[AuthenticatedUser, Depends(get_current_user)],
):
    if not delete_document(doc_id):
        raise HTTPException(status_code=404, detail="Document introuvable.")
    return {"deleted": True}

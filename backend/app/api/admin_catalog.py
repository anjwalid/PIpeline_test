from fastapi import APIRouter, HTTPException

from app.schemas.catalog import (
    CatalogRefreshResponse,
    CatalogReferenceGroupResponse,
    CatalogReferencePayload,
    CatalogReferenceResponse,
    CatalogThreatListItemResponse,
    CatalogThreatResponse,
    CatalogThreatUpsertRequest,
)
from app.services.catalog_service import CatalogService

router = APIRouter(prefix="/admin/catalog/threats", tags=["admin-catalog"])
THREAT_NOT_FOUND = "Menace non trouvee"
REFERENCE_NOT_FOUND = "Reference non trouvee"


@router.get("/references", response_model=list[CatalogReferenceResponse])
def list_references():
    return CatalogService.list_references()


@router.get("/references/groups", response_model=list[CatalogReferenceGroupResponse])
def list_reference_groups():
    return CatalogService.list_reference_groups()


@router.post("/references", response_model=CatalogReferenceResponse)
def create_reference(payload: CatalogReferencePayload):
    return CatalogService.create_reference(payload.dict())


@router.put(
    "/references/{reference_id}",
    response_model=CatalogReferenceResponse,
    responses={404: {"description": REFERENCE_NOT_FOUND}},
)
def update_reference(reference_id: int, payload: CatalogReferencePayload):
    reference = CatalogService.update_reference(reference_id, payload.dict())
    if not reference:
        raise HTTPException(status_code=404, detail=REFERENCE_NOT_FOUND)
    return reference


@router.delete(
    "/references/{reference_id}",
    responses={404: {"description": REFERENCE_NOT_FOUND}},
)
def delete_reference(reference_id: int):
    deleted = CatalogService.delete_reference(reference_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=REFERENCE_NOT_FOUND)
    return {"deleted": True}


@router.get("", response_model=list[CatalogThreatListItemResponse])
def list_threats():
    return CatalogService.list_threats()


@router.post("/refresh", response_model=CatalogRefreshResponse)
def refresh_threat_catalog():
    return CatalogService.trigger_catalog_refresh()


@router.get(
    "/{threat_id}",
    response_model=CatalogThreatResponse,
    responses={404: {"description": THREAT_NOT_FOUND}},
)
def get_threat(threat_id: int):
    threat = CatalogService.get_threat_by_id(threat_id)
    if not threat:
        raise HTTPException(status_code=404, detail=THREAT_NOT_FOUND)
    return threat


@router.post("", response_model=CatalogThreatResponse)
def create_threat(payload: CatalogThreatUpsertRequest):
    return CatalogService.create_threat(payload.dict())


@router.put(
    "/{threat_id}",
    response_model=CatalogThreatResponse,
    responses={404: {"description": THREAT_NOT_FOUND}},
)
def update_threat(threat_id: int, payload: CatalogThreatUpsertRequest):
    threat = CatalogService.update_threat(threat_id, payload.dict())
    if not threat:
        raise HTTPException(status_code=404, detail=THREAT_NOT_FOUND)
    return threat


@router.delete(
    "/{threat_id}",
    responses={404: {"description": THREAT_NOT_FOUND}},
)
def delete_threat(threat_id: int):
    deleted = CatalogService.delete_threat(threat_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=THREAT_NOT_FOUND)
    return {"deleted": True}

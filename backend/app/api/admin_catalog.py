from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from io import BytesIO

from app.core.auth import AuthenticatedUser, get_admin_user
from app.core.config import settings
from app.core.rate_limit import build_rate_limit_dependency
from app.schemas.catalog import (
    CatalogRefreshResponse,
    CatalogReferenceGroupResponse,
    CatalogReferencePayload,
    CatalogReferenceResponse,
    CatalogThreatListItemResponse,
    CatalogThreatResponse,
    CatalogThreatUpsertRequest,
    InternalSecuritySolutionPayload,
    InternalSecuritySolutionResponse,
)
from app.services.audit_service import AuditService
from app.services.catalog_service import CatalogService

admin_rate_limit = build_rate_limit_dependency(
    prefix="admin-catalog",
    limit=settings.ADMIN_RATE_LIMIT_COUNT,
    window_seconds=settings.ADMIN_RATE_LIMIT_WINDOW_SECONDS,
)

router = APIRouter(
    prefix="/admin/catalog/threats",
    tags=["admin-catalog"],
    dependencies=[Depends(admin_rate_limit)],
)
THREAT_NOT_FOUND = "Menace non trouvee"
REFERENCE_NOT_FOUND = "Reference non trouvee"
INTERNAL_SOLUTION_NOT_FOUND = "Solution interne non trouvee"


@router.get("/internal-solutions", response_model=list[InternalSecuritySolutionResponse])
def list_internal_solutions(_: Annotated[AuthenticatedUser, Depends(get_admin_user)]):
    return CatalogService.list_internal_solutions()


@router.post("/internal-solutions", response_model=InternalSecuritySolutionResponse)
def create_internal_solution(
    payload: InternalSecuritySolutionPayload,
    current_user: Annotated[AuthenticatedUser, Depends(get_admin_user)],
):
    solution = CatalogService.create_internal_solution(payload.dict())
    AuditService.log_action(
        actor=current_user,
        action_type="CREATE_INTERNAL_SOLUTION",
        entity_type="internal_solution",
        entity_id=str(solution["id_solution"]),
        entity_label=solution["nom_solution"],
        new_values=solution,
    )
    return solution


@router.put(
    "/internal-solutions/{solution_id}",
    response_model=InternalSecuritySolutionResponse,
    responses={404: {"description": INTERNAL_SOLUTION_NOT_FOUND}},
)
def update_internal_solution(
    solution_id: int,
    payload: InternalSecuritySolutionPayload,
    current_user: Annotated[AuthenticatedUser, Depends(get_admin_user)],
):
    previous = next(
        (item for item in CatalogService.list_internal_solutions() if item["id_solution"] == solution_id),
        None,
    )
    solution = CatalogService.update_internal_solution(solution_id, payload.dict())
    if not solution:
        raise HTTPException(status_code=404, detail=INTERNAL_SOLUTION_NOT_FOUND)
    AuditService.log_action(
        actor=current_user,
        action_type="UPDATE_INTERNAL_SOLUTION",
        entity_type="internal_solution",
        entity_id=str(solution["id_solution"]),
        entity_label=solution["nom_solution"],
        old_values=previous,
        new_values=solution,
    )
    return solution


@router.delete(
    "/internal-solutions/{solution_id}",
    responses={404: {"description": INTERNAL_SOLUTION_NOT_FOUND}},
)
def delete_internal_solution(
    solution_id: int,
    current_user: Annotated[AuthenticatedUser, Depends(get_admin_user)],
):
    previous = next(
        (item for item in CatalogService.list_internal_solutions() if item["id_solution"] == solution_id),
        None,
    )
    deleted = CatalogService.delete_internal_solution(solution_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=INTERNAL_SOLUTION_NOT_FOUND)
    if previous:
        AuditService.log_action(
            actor=current_user,
            action_type="DELETE_INTERNAL_SOLUTION",
            entity_type="internal_solution",
            entity_id=str(solution_id),
            entity_label=previous["nom_solution"],
            old_values=previous,
        )
    return {"deleted": True}


@router.get("/references", response_model=list[CatalogReferenceResponse])
def list_references(_: Annotated[AuthenticatedUser, Depends(get_admin_user)]):
    return CatalogService.list_references()


@router.get("/references/groups", response_model=list[CatalogReferenceGroupResponse])
def list_reference_groups(_: Annotated[AuthenticatedUser, Depends(get_admin_user)]):
    return CatalogService.list_reference_groups()


@router.post("/references", response_model=CatalogReferenceResponse)
def create_reference(
    payload: CatalogReferencePayload,
    current_user: Annotated[AuthenticatedUser, Depends(get_admin_user)],
):
    reference = CatalogService.create_reference(payload.dict())
    AuditService.log_action(
        actor=current_user,
        action_type="CREATE_REFERENCE",
        entity_type="reference",
        entity_id=str(reference["id_reference"]),
        entity_label=reference["nom_reference"],
        new_values=reference,
    )
    return reference


@router.put(
    "/references/{reference_id}",
    response_model=CatalogReferenceResponse,
    responses={404: {"description": REFERENCE_NOT_FOUND}},
)
def update_reference(
    reference_id: int,
    payload: CatalogReferencePayload,
    current_user: Annotated[AuthenticatedUser, Depends(get_admin_user)],
):
    previous = next(
        (item for item in CatalogService.list_references() if item["id_reference"] == reference_id),
        None,
    )
    reference = CatalogService.update_reference(reference_id, payload.dict())
    if not reference:
        raise HTTPException(status_code=404, detail=REFERENCE_NOT_FOUND)
    AuditService.log_action(
        actor=current_user,
        action_type="UPDATE_REFERENCE",
        entity_type="reference",
        entity_id=str(reference["id_reference"]),
        entity_label=reference["nom_reference"],
        old_values=previous,
        new_values=reference,
    )
    return reference


@router.delete(
    "/references/{reference_id}",
    responses={404: {"description": REFERENCE_NOT_FOUND}},
)
def delete_reference(
    reference_id: int,
    current_user: Annotated[AuthenticatedUser, Depends(get_admin_user)],
):
    previous = next(
        (item for item in CatalogService.list_references() if item["id_reference"] == reference_id),
        None,
    )
    deleted = CatalogService.delete_reference(reference_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=REFERENCE_NOT_FOUND)
    if previous:
        AuditService.log_action(
            actor=current_user,
            action_type="DELETE_REFERENCE",
            entity_type="reference",
            entity_id=str(reference_id),
            entity_label=previous["nom_reference"],
            old_values=previous,
        )
    return {"deleted": True}


@router.get("", response_model=list[CatalogThreatListItemResponse])
def list_threats(_: Annotated[AuthenticatedUser, Depends(get_admin_user)]):
    return CatalogService.list_threats()


@router.post("/refresh", response_model=CatalogRefreshResponse)
def refresh_threat_catalog(current_user: Annotated[AuthenticatedUser, Depends(get_admin_user)]):
    AuditService.log_action(
        actor=current_user,
        action_type="TRIGGER_CATALOG_REFRESH",
        entity_type="catalog",
        entity_id="threats",
        entity_label="Catalogue des menaces",
    )
    return CatalogService.trigger_catalog_refresh()


@router.get("/export")
def export_threat_catalog(_: Annotated[AuthenticatedUser, Depends(get_admin_user)]):
    export_payload = CatalogService.export_threat_catalog()
    return StreamingResponse(
        BytesIO(export_payload["content"]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f"attachment; filename={export_payload['filename']}"
        },
    )


@router.get(
    "/{threat_id}",
    response_model=CatalogThreatResponse,
    responses={404: {"description": THREAT_NOT_FOUND}},
)
def get_threat(
    threat_id: int,
    _: Annotated[AuthenticatedUser, Depends(get_admin_user)],
):
    threat = CatalogService.get_threat_by_id(threat_id)
    if not threat:
        raise HTTPException(status_code=404, detail=THREAT_NOT_FOUND)
    return threat


@router.post("", response_model=CatalogThreatResponse)
def create_threat(
    payload: CatalogThreatUpsertRequest,
    current_user: Annotated[AuthenticatedUser, Depends(get_admin_user)],
):
    threat = CatalogService.create_threat(payload.dict())
    AuditService.log_action(
        actor=current_user,
        action_type="CREATE_THREAT",
        entity_type="threat",
        entity_id=str(threat["id_menace"]),
        entity_label=threat["nom_menace"],
        new_values=threat,
    )
    return threat


@router.put(
    "/{threat_id}",
    response_model=CatalogThreatResponse,
    responses={404: {"description": THREAT_NOT_FOUND}},
)
def update_threat(
    threat_id: int,
    payload: CatalogThreatUpsertRequest,
    current_user: Annotated[AuthenticatedUser, Depends(get_admin_user)],
):
    previous = CatalogService.get_threat_by_id(threat_id)
    threat = CatalogService.update_threat(threat_id, payload.dict())
    if not threat:
        raise HTTPException(status_code=404, detail=THREAT_NOT_FOUND)
    AuditService.log_action(
        actor=current_user,
        action_type="UPDATE_THREAT",
        entity_type="threat",
        entity_id=str(threat["id_menace"]),
        entity_label=threat["nom_menace"],
        old_values=previous,
        new_values=threat,
    )
    return threat


@router.delete(
    "/{threat_id}",
    responses={404: {"description": THREAT_NOT_FOUND}},
)
def delete_threat(
    threat_id: int,
    current_user: Annotated[AuthenticatedUser, Depends(get_admin_user)],
):
    previous = CatalogService.get_threat_by_id(threat_id)
    deleted = CatalogService.delete_threat(threat_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=THREAT_NOT_FOUND)
    if previous:
        AuditService.log_action(
            actor=current_user,
            action_type="DELETE_THREAT",
            entity_type="threat",
            entity_id=str(threat_id),
            entity_label=previous["nom_menace"],
            old_values=previous,
        )
    return {"deleted": True}

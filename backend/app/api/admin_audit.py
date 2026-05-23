from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.core.auth import AuthenticatedUser, get_current_user
from app.schemas.audit import AuditTrailResponse
from app.services.audit_service import AuditService

router = APIRouter(prefix="/admin/audit-trail", tags=["admin-audit"])


@router.get("", response_model=list[AuditTrailResponse])
def list_audit_trail(
    _: Annotated[AuthenticatedUser, Depends(get_current_user)],
    limit: int = Query(default=200, ge=1, le=1000),
):
    return AuditService.list_actions(limit)

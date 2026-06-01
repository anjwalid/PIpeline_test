from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.core.auth import AuthenticatedUser, get_admin_user
from app.core.config import settings
from app.core.rate_limit import build_rate_limit_dependency
from app.schemas.audit import AuditTrailResponse
from app.services.audit_service import AuditService

admin_rate_limit = build_rate_limit_dependency(
    prefix="admin-audit",
    limit=settings.ADMIN_RATE_LIMIT_COUNT,
    window_seconds=settings.ADMIN_RATE_LIMIT_WINDOW_SECONDS,
)

router = APIRouter(
    prefix="/admin/audit-trail",
    tags=["admin-audit"],
    dependencies=[Depends(admin_rate_limit)],
)


@router.get("", response_model=list[AuditTrailResponse])
def list_audit_trail(
    _: Annotated[AuthenticatedUser, Depends(get_admin_user)],
    limit: int = Query(default=200, ge=1, le=1000),
):
    return AuditService.list_actions(limit)

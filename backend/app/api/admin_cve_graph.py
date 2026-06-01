from typing import Annotated

from fastapi import APIRouter, Depends, Query

from app.core.auth import AuthenticatedUser, get_admin_user
from app.core.config import settings
from app.core.rate_limit import build_rate_limit_dependency
from app.schemas.cve_graph import CveGraphSearchResponse, CveGraphStatsResponse
from app.services.cve_graph_service import CveGraphService

admin_rate_limit = build_rate_limit_dependency(
    prefix="admin-cve-graph",
    limit=settings.ADMIN_RATE_LIMIT_COUNT,
    window_seconds=settings.ADMIN_RATE_LIMIT_WINDOW_SECONDS,
)

router = APIRouter(
    prefix="/admin/cve-graph",
    tags=["admin-cve-graph"],
    dependencies=[Depends(admin_rate_limit)],
)


@router.get("/stats", response_model=CveGraphStatsResponse)
def get_cve_graph_stats(_: Annotated[AuthenticatedUser, Depends(get_admin_user)]):
    return CveGraphService.get_graph_stats()


@router.get("/search", response_model=CveGraphSearchResponse)
def search_cve_graph(
    _: Annotated[AuthenticatedUser, Depends(get_admin_user)],
    q: str = Query(default="", description="Recherche libre simple"),
    limit: int = Query(default=20, ge=1, le=50),
):
    return CveGraphService.search_graph(q, limit=limit)

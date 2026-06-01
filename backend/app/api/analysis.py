from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from app.core.auth import AuthenticatedUser, get_current_user, user_has_role
from app.core.config import settings
from app.core.exceptions import AnalysisStepError
from app.core.rate_limit import build_rate_limit_dependency
from app.schemas.analysis import AnalysisCreateRequest, AnalysisCreateResponse
from app.services.llm_clients import LlmGuardrailBlockedError
from app.services.analysis_service import AnalysisService

router = APIRouter(tags=["analyses"])
analysis_rate_limit = build_rate_limit_dependency(
    prefix="analysis",
    limit=settings.ANALYSIS_RATE_LIMIT_COUNT,
    window_seconds=settings.ANALYSIS_RATE_LIMIT_WINDOW_SECONDS,
)


def _ensure_latest_artifact_access(
    current_user: AuthenticatedUser,
    owner_id,
) -> None:
    if owner_id is None:
        raise HTTPException(status_code=404, detail="Aucun artefact temporaire disponible")

    if str(owner_id) == str(current_user.user_id):
        return

    if user_has_role(current_user, "admin"):
        return

    raise HTTPException(status_code=403, detail="Acces non autorise a cet artefact temporaire.")


@router.post("/analyses", response_model=AnalysisCreateResponse)
@router.post("/analyze", response_model=AnalysisCreateResponse, include_in_schema=False)
def create_analysis(
    payload: AnalysisCreateRequest,
    current_user: AuthenticatedUser = Depends(get_current_user),
    _: None = Depends(analysis_rate_limit),
):
    try:
        result = AnalysisService.create_analysis(
            app_name=payload.app_name,
            app_description=payload.app_description,
            questionnaire_code=payload.questionnaire_code,
            answers=payload.answers,
            generated_by=current_user,
            dev_name=payload.dev_name or "",
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except AnalysisStepError as e:
        if isinstance(e.cause, LlmGuardrailBlockedError):
            blocked_entity = e.cause.blocked_entity or "DONNEE_SENSIBLE"
            raise HTTPException(
                status_code=403,
                detail={
                    "error_type": "GUARDRAIL_BLOCKED",
                    "message": (
                        "Action non autorisee selon la strategie de protection AWB. "
                        "Veuillez retirer les donnees sensibles ou les liens non autorises."
                    ),
                    "blocked_entity": blocked_entity,
                    "guardrail_name": e.cause.guardrail_name,
                },
            )
        raise HTTPException(status_code=500, detail=e.to_detail())
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={
                "error_type": "UNEXPECTED_BACKEND_ERROR",
                "step": "api_analysis",
                "message": "Erreur inattendue pendant l'analyse.",
                "cause": None,
            },
        )


@router.get("/download-report", include_in_schema=False)
def download_report(current_user: AuthenticatedUser = Depends(get_current_user)):
    _ensure_latest_artifact_access(current_user, AnalysisService.get_latest_report_owner_id())
    report_path = AnalysisService.get_latest_report_path()
    if not report_path:
        raise HTTPException(status_code=404, detail="Aucun rapport disponible")

    report_file = Path(report_path)
    if not report_file.exists():
        raise HTTPException(status_code=404, detail="Fichier rapport introuvable")

    return FileResponse(
        path=str(report_file),
        media_type="application/pdf",
        filename=report_file.name,
        headers={"Content-Disposition": "inline"},
    )


@router.get("/download-dfd", include_in_schema=False)
def download_dfd(current_user: AuthenticatedUser = Depends(get_current_user)):
    _ensure_latest_artifact_access(current_user, AnalysisService.get_latest_dfd_owner_id())
    dfd_path = AnalysisService.get_latest_dfd_path()
    if not dfd_path:
        raise HTTPException(status_code=404, detail="Aucun DFD disponible")

    dfd_file = Path(dfd_path)
    if not dfd_file.exists():
        raise HTTPException(status_code=404, detail="Fichier DFD introuvable")

    return FileResponse(
        path=str(dfd_file),
        media_type="image/png",
        filename=dfd_file.name,
    )

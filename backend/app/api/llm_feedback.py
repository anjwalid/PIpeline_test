from typing import Annotated

from fastapi import APIRouter, Depends

from app.core.auth import AuthenticatedUser, get_current_user
from app.schemas.llm_feedback import LlmFeedbackCreateRequest, LlmFeedbackResponse
from app.services.audit_service import AuditService
from app.services.llm_feedback_service import LlmFeedbackService

router = APIRouter(prefix="/reports/{report_id}/feedback-memory", tags=["llm-feedback"])


@router.get("", response_model=list[LlmFeedbackResponse])
def list_report_feedback(
    report_id: str,
    _: Annotated[AuthenticatedUser, Depends(get_current_user)],
):
    return LlmFeedbackService.list_feedback_for_report(report_id)


@router.post("", response_model=LlmFeedbackResponse)
def create_report_feedback(
    report_id: str,
    payload: LlmFeedbackCreateRequest,
    current_user: Annotated[AuthenticatedUser, Depends(get_current_user)],
):
    row = LlmFeedbackService.create_feedback(
        report_id=report_id,
        payload=payload,
        actor=current_user,
    )
    AuditService.log_action(
        actor=current_user,
        action_type="CREATE_LLM_FEEDBACK",
        entity_type="llm_feedback",
        entity_id=str(row["id"]),
        entity_label=payload.section_type,
        parent_entity_type="report",
        parent_entity_id=report_id,
        new_values=row,
        comment=payload.correction_reason,
    )
    return row

from typing import Annotated

from fastapi import APIRouter, Depends

from app.core.auth import AuthenticatedUser, get_current_user
from app.schemas.secops_chat import SecOpsChatRequest, SecOpsChatResponse
from app.services.secops_chat_service import SecOpsChatService

router = APIRouter(prefix="/secops-chat", tags=["secops-chat"])


@router.post("/message", response_model=SecOpsChatResponse)
def send_secops_chat_message(
    payload: SecOpsChatRequest,
    current_user: Annotated[AuthenticatedUser, Depends(get_current_user)],
):
    return SecOpsChatResponse(**SecOpsChatService.respond(
        message=payload.message,
        current_user=current_user,
        report_id=payload.report_id,
        draft_context=payload.draft_context.model_dump() if payload.draft_context else None,
        action_id=payload.action_id,
        action_payload=payload.action_payload,
    ))

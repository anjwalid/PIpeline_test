from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from app.core.auth import AuthenticatedUser, get_current_user
from app.schemas.questionnaire import (
    QuestionnaireListItemResponse,
    QuestionnaireResponse,
    QuestionnaireUpsertRequest,
)
from app.services.audit_service import AuditService
from app.services.questionnaire_service import QuestionnaireService

router = APIRouter(prefix="/admin/questionnaires", tags=["admin-questionnaires"])
QUESTIONNAIRE_NOT_FOUND = "Questionnaire non trouvé"


@router.get("", response_model=list[QuestionnaireListItemResponse])
def list_questionnaires(_: Annotated[AuthenticatedUser, Depends(get_current_user)]):
    return QuestionnaireService.list_questionnaires()


@router.get(
    "/{questionnaire_id}",
    response_model=QuestionnaireResponse,
    responses={404: {"description": QUESTIONNAIRE_NOT_FOUND}},
)
def get_questionnaire(
    questionnaire_id: int,
    _: Annotated[AuthenticatedUser, Depends(get_current_user)],
):
    questionnaire = QuestionnaireService.get_questionnaire_by_id(questionnaire_id)
    if not questionnaire:
        raise HTTPException(status_code=404, detail=QUESTIONNAIRE_NOT_FOUND)
    return questionnaire


@router.post("", response_model=QuestionnaireResponse)
def create_questionnaire(
    payload: QuestionnaireUpsertRequest,
    current_user: Annotated[AuthenticatedUser, Depends(get_current_user)],
):
    questionnaire = QuestionnaireService.create_questionnaire(payload.dict())
    AuditService.log_action(
        actor=current_user,
        action_type="CREATE_QUESTIONNAIRE",
        entity_type="questionnaire",
        entity_id=str(questionnaire["id"]),
        entity_label=questionnaire["name"],
        new_values={
            "code": questionnaire["code"],
            "name": questionnaire["name"],
            "version": questionnaire["version"],
            "status": questionnaire["status"],
            "is_active": questionnaire["is_active"],
        },
    )
    return questionnaire


@router.put(
    "/{questionnaire_id}",
    response_model=QuestionnaireResponse,
    responses={404: {"description": QUESTIONNAIRE_NOT_FOUND}},
)
def update_questionnaire(
    questionnaire_id: int,
    payload: QuestionnaireUpsertRequest,
    current_user: Annotated[AuthenticatedUser, Depends(get_current_user)],
):
    previous = QuestionnaireService.get_questionnaire_by_id(questionnaire_id)
    questionnaire = QuestionnaireService.update_questionnaire(questionnaire_id, payload.dict())
    if not questionnaire:
        raise HTTPException(status_code=404, detail=QUESTIONNAIRE_NOT_FOUND)
    AuditService.log_action(
        actor=current_user,
        action_type="UPDATE_QUESTIONNAIRE",
        entity_type="questionnaire",
        entity_id=str(questionnaire["id"]),
        entity_label=questionnaire["name"],
        old_values=previous,
        new_values=questionnaire,
    )
    return questionnaire


@router.delete(
    "/{questionnaire_id}",
    responses={404: {"description": QUESTIONNAIRE_NOT_FOUND}},
)
def delete_questionnaire(
    questionnaire_id: int,
    current_user: Annotated[AuthenticatedUser, Depends(get_current_user)],
):
    previous = QuestionnaireService.get_questionnaire_by_id(questionnaire_id)
    deleted = QuestionnaireService.delete_questionnaire(questionnaire_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=QUESTIONNAIRE_NOT_FOUND)
    if previous:
        AuditService.log_action(
            actor=current_user,
            action_type="DELETE_QUESTIONNAIRE",
            entity_type="questionnaire",
            entity_id=str(questionnaire_id),
            entity_label=previous["name"],
            old_values=previous,
        )
    return {"deleted": True}

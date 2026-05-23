from pydantic import BaseModel


class SecOpsChatDraftContext(BaseModel):
    app_name: str | None = None
    app_description: str | None = None
    dev_name: str | None = None
    questionnaire_code: str | None = None
    answers: dict[str, str | bool | list[str] | None] = {}
    active_question: dict | None = None


class SecOpsChatActionOption(BaseModel):
    action_id: str
    label: str
    payload: dict = {}


class SecOpsChatActionGroup(BaseModel):
    title: str
    options: list[SecOpsChatActionOption] = []


class SecOpsChatRequest(BaseModel):
    message: str = ""
    report_id: str | None = None
    draft_context: SecOpsChatDraftContext | None = None
    action_id: str | None = None
    action_payload: dict = {}


class SecOpsChatResponse(BaseModel):
    reply: str
    option_groups: list[SecOpsChatActionGroup] = []

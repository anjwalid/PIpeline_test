from datetime import datetime

from pydantic import BaseModel


class LlmFeedbackCreateRequest(BaseModel):
    report_version_number: int | None = None
    section_type: str
    section_identifier: str | None = None
    threat_name: str | None = None
    original_content: str
    corrected_content: str
    correction_reason: str | None = None
    error_type: str


class LlmFeedbackResponse(BaseModel):
    id: int
    report_id: str
    report_version_number: int | None = None
    section_type: str
    section_identifier: str | None = None
    threat_name: str | None = None
    original_content: str
    corrected_content: str
    correction_reason: str | None = None
    error_type: str
    created_by: str | None = None
    created_by_username: str | None = None
    created_by_email: str | None = None
    created_at: datetime

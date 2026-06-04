from typing import Dict, Union, List, Optional
from pydantic import BaseModel, Field

AnswerValue = Union[str, bool, List[str], None]


class DfdArtifactResponse(BaseModel):
    boundaries: List[dict] = Field(default_factory=list)
    external_entities: List[dict] = Field(default_factory=list)
    processes: List[dict] = Field(default_factory=list)
    data_stores: List[dict] = Field(default_factory=list)
    data_flows: List[dict] = Field(default_factory=list)

class AnalysisCreateRequest(BaseModel):
    app_name: str
    app_description: str
    questionnaire_code: str
    answers: Dict[str, AnswerValue]
    dev_name: Optional[str] = None

class AnalysisCreateResponse(BaseModel):
    analysis_id: int
    status: str
    report_id: str
    report_url: str
    dfd_image_url: Optional[str] = None
    dfd_json: Optional[DfdArtifactResponse] = None
    application_description: Optional[str] = None
    threat_count: Optional[int] = None

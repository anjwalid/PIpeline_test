from datetime import datetime

from pydantic import BaseModel, Field


class ReportAnnotationResponse(BaseModel):
    id: str
    annotation: str
    created_by_username: str | None = None
    created_by_email: str | None = None
    created_at: datetime


class ReportStatusHistoryResponse(BaseModel):
    id: str
    old_status: str | None = None
    new_status: str
    changed_by_username: str | None = None
    changed_by_email: str | None = None
    comment: str | None = None
    changed_at: datetime


class ReportResponse(BaseModel):
    id: str
    title: str
    app_name: str
    description: str | None = None
    summary: str
    file_name: str
    file_type: str
    file_size: int | None = None
    status: str
    report_url: str
    generated_by: str
    generated_by_username: str | None = None
    generated_by_email: str | None = None
    generated_at: datetime
    validated_by: str | None = None
    validated_by_username: str | None = None
    validated_by_email: str | None = None
    validated_at: datetime | None = None
    annotations: list[ReportAnnotationResponse] = Field(default_factory=list)
    status_history: list[ReportStatusHistoryResponse] = Field(default_factory=list)


class ReportStatusUpdateRequest(BaseModel):
    status: str
    comment: str | None = None


class EditableThreat(BaseModel):
    name: str
    description: str | None = None
    attack_scenarios: list[str] = Field(default_factory=list)
    mitigations: list[str] = Field(default_factory=list)


class ReportResultsResponse(BaseModel):
    report_id: str
    app_name: str
    developer_name: str
    application_description: str
    application_version: str
    selected_threats: list[EditableThreat] = Field(default_factory=list)
    dfd_image_path: str | None = None
    dfd_reference: str | None = None
    updated_at: datetime | None = None


class ReportResultsUpdateRequest(BaseModel):
    app_name: str
    developer_name: str
    application_description: str
    selected_threats: list[EditableThreat]
    dfd_image_path: str | None = None
    dfd_reference: str | None = None


class ReportDfdUploadResponse(BaseModel):
    dfd_image_path: str
    original_file_name: str


class ReportsByMonthEntry(BaseModel):
    month: str
    count: int


class ThreatFrequencyEntry(BaseModel):
    threat_name: str
    count: int


class RiskyApplicationEntry(BaseModel):
    report_id: str
    app_name: str
    status: str
    threat_count: int
    scenario_count: int
    mitigation_count: int
    risk_score: int
    generated_at: datetime


class ManagerDashboardMetricsResponse(BaseModel):
    total_reports: int
    approved_reports: int
    approval_rate: float
    average_validation_time_hours: float | None = None
    reports_by_month: list[ReportsByMonthEntry] = Field(default_factory=list)
    most_frequent_threats: list[ThreatFrequencyEntry] = Field(default_factory=list)
    riskiest_applications: list[RiskyApplicationEntry] = Field(default_factory=list)

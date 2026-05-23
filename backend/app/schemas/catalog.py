from typing import List, Optional

from pydantic import BaseModel


class CatalogMitigationPayload(BaseModel):
    description_mitigation: str


class CatalogScenarioPayload(BaseModel):
    description_scenario: str


class CatalogReferencePayload(BaseModel):
    id_reference: Optional[int] = None
    reference_menace: str
    nom_reference: str
    lien: Optional[str] = None


class InternalSecuritySolutionPayload(BaseModel):
    nom_solution: str
    type_solution: str
    editeur_solution: Optional[str] = None
    usage_securite: Optional[str] = None
    description_solution: Optional[str] = None
    actif: bool = True


class CatalogThreatUpsertRequest(BaseModel):
    nom_menace: str
    description: Optional[str] = None
    reference_menace: Optional[str] = None
    mitigations: List[CatalogMitigationPayload] = []
    scenarios: List[CatalogScenarioPayload] = []
    references: List[CatalogReferencePayload] = []


class CatalogMitigationResponse(BaseModel):
    id_mitigation: int
    id_menace: int
    description_mitigation: str
    conditions_mitigation: Optional[str] = None


class CatalogScenarioResponse(BaseModel):
    id_scenario: int
    id_menace: int
    description_scenario: str
    conditions_scenario: Optional[str] = None


class CatalogReferenceResponse(BaseModel):
    id_reference: int
    reference_menace: str
    nom_reference: str
    lien: Optional[str] = None


class InternalSecuritySolutionResponse(BaseModel):
    id_solution: int
    nom_solution: str
    type_solution: str
    editeur_solution: Optional[str] = None
    usage_securite: Optional[str] = None
    description_solution: Optional[str] = None
    actif: bool


class CatalogReferenceGroupResponse(BaseModel):
    normalized_name: str
    display_name: str
    code_count: int
    threat_count: int
    reference_codes: List[str] = []


class CatalogThreatResponse(BaseModel):
    id_menace: int
    nom_menace: str
    description: Optional[str] = None
    reference_menace: Optional[str] = None
    mitigations: List[CatalogMitigationResponse] = []
    scenarios: List[CatalogScenarioResponse] = []
    references: List[CatalogReferenceResponse] = []


class CatalogThreatListItemResponse(BaseModel):
    id_menace: int
    nom_menace: str
    description: Optional[str] = None
    reference_menace: Optional[str] = None
    mitigation_count: int
    scenario_count: int
    reference_count: int


class CatalogRefreshResponse(BaseModel):
    status: str
    message: str

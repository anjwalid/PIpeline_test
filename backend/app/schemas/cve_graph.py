from typing import List, Optional

from pydantic import BaseModel


class CveGraphNodeResponse(BaseModel):
    id: str
    label: str
    node_type: str
    name: str
    score: Optional[float] = None
    metadata: dict = {}


class CveGraphEdgeResponse(BaseModel):
    source: str
    target: str
    label: str


class CveMatchResponse(BaseModel):
    cve_id: str
    description: str
    vendor: Optional[str] = None
    product: Optional[str] = None
    product_version: Optional[str] = None
    attack_vectors: List[str] = []
    severity: Optional[str] = None
    base_score: Optional[float] = None
    published: Optional[str] = None


class CveGraphSearchResponse(BaseModel):
    enabled: bool
    disabled_reason: Optional[str] = None
    query: str
    extracted_terms: List[str] = []
    nodes: List[CveGraphNodeResponse] = []
    edges: List[CveGraphEdgeResponse] = []
    matches: List[CveMatchResponse] = []


class CveGraphStatsResponse(BaseModel):
    enabled: bool
    disabled_reason: Optional[str] = None
    vendor_count: int = 0
    product_count: int = 0
    version_count: int = 0
    cve_count: int = 0
    attack_vector_count: int = 0
    critical_cve_count: int = 0
    latest_cves: List[CveMatchResponse] = []

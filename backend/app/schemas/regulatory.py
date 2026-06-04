from typing import Optional
from datetime import datetime
from pydantic import BaseModel


class RegulatoryDocumentResponse(BaseModel):
    id: int
    display_name: str
    category: str
    original_filename: str
    file_size: Optional[int] = None
    chunk_count: int
    status: str
    error_message: Optional[str] = None
    uploaded_at: datetime
    indexed_at: Optional[datetime] = None
    uploaded_by: Optional[str] = None
    shortcuts: list[str] = []

from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel


class AuditTrailResponse(BaseModel):
    id: int
    actor_id: Optional[str] = None
    actor_username: str
    actor_email: Optional[str] = None
    actor_display_name: Optional[str] = None
    actor_role: Optional[str] = None
    action_type: str
    entity_type: str
    entity_id: str
    entity_label: Optional[str] = None
    parent_entity_type: Optional[str] = None
    parent_entity_id: Optional[str] = None
    old_values: Optional[dict[str, Any]] = None
    new_values: Optional[dict[str, Any]] = None
    metadata: Optional[dict[str, Any]] = None
    comment: Optional[str] = None
    created_at: datetime

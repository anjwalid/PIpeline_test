import logging
from typing import Any

from app.core.auth import AuthenticatedUser
from app.repositories.audit_repository import AuditRepository

logger = logging.getLogger(__name__)


class AuditService:
    @staticmethod
    def ensure_schema() -> None:
        AuditRepository.ensure_schema()

    @staticmethod
    def log_action(
        *,
        actor: AuthenticatedUser,
        action_type: str,
        entity_type: str,
        entity_id: str,
        entity_label: str | None = None,
        parent_entity_type: str | None = None,
        parent_entity_id: str | None = None,
        old_values: dict[str, Any] | None = None,
        new_values: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        comment: str | None = None,
        actor_role: str | None = None,
    ) -> None:
        try:
            AuditRepository.log_action(
                actor=actor,
                action_type=action_type,
                entity_type=entity_type,
                entity_id=entity_id,
                entity_label=entity_label,
                parent_entity_type=parent_entity_type,
                parent_entity_id=parent_entity_id,
                old_values=old_values,
                new_values=new_values,
                metadata=metadata,
                comment=comment,
                actor_role=actor_role,
            )
        except Exception:
            logger.exception(
                "Echec journalisation audit: action_type=%s entity_type=%s entity_id=%s",
                action_type,
                entity_type,
                entity_id,
            )

    @staticmethod
    def list_actions(limit: int = 200) -> list[dict]:
        return AuditRepository.list_actions(limit)

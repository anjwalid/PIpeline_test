import json
from typing import Any

from app.core.auth import AuthenticatedUser
from app.core.database import get_connection


class AuditRepository:
    @staticmethod
    def ensure_schema() -> None:
        conn = get_connection()
        try:
            with conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        CREATE TABLE IF NOT EXISTS audit_trail (
                            id BIGSERIAL PRIMARY KEY,
                            actor_id UUID,
                            actor_username TEXT NOT NULL,
                            actor_email TEXT,
                            actor_display_name TEXT,
                            actor_role TEXT,
                            action_type TEXT NOT NULL,
                            entity_type TEXT NOT NULL,
                            entity_id TEXT NOT NULL,
                            entity_label TEXT,
                            parent_entity_type TEXT,
                            parent_entity_id TEXT,
                            old_values JSONB,
                            new_values JSONB,
                            metadata JSONB,
                            comment TEXT,
                            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                        )
                        """
                    )
                    cur.execute(
                        """
                        CREATE INDEX IF NOT EXISTS idx_audit_trail_created_at
                        ON audit_trail (created_at DESC)
                        """
                    )
                    cur.execute(
                        """
                        CREATE INDEX IF NOT EXISTS idx_audit_trail_actor_username
                        ON audit_trail (actor_username)
                        """
                    )
                    cur.execute(
                        """
                        CREATE INDEX IF NOT EXISTS idx_audit_trail_entity
                        ON audit_trail (entity_type, entity_id)
                        """
                    )
                    cur.execute(
                        """
                        CREATE INDEX IF NOT EXISTS idx_audit_trail_action_type
                        ON audit_trail (action_type)
                        """
                    )
        finally:
            conn.close()

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
    ) -> dict:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO audit_trail (
                        actor_id,
                        actor_username,
                        actor_email,
                        actor_display_name,
                        actor_role,
                        action_type,
                        entity_type,
                        entity_id,
                        entity_label,
                        parent_entity_type,
                        parent_entity_id,
                        old_values,
                        new_values,
                        metadata,
                        comment
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s)
                    RETURNING *
                    """,
                    (
                        str(actor.user_id),
                        actor.username,
                        actor.email,
                        actor.display_name,
                        actor_role,
                        action_type,
                        entity_type,
                        entity_id,
                        entity_label,
                        parent_entity_type,
                        parent_entity_id,
                        json.dumps(old_values, ensure_ascii=False) if old_values is not None else None,
                        json.dumps(new_values, ensure_ascii=False) if new_values is not None else None,
                        json.dumps(metadata, ensure_ascii=False) if metadata is not None else None,
                        comment,
                    ),
                )
                row = cur.fetchone()
                conn.commit()
                return row
        finally:
            conn.close()

    @staticmethod
    def list_actions(limit: int = 200) -> list[dict]:
        normalized_limit = max(1, min(limit, 1000))
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT *
                    FROM audit_trail
                    ORDER BY created_at DESC, id DESC
                    LIMIT %s
                    """,
                    (normalized_limit,),
                )
                return cur.fetchall()
        finally:
            conn.close()

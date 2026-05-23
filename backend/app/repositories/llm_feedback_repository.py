from __future__ import annotations

from typing import Iterable

from app.core.auth import AuthenticatedUser
from app.core.database import get_connection


class LlmFeedbackRepository:
    @staticmethod
    def create_feedback(
        *,
        report_id: str,
        report_version_number: int | None,
        section_type: str,
        section_identifier: str | None,
        threat_name: str | None,
        original_content: str,
        corrected_content: str,
        correction_reason: str | None,
        error_type: str,
        actor: AuthenticatedUser,
    ) -> dict:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO llm_feedback_memory (
                        report_id,
                        report_version_number,
                        section_type,
                        section_identifier,
                        threat_name,
                        original_content,
                        corrected_content,
                        correction_reason,
                        error_type,
                        created_by,
                        created_by_username,
                        created_by_email
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING *
                    """,
                    (
                        report_id,
                        report_version_number,
                        section_type,
                        section_identifier,
                        threat_name,
                        original_content,
                        corrected_content,
                        correction_reason,
                        error_type,
                        str(actor.user_id),
                        actor.display_name,
                        actor.email,
                    ),
                )
                row = cur.fetchone()
                conn.commit()
                return row
        finally:
            conn.close()

    @staticmethod
    def list_feedback_for_report(report_id: str) -> list[dict]:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT *
                    FROM llm_feedback_memory
                    WHERE report_id = %s
                    ORDER BY created_at DESC, id DESC
                    """,
                    (report_id,),
                )
                return cur.fetchall()
        finally:
            conn.close()

    @staticmethod
    def list_feedback_for_prompt(
        *,
        section_types: Iterable[str],
        threat_names: Iterable[str] | None = None,
        limit: int = 8,
    ) -> list[dict]:
        normalized_section_types = [
            str(item or "").strip()
            for item in section_types
            if str(item or "").strip()
        ]
        if not normalized_section_types:
            return []

        normalized_threat_names = [
            str(item or "").strip()
            for item in (threat_names or [])
            if str(item or "").strip()
        ]

        conn = get_connection()
        try:
            with conn.cursor() as cur:
                if normalized_threat_names:
                    cur.execute(
                        """
                        SELECT *
                        FROM llm_feedback_memory
                        WHERE section_type = ANY(%s)
                          AND (
                              threat_name IS NULL
                              OR threat_name = ''
                              OR LOWER(threat_name) = ANY(%s)
                          )
                        ORDER BY created_at DESC, id DESC
                        LIMIT %s
                        """,
                        (
                            normalized_section_types,
                            [item.lower() for item in normalized_threat_names],
                            limit,
                        ),
                    )
                else:
                    cur.execute(
                        """
                        SELECT *
                        FROM llm_feedback_memory
                        WHERE section_type = ANY(%s)
                        ORDER BY created_at DESC, id DESC
                        LIMIT %s
                        """,
                        (normalized_section_types, limit),
                    )
                return cur.fetchall()
        finally:
            conn.close()

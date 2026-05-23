from __future__ import annotations

from typing import Iterable

from app.core.auth import AuthenticatedUser
from app.core.database import get_connection
from app.schemas.report import ManagerReviewFeedbackItem


class ManagerReviewFeedbackRepository:
    @staticmethod
    def create_feedback_entries(
        *,
        report_id: str,
        report_version_number: int | None,
        feedback_items: list[ManagerReviewFeedbackItem],
        actor: AuthenticatedUser,
    ) -> list[dict]:
        if not feedback_items:
            return []

        conn = get_connection()
        try:
            with conn.cursor() as cur:
                created_rows: list[dict] = []
                for item in feedback_items:
                    cur.execute(
                        """
                        INSERT INTO manager_review_feedback (
                            report_id,
                            report_version_number,
                            decision_type,
                            reason_code,
                            severity,
                            section_type,
                            section_identifier,
                            comment,
                            created_by,
                            created_by_username,
                            created_by_email
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        RETURNING *
                        """,
                        (
                            report_id,
                            report_version_number,
                            item.decision_type.strip().upper(),
                            item.reason_code.strip().upper(),
                            (item.severity or "").strip().upper() or None,
                            (item.section_type or "GLOBAL").strip().upper(),
                            (item.section_identifier or "").strip() or None,
                            (item.comment or "").strip() or None,
                            str(actor.user_id),
                            actor.display_name,
                            actor.email,
                        ),
                    )
                    created_rows.append(cur.fetchone())
                conn.commit()
                return created_rows
        finally:
            conn.close()

    @staticmethod
    def get_feedback_for_report(report_id: str) -> list[dict]:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT *
                    FROM manager_review_feedback
                    WHERE report_id = %s
                    ORDER BY created_at DESC, id DESC
                    """,
                    (report_id,),
                )
                return cur.fetchall()
        finally:
            conn.close()

    @staticmethod
    def get_feedback_for_reports(report_ids: Iterable[str]) -> dict[str, list[dict]]:
        normalized_ids = list(report_ids)
        if not normalized_ids:
            return {}

        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT *
                    FROM manager_review_feedback
                    WHERE report_id::text = ANY(%s)
                    ORDER BY created_at DESC, id DESC
                    """,
                    (normalized_ids,),
                )
                rows = cur.fetchall()
        finally:
            conn.close()

        grouped: dict[str, list[dict]] = {}
        for row in rows:
            grouped.setdefault(str(row["report_id"]), []).append(row)
        return grouped

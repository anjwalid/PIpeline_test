from __future__ import annotations

import json
from typing import Iterable

from app.core.auth import AuthenticatedUser
from app.core.database import get_connection

REPORT_STATUS_HISTORY_INSERT_SQL = """
INSERT INTO report_status_history (
    report_id,
    old_status,
    new_status,
    changed_by,
    changed_by_username,
    changed_by_email,
    comment
)
VALUES (%s, %s, %s, %s, %s, %s, %s)
"""


class ReportRepository:
    @staticmethod
    def ensure_report_results_schema() -> None:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS report_results (
                        report_id UUID PRIMARY KEY
                            REFERENCES reports(id)
                            ON DELETE CASCADE,
                        app_name TEXT NOT NULL,
                        developer_name TEXT NOT NULL,
                        application_description TEXT NOT NULL,
                        selected_threats JSONB NOT NULL,
                        dfd_image_path TEXT,
                        dfd_reference TEXT DEFAULT 'DFD-01',
                        version_number INTEGER NOT NULL DEFAULT 1,
                        created_by UUID,
                        created_by_username TEXT,
                        created_by_email TEXT,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    )
                    """
                )
                cur.execute(
                    """
                    ALTER TABLE report_results
                    ADD COLUMN IF NOT EXISTS dfd_reference TEXT DEFAULT 'DFD-01'
                    """
                )
                cur.execute(
                    """
                    ALTER TABLE report_results
                    ADD COLUMN IF NOT EXISTS version_number INTEGER NOT NULL DEFAULT 1
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS report_result_versions (
                        id BIGSERIAL PRIMARY KEY,
                        report_id UUID NOT NULL
                            REFERENCES reports(id)
                            ON DELETE CASCADE,
                        version_number INTEGER NOT NULL,
                        version_label TEXT NOT NULL,
                        app_name TEXT NOT NULL,
                        developer_name TEXT NOT NULL,
                        application_description TEXT NOT NULL,
                        selected_threats JSONB NOT NULL,
                        dfd_image_path TEXT,
                        dfd_reference TEXT,
                        created_by UUID,
                        created_by_username TEXT,
                        created_by_email TEXT,
                        change_reason TEXT,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        CONSTRAINT uq_report_result_versions UNIQUE (report_id, version_number)
                    )
                    """
                )
                conn.commit()
        finally:
            conn.close()

    @staticmethod
    def create_report(
        *,
        title: str,
        description: str | None,
        file_name: str,
        file_type: str,
        file_size: int | None,
        minio_bucket: str,
        minio_object_key: str,
        generated_by: AuthenticatedUser,
        status: str = "PENDING_MANAGER_VALIDATION",
    ) -> dict:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO reports (
                        title,
                        description,
                        file_name,
                        file_type,
                        file_size,
                        minio_bucket,
                        minio_object_key,
                        status,
                        generated_by,
                        generated_by_username,
                        generated_by_email
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING *
                    """,
                    (
                        title,
                        description,
                        file_name,
                        file_type,
                        file_size,
                        minio_bucket,
                        minio_object_key,
                        status,
                        str(generated_by.user_id),
                        generated_by.display_name,
                        generated_by.email,
                    ),
                )
                report = cur.fetchone()

                cur.execute(
                    REPORT_STATUS_HISTORY_INSERT_SQL,
                    (
                        report["id"],
                        None,
                        status,
                        str(generated_by.user_id),
                        generated_by.display_name,
                        generated_by.email,
                        "Rapport genere et soumis au manager.",
                    ),
                )
                conn.commit()
                return report
        finally:
            conn.close()

    @staticmethod
    def upsert_report_results(
        *,
        report_id: str,
        app_name: str,
        developer_name: str,
        application_description: str,
        selected_threats: list[dict],
        dfd_image_path: str | None,
        dfd_reference: str | None,
        version_number: int,
        generated_by: AuthenticatedUser,
    ) -> dict:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO report_results (
                        report_id,
                        app_name,
                        developer_name,
                        application_description,
                        selected_threats,
                        dfd_image_path,
                        dfd_reference,
                        version_number,
                        created_by,
                        created_by_username,
                        created_by_email
                    )
                    VALUES (%s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (report_id)
                    DO UPDATE SET
                        app_name = EXCLUDED.app_name,
                        developer_name = EXCLUDED.developer_name,
                        application_description = EXCLUDED.application_description,
                        selected_threats = EXCLUDED.selected_threats,
                        dfd_image_path = EXCLUDED.dfd_image_path,
                        dfd_reference = EXCLUDED.dfd_reference,
                        version_number = EXCLUDED.version_number,
                        created_by = EXCLUDED.created_by,
                        created_by_username = EXCLUDED.created_by_username,
                        created_by_email = EXCLUDED.created_by_email,
                        updated_at = CURRENT_TIMESTAMP
                    RETURNING *
                    """,
                    (
                        report_id,
                        app_name,
                        developer_name,
                        application_description,
                        json.dumps(selected_threats, ensure_ascii=False),
                        dfd_image_path,
                        dfd_reference,
                        version_number,
                        str(generated_by.user_id),
                        generated_by.display_name,
                        generated_by.email,
                    ),
                )
                row = cur.fetchone()
                conn.commit()
                return row
        finally:
            conn.close()

    @staticmethod
    def get_report_results(report_id: str) -> dict | None:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT *
                    FROM report_results
                    WHERE report_id = %s
                    """,
                    (report_id,),
                )
                return cur.fetchone()
        finally:
            conn.close()

    @staticmethod
    def get_report_results_for_reports(report_ids: Iterable[str]) -> dict[str, dict]:
        report_ids = list(report_ids)
        if not report_ids:
            return {}

        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT *
                    FROM report_results
                    WHERE report_id::text = ANY(%s)
                    """,
                    (report_ids,),
                )
                rows = cur.fetchall()
        finally:
            conn.close()

        return {str(row["report_id"]): row for row in rows}

    @staticmethod
    def update_report_results(
        *,
        report_id: str,
        app_name: str,
        developer_name: str,
        application_description: str,
        selected_threats: list[dict],
        dfd_image_path: str | None,
        dfd_reference: str | None,
        version_number: int,
    ) -> dict | None:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE report_results
                    SET app_name = %s,
                        developer_name = %s,
                        application_description = %s,
                        selected_threats = %s::jsonb,
                        dfd_image_path = %s,
                        dfd_reference = %s,
                        version_number = %s,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE report_id = %s
                    RETURNING *
                    """,
                    (
                        app_name,
                        developer_name,
                        application_description,
                        json.dumps(selected_threats, ensure_ascii=False),
                        dfd_image_path,
                        dfd_reference,
                        version_number,
                        report_id,
                    ),
                )
                row = cur.fetchone()
                conn.commit()
                return row
        finally:
            conn.close()

    @staticmethod
    def insert_report_result_version(
        *,
        report_id: str,
        version_number: int,
        app_name: str,
        developer_name: str,
        application_description: str,
        selected_threats: list[dict],
        dfd_image_path: str | None,
        dfd_reference: str | None,
        actor: AuthenticatedUser,
        change_reason: str | None,
    ) -> None:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO report_result_versions (
                        report_id,
                        version_number,
                        version_label,
                        app_name,
                        developer_name,
                        application_description,
                        selected_threats,
                        dfd_image_path,
                        dfd_reference,
                        created_by,
                        created_by_username,
                        created_by_email,
                        change_reason
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (report_id, version_number) DO NOTHING
                    """,
                    (
                        report_id,
                        version_number,
                        f"v{version_number}",
                        app_name,
                        developer_name,
                        application_description,
                        json.dumps(selected_threats, ensure_ascii=False),
                        dfd_image_path,
                        dfd_reference,
                        str(actor.user_id),
                        actor.display_name,
                        actor.email,
                        change_reason,
                    ),
                )
                conn.commit()
        finally:
            conn.close()

    @staticmethod
    def update_report_after_regeneration(
        *,
        report_id: str,
        app_name: str,
        description: str,
        file_name: str,
        file_size: int,
        minio_bucket: str,
        minio_object_key: str,
        new_status: str,
        actor: AuthenticatedUser,
        comment: str,
    ) -> dict | None:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT status
                    FROM reports
                    WHERE id = %s
                    """,
                    (report_id,),
                )
                current = cur.fetchone()
                if not current:
                    return None

                old_status = current["status"]

                cur.execute(
                    """
                    UPDATE reports
                    SET title = %s,
                        description = %s,
                        file_name = %s,
                        file_size = %s,
                        minio_bucket = %s,
                        minio_object_key = %s,
                        status = %s,
                        generated_at = CURRENT_TIMESTAMP,
                        validated_by = NULL,
                        validated_by_username = NULL,
                        validated_by_email = NULL,
                        validated_at = NULL,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = %s
                    RETURNING *
                    """,
                    (
                        app_name,
                        description,
                        file_name,
                        file_size,
                        minio_bucket,
                        minio_object_key,
                        new_status,
                        report_id,
                    ),
                )
                updated = cur.fetchone()

                cur.execute(
                    REPORT_STATUS_HISTORY_INSERT_SQL,
                    (
                        report_id,
                        old_status,
                        new_status,
                        str(actor.user_id),
                        actor.display_name,
                        actor.email,
                        comment,
                    ),
                )

                conn.commit()
                return updated
        finally:
            conn.close()

    @staticmethod
    def get_report_by_id(report_id: str) -> dict | None:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT *
                    FROM reports
                    WHERE id = %s
                    """,
                    (report_id,),
                )
                return cur.fetchone()
        finally:
            conn.close()

    @staticmethod
    def list_reports(*, generated_by: str | None = None) -> list[dict]:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                if generated_by:
                    cur.execute(
                        """
                        SELECT *
                        FROM reports
                        WHERE generated_by = %s
                        ORDER BY generated_at DESC, created_at DESC
                        """,
                        (generated_by,),
                    )
                else:
                    cur.execute(
                        """
                        SELECT *
                        FROM reports
                        ORDER BY generated_at DESC, created_at DESC
                        """
                    )
                return cur.fetchall()
        finally:
            conn.close()

    @staticmethod
    def get_annotations(report_id: str) -> list[dict]:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT *
                    FROM report_annotations
                    WHERE report_id = %s
                    ORDER BY created_at DESC
                    """,
                    (report_id,),
                )
                return cur.fetchall()
        finally:
            conn.close()

    @staticmethod
    def get_status_history(report_id: str) -> list[dict]:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT *
                    FROM report_status_history
                    WHERE report_id = %s
                    ORDER BY changed_at DESC
                    """,
                    (report_id,),
                )
                return cur.fetchall()
        finally:
            conn.close()

    @staticmethod
    def get_annotations_for_reports(report_ids: Iterable[str]) -> dict[str, list[dict]]:
        report_ids = list(report_ids)
        if not report_ids:
            return {}

        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT *
                    FROM report_annotations
                    WHERE report_id::text = ANY(%s)
                    ORDER BY created_at DESC
                    """,
                    (report_ids,),
                )
                rows = cur.fetchall()
        finally:
            conn.close()

        grouped: dict[str, list[dict]] = {}
        for row in rows:
            grouped.setdefault(str(row["report_id"]), []).append(row)
        return grouped

    @staticmethod
    def get_status_history_for_reports(report_ids: Iterable[str]) -> dict[str, list[dict]]:
        report_ids = list(report_ids)
        if not report_ids:
            return {}

        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT *
                    FROM report_status_history
                    WHERE report_id::text = ANY(%s)
                    ORDER BY changed_at DESC
                    """,
                    (report_ids,),
                )
                rows = cur.fetchall()
        finally:
            conn.close()

        grouped: dict[str, list[dict]] = {}
        for row in rows:
            grouped.setdefault(str(row["report_id"]), []).append(row)
        return grouped

    @staticmethod
    def update_report_status(
        *,
        report_id: str,
        new_status: str,
        actor: AuthenticatedUser,
        comment: str | None,
    ) -> dict | None:
        conn = get_connection()
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT status
                    FROM reports
                    WHERE id = %s
                    """,
                    (report_id,),
                )
                current = cur.fetchone()
                if not current:
                    return None

                old_status = current["status"]

                cur.execute(
                    """
                    UPDATE reports
                    SET status = %s,
                        validated_by = %s,
                        validated_by_username = %s,
                        validated_by_email = %s,
                        validated_at = CURRENT_TIMESTAMP,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = %s
                    RETURNING *
                    """,
                    (
                        new_status,
                        str(actor.user_id),
                        actor.display_name,
                        actor.email,
                        report_id,
                    ),
                )
                updated = cur.fetchone()

                cur.execute(
                    REPORT_STATUS_HISTORY_INSERT_SQL,
                    (
                        report_id,
                        old_status,
                        new_status,
                        str(actor.user_id),
                        actor.display_name,
                        actor.email,
                        comment,
                    ),
                )

                if comment and comment.strip():
                    cur.execute(
                        """
                        INSERT INTO report_annotations (
                            report_id,
                            annotation,
                            created_by,
                            created_by_username,
                            created_by_email
                        )
                        VALUES (%s, %s, %s, %s, %s)
                        """,
                        (
                            report_id,
                            comment.strip(),
                            str(actor.user_id),
                            actor.display_name,
                            actor.email,
                        ),
                    )

                conn.commit()
                return updated
        finally:
            conn.close()

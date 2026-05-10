from __future__ import annotations

from datetime import datetime
import logging
from pathlib import Path
from collections import Counter

from fastapi import HTTPException, status

from app.core.auth import AuthenticatedUser
from app.core.exceptions import AnalysisStepError
from app.repositories.report_repository import ReportRepository
from app.schemas.report import (
    EditableThreat,
    ManagerDashboardMetricsResponse,
    ReportsByMonthEntry,
    RiskyApplicationEntry,
    ReportAnnotationResponse,
    ThreatFrequencyEntry,
    ReportResultsResponse,
    ReportResponse,
    ReportStatusHistoryResponse,
)
from app.services.minio_service import MinioService
from app.services.report_service import build_safe_slug, generate_report_pdf

logger = logging.getLogger(__name__)


class ReportManagementService:
    DOWNLOAD_PATH_TEMPLATE = "/reports/{report_id}/download"
    ALLOWED_MANAGER_STATUSES = {"APPROVED", "REJECTED", "NEEDS_CHANGES"}
    IMMUTABLE_REPORT_STATUSES = {"APPROVED"}
    REPORT_NOT_FOUND = "Rapport introuvable."
    REPORT_RESULTS_NOT_FOUND = (
        "Resultats de rapport introuvables. Regenerer le rapport depuis une nouvelle analyse."
    )
    DEFAULT_DESCRIPTION = "Description indisponible."
    PDF_CONTENT_TYPE = "application/pdf"
    DEFAULT_DFD_REFERENCE = "DFD-01"
    ALLOWED_DFD_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}

    @staticmethod
    def ensure_schema() -> None:
        ReportRepository.ensure_report_results_schema()

    @staticmethod
    def _normalize_text_list(values: list[str] | None) -> list[str]:
        normalized: list[str] = []
        for value in values or []:
            text = str(value or "").strip()
            if text:
                normalized.append(text)
        return normalized

    @staticmethod
    def _format_application_version(version_number: int | None) -> str:
        normalized = version_number or 1
        return f"v{normalized}"

    @staticmethod
    def _normalize_dfd_reference(value: str | None) -> str:
        text = str(value or "").strip()
        return text or ReportManagementService.DEFAULT_DFD_REFERENCE

    @staticmethod
    def _normalize_selected_threats(selected_threats: list[EditableThreat] | list[dict]) -> list[dict]:
        normalized: list[dict] = []
        for raw in selected_threats:
            if isinstance(raw, EditableThreat):
                threat_name = raw.name.strip()
                description = (raw.description or "").strip()
                attack_scenarios = ReportManagementService._normalize_text_list(raw.attack_scenarios)
                mitigations = ReportManagementService._normalize_text_list(raw.mitigations)
            else:
                threat_name = str(raw.get("name") or "").strip()
                description = str(raw.get("description") or "").strip()
                attack_scenarios = ReportManagementService._normalize_text_list(
                    raw.get("attack_scenarios")
                )
                mitigations = ReportManagementService._normalize_text_list(raw.get("mitigations"))

            if not threat_name:
                continue

            normalized.append(
                {
                    "name": threat_name,
                    "description": description,
                    "attack_scenarios": attack_scenarios,
                    "mitigations": mitigations,
                }
            )
        return normalized

    @staticmethod
    def _results_payload_changed(
        current_row: dict,
        *,
        app_name: str,
        developer_name: str,
        application_description: str,
        selected_threats: list[dict],
        dfd_image_path: str | None,
        dfd_reference: str,
    ) -> bool:
        return any(
            [
                (current_row.get("app_name") or "") != app_name,
                (current_row.get("developer_name") or "") != developer_name,
                (current_row.get("application_description") or "") != application_description,
                (current_row.get("selected_threats") or []) != selected_threats,
                (current_row.get("dfd_image_path") or None) != dfd_image_path,
                ReportManagementService._normalize_dfd_reference(current_row.get("dfd_reference"))
                != dfd_reference,
            ]
        )

    @staticmethod
    def _serialize_report_results(report_results_row: dict) -> ReportResultsResponse:
        selected_threats = report_results_row.get("selected_threats") or []
        normalized = ReportManagementService._normalize_selected_threats(selected_threats)

        return ReportResultsResponse(
            report_id=str(report_results_row["report_id"]),
            app_name=report_results_row["app_name"],
            developer_name=report_results_row["developer_name"],
            application_description=report_results_row["application_description"],
            application_version=ReportManagementService._format_application_version(
                report_results_row.get("version_number")
            ),
            selected_threats=[EditableThreat(**item) for item in normalized],
            dfd_image_path=report_results_row.get("dfd_image_path"),
            dfd_reference=ReportManagementService._normalize_dfd_reference(
                report_results_row.get("dfd_reference")
            ),
            updated_at=report_results_row.get("updated_at"),
        )

    @staticmethod
    def create_report_results_record(
        *,
        report_id: str,
        app_name: str,
        developer_name: str,
        application_description: str,
        selected_threats: list[dict],
        dfd_image_path: str | None,
        dfd_reference: str | None,
        generated_by: AuthenticatedUser,
    ) -> ReportResultsResponse:
        normalized_threats = ReportManagementService._normalize_selected_threats(selected_threats)
        normalized_dfd_reference = ReportManagementService._normalize_dfd_reference(dfd_reference)
        row = ReportRepository.upsert_report_results(
            report_id=report_id,
            app_name=(app_name or "").strip() or "Application",
            developer_name=(developer_name or "").strip() or generated_by.display_name,
            application_description=(application_description or "").strip()
            or ReportManagementService.DEFAULT_DESCRIPTION,
            selected_threats=normalized_threats,
            dfd_image_path=(dfd_image_path or "").strip() or None,
            dfd_reference=normalized_dfd_reference,
            version_number=1,
            generated_by=generated_by,
        )
        ReportRepository.insert_report_result_version(
            report_id=report_id,
            version_number=1,
            app_name=row["app_name"],
            developer_name=row["developer_name"],
            application_description=row["application_description"],
            selected_threats=normalized_threats,
            dfd_image_path=row.get("dfd_image_path"),
            dfd_reference=normalized_dfd_reference,
            actor=generated_by,
            change_reason="Version initiale generee automatiquement.",
        )
        return ReportManagementService._serialize_report_results(row)

    @staticmethod
    def get_report_results(report_id: str) -> ReportResultsResponse:
        report_row = ReportRepository.get_report_by_id(report_id)
        if not report_row:
            raise HTTPException(status_code=404, detail=ReportManagementService.REPORT_NOT_FOUND)

        row = ReportRepository.get_report_results(report_id)
        if not row:
            raise HTTPException(
                status_code=404,
                detail=ReportManagementService.REPORT_RESULTS_NOT_FOUND,
            )

        return ReportManagementService._serialize_report_results(row)

    @staticmethod
    def update_report_results(
        *,
        report_id: str,
        app_name: str,
        developer_name: str,
        application_description: str,
        selected_threats: list[EditableThreat],
        dfd_image_path: str | None,
        dfd_reference: str | None,
        actor: AuthenticatedUser,
    ) -> ReportResultsResponse:
        report_row = ReportRepository.get_report_by_id(report_id)
        if not report_row:
            raise HTTPException(status_code=404, detail=ReportManagementService.REPORT_NOT_FOUND)
        if report_row["status"] in ReportManagementService.IMMUTABLE_REPORT_STATUSES:
            raise HTTPException(
                status_code=400,
                detail="Le rapport est valide. Aucune modification n'est autorisee.",
            )

        normalized = ReportManagementService._normalize_selected_threats(selected_threats)
        if not normalized:
            raise HTTPException(
                status_code=400,
                detail="Le rapport doit contenir au moins une menace.",
            )

        existing = ReportRepository.get_report_results(report_id)
        if not existing:
            raise HTTPException(
                status_code=404,
                detail=ReportManagementService.REPORT_RESULTS_NOT_FOUND,
            )

        next_app_name = (app_name or "").strip() or report_row["title"]
        next_developer_name = (developer_name or "").strip() or "Non renseigne"
        next_description = (application_description or "").strip() or ReportManagementService.DEFAULT_DESCRIPTION
        next_dfd_image_path = (dfd_image_path or "").strip() or None
        next_dfd_reference = ReportManagementService._normalize_dfd_reference(dfd_reference)

        if not ReportManagementService._results_payload_changed(
            existing,
            app_name=next_app_name,
            developer_name=next_developer_name,
            application_description=next_description,
            selected_threats=normalized,
            dfd_image_path=next_dfd_image_path,
            dfd_reference=next_dfd_reference,
        ):
            return ReportManagementService._serialize_report_results(existing)

        next_version_number = int(existing.get("version_number") or 1) + 1
        updated = ReportRepository.update_report_results(
            report_id=report_id,
            app_name=next_app_name,
            developer_name=next_developer_name,
            application_description=next_description,
            selected_threats=normalized,
            dfd_image_path=next_dfd_image_path,
            dfd_reference=next_dfd_reference,
            version_number=next_version_number,
        )
        if not updated:
            raise HTTPException(
                status_code=404,
                detail=ReportManagementService.REPORT_RESULTS_NOT_FOUND,
            )

        ReportRepository.insert_report_result_version(
            report_id=report_id,
            version_number=next_version_number,
            app_name=next_app_name,
            developer_name=next_developer_name,
            application_description=next_description,
            selected_threats=normalized,
            dfd_image_path=next_dfd_image_path,
            dfd_reference=next_dfd_reference,
            actor=actor,
            change_reason="Modification manuelle des resultats du rapport.",
        )
        return ReportManagementService._serialize_report_results(updated)

    @staticmethod
    def regenerate_report(report_id: str, actor: AuthenticatedUser) -> ReportResponse:
        report_row = ReportRepository.get_report_by_id(report_id)
        if not report_row:
            raise HTTPException(status_code=404, detail=ReportManagementService.REPORT_NOT_FOUND)
        if report_row["status"] in ReportManagementService.IMMUTABLE_REPORT_STATUSES:
            raise HTTPException(
                status_code=400,
                detail="Le rapport est valide. Aucune regeneration n'est autorisee.",
            )

        editable_results = ReportRepository.get_report_results(report_id)
        if not editable_results:
            raise HTTPException(
                status_code=404,
                detail=ReportManagementService.REPORT_RESULTS_NOT_FOUND,
            )

        selected_threats = ReportManagementService._normalize_selected_threats(
            editable_results.get("selected_threats") or []
        )
        if not selected_threats:
            raise HTTPException(
                status_code=400,
                detail="Impossible de regenerer un rapport sans menace.",
            )

        app_name = (editable_results.get("app_name") or report_row["title"] or "Application").strip()
        developer_name = (
            editable_results.get("developer_name")
            or actor.display_name
            or actor.username
            or "Non renseigne"
        ).strip()
        description = (
            editable_results.get("application_description")
            or report_row.get("description")
            or ReportManagementService.DEFAULT_DESCRIPTION
        ).strip()

        regen_stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        report_file_name = (
            f"rapport-{build_safe_slug(developer_name)}-"
            f"{build_safe_slug(app_name)}-"
            f"regen-{regen_stamp}.pdf"
        )

        dfd_image_path = (editable_results.get("dfd_image_path") or "").strip() or None
        dfd_reference = ReportManagementService._normalize_dfd_reference(
            editable_results.get("dfd_reference")
        )
        application_version = ReportManagementService._format_application_version(
            editable_results.get("version_number")
        )
        pdf_path = generate_report_pdf(
            app_name=app_name,
            developer_name=developer_name,
            generated_description=description,
            selected_threats=selected_threats,
            dfd_image_path=dfd_image_path,
            dfd_reference=dfd_reference,
            application_version=application_version,
            report_file_name=report_file_name,
        )

        object_key = ReportManagementService._build_object_key(actor, report_file_name)
        try:
            upload_result = MinioService.upload_file(
                pdf_path,
                object_key=object_key,
                content_type=ReportManagementService.PDF_CONTENT_TYPE,
            )
        except Exception as exc:
            logger.warning("MinIO indisponible pour regeneration, fallback local: %s", exc)
            upload_result = {
                "bucket": MinioService.LOCAL_BUCKET,
                "object_key": str(Path(pdf_path).resolve()),
                "file_size": Path(pdf_path).stat().st_size,
            }

        target_status = (
            "IN_PROGRESS"
            if report_row["status"] == "REJECTED"
            else "PENDING_MANAGER_VALIDATION"
        )
        updated_report = ReportRepository.update_report_after_regeneration(
            report_id=report_id,
            app_name=app_name,
            description=description,
            file_name=report_file_name,
            file_size=upload_result["file_size"],
            minio_bucket=upload_result["bucket"],
            minio_object_key=upload_result["object_key"],
            new_status=target_status,
            actor=actor,
            comment=(
                "Rapport regenere apres modification des resultats."
                if report_row["status"] != "REJECTED"
                else "Rapport regenere apres rejet, statut repositionne a en cours."
            ),
        )
        if not updated_report:
            raise HTTPException(status_code=404, detail=ReportManagementService.REPORT_NOT_FOUND)

        ReportRepository.update_report_results(
            report_id=report_id,
            app_name=app_name,
            developer_name=developer_name,
            application_description=description,
            selected_threats=selected_threats,
            dfd_image_path=dfd_image_path,
            dfd_reference=dfd_reference,
            version_number=int(editable_results.get("version_number") or 1),
        )

        return ReportManagementService.get_report(report_id)

    @staticmethod
    def _build_summary(description: str | None) -> str:
        text = (description or "").strip()
        if not text:
            return "Rapport genere sans resume disponible."
        return text[:200] + ("..." if len(text) > 200 else "")

    @staticmethod
    def _serialize_report(
        report_row: dict,
        annotations_map: dict[str, list[dict]] | None = None,
        history_map: dict[str, list[dict]] | None = None,
    ) -> ReportResponse:
        report_id = str(report_row["id"])
        annotations = annotations_map.get(report_id, []) if annotations_map else []
        history = history_map.get(report_id, []) if history_map else []

        return ReportResponse(
            id=report_id,
            title=report_row["title"],
            app_name=report_row["title"],
            description=report_row.get("description"),
            summary=ReportManagementService._build_summary(report_row.get("description")),
            file_name=report_row["file_name"],
            file_type=report_row["file_type"],
            file_size=report_row.get("file_size"),
            status=report_row["status"],
            report_url=ReportManagementService.DOWNLOAD_PATH_TEMPLATE.format(report_id=report_id),
            generated_by=str(report_row["generated_by"]),
            generated_by_username=report_row.get("generated_by_username"),
            generated_by_email=report_row.get("generated_by_email"),
            generated_at=report_row["generated_at"],
            validated_by=str(report_row["validated_by"]) if report_row.get("validated_by") else None,
            validated_by_username=report_row.get("validated_by_username"),
            validated_by_email=report_row.get("validated_by_email"),
            validated_at=report_row.get("validated_at"),
            annotations=[
                ReportAnnotationResponse(
                    id=str(annotation["id"]),
                    annotation=annotation["annotation"],
                    created_by_username=annotation.get("created_by_username"),
                    created_by_email=annotation.get("created_by_email"),
                    created_at=annotation["created_at"],
                )
                for annotation in annotations
            ],
            status_history=[
                ReportStatusHistoryResponse(
                    id=str(entry["id"]),
                    old_status=entry.get("old_status"),
                    new_status=entry["new_status"],
                    changed_by_username=entry.get("changed_by_username"),
                    changed_by_email=entry.get("changed_by_email"),
                    comment=entry.get("comment"),
                    changed_at=entry["changed_at"],
                )
                for entry in history
            ],
        )

    @staticmethod
    def _build_object_key(user: AuthenticatedUser, file_name: str) -> str:
        return f"reports/{user.user_id}/{file_name}"

    @staticmethod
    def save_uploaded_dfd(
        *,
        report_id: str,
        original_file_name: str,
        file_stream,
    ) -> dict:
        report_row = ReportRepository.get_report_by_id(report_id)
        if not report_row:
            raise HTTPException(status_code=404, detail=ReportManagementService.REPORT_NOT_FOUND)
        if report_row["status"] in ReportManagementService.IMMUTABLE_REPORT_STATUSES:
            raise HTTPException(
                status_code=400,
                detail="Le rapport est valide. Aucune modification n'est autorisee.",
            )

        extension = Path(original_file_name or "").suffix.lower()
        if extension not in ReportManagementService.ALLOWED_DFD_EXTENSIONS:
            raise HTTPException(
                status_code=400,
                detail="Format d'image DFD non supporte. Utilisez PNG, JPG, JPEG ou WEBP.",
            )

        file_bytes = file_stream.read()
        if not file_bytes:
            raise HTTPException(status_code=400, detail="Le fichier DFD est vide.")

        object_key = (
            f"reports/{report_id}/dfd/"
            f"report-{report_id}-{int(datetime.now().timestamp())}{extension}"
        )
        upload_result = MinioService.upload_bytes(
            data=file_bytes,
            object_key=object_key,
            content_type=f"image/{extension.removeprefix('.') if extension != '.jpg' else 'jpeg'}",
        )

        return {
            "dfd_image_path": MinioService.build_minio_uri(
                upload_result["bucket"],
                upload_result["object_key"],
            ),
            "original_file_name": original_file_name,
        }

    @staticmethod
    def create_report_record(
        *,
        app_name: str,
        description: str,
        pdf_path: str,
        file_name: str,
        generated_by: AuthenticatedUser,
    ) -> ReportResponse:
        object_key = ReportManagementService._build_object_key(generated_by, file_name)
        try:
            upload_result = MinioService.upload_file(
                pdf_path,
                object_key=object_key,
                content_type=ReportManagementService.PDF_CONTENT_TYPE,
            )
            logger.info(
                "Rapport stocke dans MinIO: app=%s bucket=%s object_key=%s",
                app_name,
                upload_result["bucket"],
                upload_result["object_key"],
            )
        except Exception as exc:
            logger.warning("MinIO indisponible, fallback local active: %s", exc)
            upload_result = {
                "bucket": MinioService.LOCAL_BUCKET,
                "object_key": str(Path(pdf_path).resolve()),
                "file_size": Path(pdf_path).stat().st_size,
            }

        try:
            report_row = ReportRepository.create_report(
                title=app_name,
                description=description,
                file_name=file_name,
                file_type=ReportManagementService.PDF_CONTENT_TYPE,
                file_size=upload_result["file_size"],
                minio_bucket=upload_result["bucket"],
                minio_object_key=upload_result["object_key"],
                generated_by=generated_by,
            )
        except Exception as exc:
            logger.exception("Echec insertion metadata rapport en base")
            raise AnalysisStepError(
                "database_report_metadata",
                "Impossible d'enregistrer les metadonnees du rapport en base.",
                cause=exc,
            ) from exc
        return ReportManagementService._serialize_report(report_row)

    @staticmethod
    def list_my_reports(user: AuthenticatedUser) -> list[ReportResponse]:
        rows = ReportRepository.list_reports(generated_by=str(user.user_id))
        report_ids = [str(row["id"]) for row in rows]
        annotations_map = ReportRepository.get_annotations_for_reports(report_ids)
        history_map = ReportRepository.get_status_history_for_reports(report_ids)
        return [
            ReportManagementService._serialize_report(row, annotations_map, history_map)
            for row in rows
        ]

    @staticmethod
    def list_all_reports() -> list[ReportResponse]:
        rows = ReportRepository.list_reports()
        report_ids = [str(row["id"]) for row in rows]
        annotations_map = ReportRepository.get_annotations_for_reports(report_ids)
        history_map = ReportRepository.get_status_history_for_reports(report_ids)
        return [
            ReportManagementService._serialize_report(row, annotations_map, history_map)
            for row in rows
        ]

    @staticmethod
    def get_report(report_id: str) -> ReportResponse:
        row = ReportRepository.get_report_by_id(report_id)
        if not row:
            raise HTTPException(status_code=404, detail=ReportManagementService.REPORT_NOT_FOUND)

        annotations_map = {report_id: ReportRepository.get_annotations(report_id)}
        history_map = {report_id: ReportRepository.get_status_history(report_id)}
        return ReportManagementService._serialize_report(row, annotations_map, history_map)

    @staticmethod
    def get_download_payload(report_id: str) -> dict:
        report_row = ReportRepository.get_report_by_id(report_id)
        if not report_row:
            raise HTTPException(status_code=404, detail=ReportManagementService.REPORT_NOT_FOUND)

        if report_row["minio_bucket"] == MinioService.LOCAL_BUCKET:
            local_path = Path(report_row["minio_object_key"])
            if not local_path.exists():
                raise HTTPException(status_code=404, detail="Fichier local du rapport introuvable.")
            return {
                "report": report_row,
                "local_path": str(local_path),
                "object_response": None,
            }

        try:
            object_response = MinioService.get_object(
                report_row["minio_bucket"],
                report_row["minio_object_key"],
            )
        except Exception as exc:
            logger.exception(
                "Echec recuperation rapport depuis le stockage: report_id=%s bucket=%s object_key=%s",
                report_id,
                report_row["minio_bucket"],
                report_row["minio_object_key"],
            )
            raise HTTPException(
                status_code=500,
                detail={
                    "error_type": "REPORT_DOWNLOAD_ERROR",
                    "step": "report_storage_read",
                    "message": "Impossible de recuperer le rapport depuis le stockage.",
                    "cause": str(exc),
                },
            ) from exc

        return {
            "report": report_row,
            "local_path": None,
            "object_response": object_response,
        }

    @staticmethod
    def update_report_status(
        *,
        report_id: str,
        new_status: str,
        actor: AuthenticatedUser,
        comment: str | None,
    ) -> ReportResponse:
        normalized_status = (new_status or "").strip().upper()
        if normalized_status not in ReportManagementService.ALLOWED_MANAGER_STATUSES:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Statut de validation non supporte.",
            )

        updated = ReportRepository.update_report_status(
            report_id=report_id,
            new_status=normalized_status,
            actor=actor,
            comment=comment,
        )
        if not updated:
            raise HTTPException(status_code=404, detail=ReportManagementService.REPORT_NOT_FOUND)

        return ReportManagementService.get_report(report_id)

    @staticmethod
    def get_manager_dashboard_metrics() -> ManagerDashboardMetricsResponse:
        reports = ReportRepository.list_reports()
        report_ids = [str(report["id"]) for report in reports]
        results_by_report = ReportRepository.get_report_results_for_reports(report_ids)

        total_reports = len(reports)
        approved_reports = sum(1 for report in reports if report["status"] == "APPROVED")
        final_decisions = [
            report for report in reports if report["status"] in {"APPROVED", "REJECTED", "NEEDS_CHANGES"}
        ]
        approval_rate = (
            round((approved_reports / len(final_decisions)) * 100, 2)
            if final_decisions
            else 0.0
        )

        validation_durations_hours: list[float] = []
        monthly_counter: Counter[str] = Counter()
        threat_counter: Counter[str] = Counter()
        riskiest_apps: list[dict] = []

        for report in reports:
            generated_at = report.get("generated_at")
            validated_at = report.get("validated_at")
            if generated_at:
                monthly_counter[generated_at.strftime("%Y-%m")] += 1

            if generated_at and validated_at:
                duration = validated_at - generated_at
                validation_durations_hours.append(duration.total_seconds() / 3600)

            report_result = results_by_report.get(str(report["id"]))
            if not report_result:
                continue

            selected_threats = report_result.get("selected_threats") or []
            scenario_count = 0
            mitigation_count = 0

            for threat in selected_threats:
                threat_name = str(threat.get("name") or "").strip()
                if threat_name:
                    threat_counter[threat_name] += 1
                scenario_count += len(threat.get("attack_scenarios") or [])
                mitigation_count += len(threat.get("mitigations") or [])

            threat_count = len(selected_threats)
            risk_score = (threat_count * 5) + (scenario_count * 2) + mitigation_count

            riskiest_apps.append(
                {
                    "report_id": str(report["id"]),
                    "app_name": report["title"],
                    "status": report["status"],
                    "threat_count": threat_count,
                    "scenario_count": scenario_count,
                    "mitigation_count": mitigation_count,
                    "risk_score": risk_score,
                    "generated_at": generated_at,
                }
            )

        reports_by_month = [
            ReportsByMonthEntry(month=month, count=count)
            for month, count in sorted(monthly_counter.items())
        ]
        most_frequent_threats = [
            ThreatFrequencyEntry(threat_name=threat_name, count=count)
            for threat_name, count in threat_counter.most_common(5)
        ]
        riskiest_applications = [
            RiskyApplicationEntry(**item)
            for item in sorted(
                riskiest_apps,
                key=lambda item: (
                    item["risk_score"],
                    item["threat_count"],
                    item["scenario_count"],
                    item["generated_at"] or datetime.min,
                ),
                reverse=True,
            )[:5]
        ]

        average_validation_time_hours = (
            round(sum(validation_durations_hours) / len(validation_durations_hours), 2)
            if validation_durations_hours
            else None
        )

        return ManagerDashboardMetricsResponse(
            total_reports=total_reports,
            approved_reports=approved_reports,
            approval_rate=approval_rate,
            average_validation_time_hours=average_validation_time_hours,
            reports_by_month=reports_by_month,
            most_frequent_threats=most_frequent_threats,
            riskiest_applications=riskiest_applications,
        )

from __future__ import annotations

from datetime import datetime
from io import BytesIO
import json
import logging
from pathlib import Path
from collections import Counter
import re
import shutil

from fastapi import HTTPException, status
from PIL import Image, UnidentifiedImageError

from app.core.auth import AuthenticatedUser, user_has_role
from app.core.config import settings
from app.core.exceptions import AnalysisStepError
from app.repositories.manager_review_feedback_repository import (
    ManagerReviewFeedbackRepository,
)
from app.repositories.report_repository import ReportRepository
from app.schemas.report import (
    EditableThreat,
    ManagerDashboardMetricsResponse,
    ManagerReviewFeedbackItem,
    ManagerReviewFeedbackResponse,
    ReportsByMonthEntry,
    RiskyApplicationEntry,
    ReportAnnotationResponse,
    ReportResultVersionResponse,
    ThreatFrequencyEntry,
    ReportResultsResponse,
    ReportResponse,
    SecOpsModificationReason,
    ReportStatusHistoryResponse,
)
from app.services.llm_feedback_service import LlmFeedbackService
from app.services.audit_service import AuditService
from app.services.minio_service import MinioService
from app.services.report_service import build_safe_slug, generate_report_pdf

logger = logging.getLogger(__name__)


class ReportManagementService:
    DOWNLOAD_PATH_TEMPLATE = "/reports/{report_id}/download"
    VERSION_DOWNLOAD_PATH_TEMPLATE = "/reports/{report_id}/versions/{version_number}/download"
    ALLOWED_STATUS_TRANSITIONS = {
        "DRAFT": {"PENDING"},
        "REJECTED": {"PENDING"},
        "PENDING": {"APPROVED", "REJECTED"},
    }
    IMMUTABLE_REPORT_STATUSES = {"APPROVED"}
    EDITABLE_REPORT_STATUSES = {"DRAFT", "REJECTED"}
    MANAGER_VISIBLE_STATUSES = {"PENDING", "APPROVED", "REJECTED"}
    REPORT_NOT_FOUND = "Rapport introuvable."
    REPORT_RESULTS_NOT_FOUND = (
        "Resultats de rapport introuvables. Regenerer le rapport depuis une nouvelle analyse."
    )
    DEFAULT_DESCRIPTION = "Description indisponible."
    PDF_CONTENT_TYPE = "application/pdf"
    DEFAULT_DFD_REFERENCE = "DFD-01"
    ALLOWED_DFD_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
    ALLOWED_DFD_FORMATS = {"PNG", "JPEG", "WEBP"}
    SECOPS_REASON_LABELS = {
        "INCOHERENCE_CONTEXTE_LLM": "Incoherence de contexte detectee dans la sortie LLM",
        "MANQUE_MENACE": "Menace manquante",
        "MENACE_HORS_CONTEXTE": "Menace hors contexte applicatif",
        "DESCRIPTION_MENACE_INCORRECTE": "Description de menace incorrecte",
        "SCENARIO_ATTAQUE_MANQUANT": "Scenario d'attaque manquant",
        "SCENARIO_ATTAQUE_INCOHERENT": "Scenario d'attaque incoherent",
        "MITIGATION_MANQUANTE": "Mitigation manquante",
        "MITIGATION_INCOHERENTE": "Mitigation incoherente",
        "MITIGATION_TROP_GENERIQUE": "Mitigation trop generique",
        "DFD_INCOMPLET": "DFD incomplet",
        "DFD_INCOHERENT": "DFD incoherent",
        "DFD_MANQUE_FLUX": "DFD avec flux manquants",
        "DFD_MANQUE_COMPOSANT": "DFD avec composants manquants",
        "DESCRIPTION_APPLICATIVE_INCOMPLETE": "Description applicative incomplete",
        "DESCRIPTION_APPLICATIVE_INCOHERENTE": "Description applicative incoherente",
        "AUTRE": "Autre motif",
    }
    SECOPS_ROLE = "secops_engineer"
    MANAGER_ROLE = "manager"

    @staticmethod
    def _normalize_text(value: str | None) -> str:
        return str(value or "").strip().lower()

    @staticmethod
    def _contains_any(text: str, keywords: tuple[str, ...]) -> bool:
        return any(keyword in text for keyword in keywords)

    @staticmethod
    def _compute_attack_surface_score(
        description_text: str,
        selected_threats: list[dict],
    ) -> int:
        score = 0

        if ReportManagementService._contains_any(
            description_text,
            ("internet", "public", "publique", "externe", "web", "mobile"),
        ):
            score += 6
        if ReportManagementService._contains_any(
            description_text,
            ("api", "rest", "graphql", "endpoint", "microservice"),
        ):
            score += 4
        if ReportManagementService._contains_any(
            description_text,
            ("upload", "fichier", "piece jointe", "document"),
        ):
            score += 3
        if ReportManagementService._contains_any(
            description_text,
            ("keycloak", "sso", "oauth", "openid", "authentification", "identity"),
        ):
            score += 3
        if ReportManagementService._contains_any(
            description_text,
            ("tiers", "partenaire", "integration", "broker", "mq", "kafka", "rabbitmq"),
        ):
            score += 2
        if any(
            ReportManagementService._contains_any(
                " ".join(
                    [
                        str(threat.get("name") or ""),
                        str(threat.get("description") or ""),
                        " ".join(threat.get("attack_scenarios") or []),
                    ]
                ).lower(),
                ("network", "reseau", "api", "session", "token", "auth"),
            )
            for threat in selected_threats
        ):
            score += 2

        return min(score, 20)

    @staticmethod
    def _compute_business_impact_score(description_text: str) -> int:
        score = 0

        if ReportManagementService._contains_any(
            description_text,
            ("personnel", "personnelles", "client", "rh", "employe", "utilisateur"),
        ):
            score += 6
        if ReportManagementService._contains_any(
            description_text,
            ("banque", "bancaire", "paiement", "transaction", "compte", "finance"),
        ):
            score += 8
        if ReportManagementService._contains_any(
            description_text,
            ("confidentiel", "sensible", "secret", "reglementaire", "conformite"),
        ):
            score += 4
        if ReportManagementService._contains_any(
            description_text,
            ("critique", "production", "metier", "pilotage"),
        ):
            score += 3

        return min(score, 20)

    @staticmethod
    def _compute_threat_severity_score(selected_threats: list[dict]) -> int:
        if not selected_threats:
            return 0

        base_score = 0.0
        severity_keywords = {
            4.0: ("rce", "remote code execution", "privilege escalation", "account takeover"),
            3.0: ("injection", "xss", "csrf", "ssrf", "deserialization", "auth bypass"),
            2.0: ("disclosure", "exposure", "leak", "bypass", "spoofing"),
        }

        for threat in selected_threats:
            threat_text = " ".join(
                [
                    str(threat.get("name") or ""),
                    str(threat.get("description") or ""),
                    " ".join(threat.get("attack_scenarios") or []),
                ]
            ).lower()

            matched_weight = 1.5
            for weight, keywords in severity_keywords.items():
                if ReportManagementService._contains_any(threat_text, keywords):
                    matched_weight = weight
                    break
            base_score += matched_weight

        scenario_count = sum(len(threat.get("attack_scenarios") or []) for threat in selected_threats)
        weighted_score = base_score + min(scenario_count * 0.6, 6)

        return min(round(weighted_score), 25)

    @staticmethod
    def _compute_reference_exposure_score(selected_threats: list[dict]) -> int:
        score = 0
        cve_reference_count = 0
        high_cvss_count = 0
        critical_cvss_count = 0

        for threat in selected_threats:
            references = threat.get("references") or []
            if not isinstance(references, list):
                references = []

            threat_blob = json.dumps(threat, ensure_ascii=False).lower()
            cve_reference_count += len(re.findall(r"cve-\d{4}-\d{4,7}", threat_blob))

            for reference in references:
                if not isinstance(reference, dict):
                    continue
                raw_cvss = reference.get("cvss_score")
                try:
                    cvss_score = float(raw_cvss)
                except (TypeError, ValueError):
                    continue
                if cvss_score >= 9:
                    critical_cvss_count += 1
                elif cvss_score >= 7:
                    high_cvss_count += 1

        score += min(cve_reference_count * 2, 6)
        score += min(high_cvss_count * 2, 4)
        score += min(critical_cvss_count * 3, 5)

        return min(score, 15)

    @staticmethod
    def _compute_protection_adjustment(
        threat_count: int,
        mitigation_count: int,
        description_text: str,
    ) -> int:
        if threat_count <= 0:
            return 0

        score = 0
        mitigations_per_threat = mitigation_count / max(threat_count, 1)

        if mitigations_per_threat < 1:
            score += 8
        elif mitigations_per_threat < 2:
            score += 4
        elif mitigations_per_threat >= 3:
            score -= 4

        if ReportManagementService._contains_any(
            description_text,
            ("mfa", "chiffrement", "journalisation", "segmentation", "waf", "zero trust"),
        ):
            score -= 3

        return max(-10, min(score, 10))

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
    def _serialize_manager_feedback(entries: list[dict]) -> list[ManagerReviewFeedbackResponse]:
        return [
            ManagerReviewFeedbackResponse(
                id=entry["id"],
                decision_type=entry["decision_type"],
                reason_code=entry["reason_code"],
                severity=entry.get("severity"),
                section_type=entry.get("section_type") or "GLOBAL",
                section_identifier=entry.get("section_identifier"),
                comment=entry.get("comment"),
                created_by=str(entry["created_by"]) if entry.get("created_by") else None,
                created_by_username=entry.get("created_by_username"),
                created_by_email=entry.get("created_by_email"),
                created_at=entry["created_at"],
            )
            for entry in entries
        ]

    @staticmethod
    def _normalize_modification_reasons(
        reasons: list[SecOpsModificationReason] | None,
    ) -> list[SecOpsModificationReason]:
        normalized: list[SecOpsModificationReason] = []
        for reason in reasons or []:
            code = reason.reason_code.strip().upper()
            if not code:
                continue
            normalized.append(
                SecOpsModificationReason(
                    reason_code=code,
                    section_type=(reason.section_type or "GLOBAL").strip().upper() or "GLOBAL",
                    section_identifier=(reason.section_identifier or "").strip() or None,
                    comment=(reason.comment or "").strip() or None,
                )
            )
        return normalized

    @staticmethod
    def _format_modification_reason_summary(
        reasons: list[SecOpsModificationReason],
        free_comment: str | None,
    ) -> str:
        parts: list[str] = []
        for reason in reasons:
            label = ReportManagementService.SECOPS_REASON_LABELS.get(
                reason.reason_code, reason.reason_code
            )
            section = "" if reason.section_type == "GLOBAL" else f" [{reason.section_type}]"
            detail = f" ({reason.comment})" if reason.comment else ""
            parts.append(f"{label}{section}{detail}")
        if free_comment:
            parts.append(f"Commentaire libre: {free_comment.strip()}")
        return " ; ".join(parts) if parts else "Modification manuelle des resultats du rapport."

    @staticmethod
    def _build_manager_reject_comment(
        feedback_items: list[ManagerReviewFeedbackItem],
        comment: str | None,
    ) -> str:
        explicit_comment = (comment or "").strip()
        if explicit_comment:
            return explicit_comment
        labels = [item.reason_code.strip().upper() for item in feedback_items if item.reason_code.strip()]
        if labels:
            return "Rejet manager: " + ", ".join(labels)
        return "Rapport rejete par le manager."

    @staticmethod
    def _ensure_editable_status(report_row: dict) -> None:
        if report_row["status"] not in ReportManagementService.EDITABLE_REPORT_STATUSES:
            raise HTTPException(
                status_code=400,
                detail="Le rapport n'est modifiable qu'en brouillon ou apres rejet.",
            )

    @staticmethod
    def _ensure_role(user: AuthenticatedUser, role: str) -> None:
        if not user_has_role(user, role):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Vous n'etes pas autorise a effectuer cette action.",
            )

    @staticmethod
    def _ensure_secops_role(user: AuthenticatedUser) -> None:
        ReportManagementService._ensure_role(user, ReportManagementService.SECOPS_ROLE)

    @staticmethod
    def _ensure_manager_role(user: AuthenticatedUser) -> None:
        ReportManagementService._ensure_role(user, ReportManagementService.MANAGER_ROLE)

    @staticmethod
    def _ensure_report_owner(report_row: dict, user: AuthenticatedUser) -> None:
        if str(report_row.get("generated_by") or "") != str(user.user_id):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Vous n'etes pas autorise a acceder a ce rapport.",
            )

    @staticmethod
    def _ensure_secops_access_to_report(report_row: dict, user: AuthenticatedUser) -> None:
        ReportManagementService._ensure_secops_role(user)
        ReportManagementService._ensure_report_owner(report_row, user)

    @staticmethod
    def _ensure_manager_access_to_report(report_row: dict, user: AuthenticatedUser) -> None:
        ReportManagementService._ensure_manager_role(user)
        if report_row["status"] not in ReportManagementService.MANAGER_VISIBLE_STATUSES:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=ReportManagementService.REPORT_NOT_FOUND,
            )

    @staticmethod
    def _format_application_version(version_number: int | None) -> str:
        normalized = version_number or 1
        return f"v{normalized}"

    @staticmethod
    def _normalize_dfd_reference(value: str | None) -> str:
        text = str(value or "").strip()
        return text or ReportManagementService.DEFAULT_DFD_REFERENCE

    @staticmethod
    def _archive_dfd_asset(
        *,
        report_id: str,
        version_number: int,
        dfd_image_path: str | None,
    ) -> str | None:
        normalized_path = (dfd_image_path or "").strip() or None
        if not normalized_path:
            return None

        if MinioService.parse_minio_uri(normalized_path):
            return normalized_path

        source_path = Path(normalized_path)
        if not source_path.exists():
            return normalized_path

        suffix = source_path.suffix.lower() or ".png"
        object_key = f"reports/{report_id}/versions/v{version_number}/dfd/{source_path.name}"
        normalized_suffix = suffix.removeprefix(".")
        content_type = f"image/{'jpeg' if normalized_suffix == 'jpg' else normalized_suffix}"

        try:
            upload_result = MinioService.upload_file(
                str(source_path),
                object_key=object_key,
                content_type=content_type,
            )
            return MinioService.build_minio_uri(
                upload_result["bucket"],
                upload_result["object_key"],
            )
        except Exception as exc:
            logger.warning(
                "Archivage MinIO du DFD impossible pour report=%s version=%s, fallback local: %s",
                report_id,
                version_number,
                exc,
            )

        archive_dir = Path(__file__).resolve().parents[2] / "resources" / "archived_dfd" / report_id
        archive_dir.mkdir(parents=True, exist_ok=True)
        archive_path = archive_dir / f"v{version_number}{suffix}"
        shutil.copy2(source_path, archive_path)
        return str(archive_path.resolve())

    @staticmethod
    def _normalize_selected_threats(selected_threats: list[EditableThreat] | list[dict]) -> list[dict]:
        normalized: list[dict] = []
        for raw in selected_threats:
            if isinstance(raw, EditableThreat):
                threat_name = raw.name.strip()
                description = (raw.description or "").strip()
                attack_scenarios = ReportManagementService._normalize_text_list(raw.attack_scenarios)
                mitigations = ReportManagementService._normalize_text_list(raw.mitigations)
                references: list[dict] = []
            else:
                threat_name = str(raw.get("name") or "").strip()
                description = str(raw.get("description") or "").strip()
                attack_scenarios = ReportManagementService._normalize_text_list(
                    raw.get("attack_scenarios")
                )
                mitigations = ReportManagementService._normalize_text_list(raw.get("mitigations"))
                references = []
                for reference in raw.get("references") or []:
                    if not isinstance(reference, dict):
                        continue

                    reference_code = str(reference.get("reference_menace") or "").strip()
                    reference_name = str(reference.get("nom_reference") or "").strip()
                    reference_link = str(reference.get("lien") or "").strip()

                    if not any((reference_code, reference_name, reference_link)):
                        continue

                    references.append(
                        {
                            "reference_menace": reference_code,
                            "nom_reference": reference_name,
                            "lien": reference_link,
                        }
                    )

            if not threat_name:
                continue

            normalized.append(
                {
                    "name": threat_name,
                    "description": description,
                    "attack_scenarios": attack_scenarios,
                    "mitigations": mitigations,
                    "references": references,
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
        version_history_rows = ReportRepository.get_report_result_versions(
            str(report_results_row["report_id"])
        )
        version_history = [
            ReportResultVersionResponse(
                version_number=int(version_row.get("version_number") or 1),
                version_label=str(version_row.get("version_label") or f"v{int(version_row.get('version_number') or 1)}"),
                app_name=str(version_row.get("app_name") or "").strip(),
                developer_name=str(version_row.get("developer_name") or "").strip(),
                application_description=str(version_row.get("application_description") or "").strip(),
                selected_threats=[
                    EditableThreat(**item)
                    for item in ReportManagementService._normalize_selected_threats(
                        version_row.get("selected_threats") or []
                    )
                ],
                dfd_image_path=version_row.get("dfd_image_path"),
                dfd_reference=ReportManagementService._normalize_dfd_reference(
                    version_row.get("dfd_reference")
                ),
                download_url=ReportManagementService.VERSION_DOWNLOAD_PATH_TEMPLATE.format(
                    report_id=str(report_results_row["report_id"]),
                    version_number=int(version_row.get("version_number") or 1),
                ),
                created_by_username=version_row.get("created_by_username"),
                created_by_email=version_row.get("created_by_email"),
                change_reason=version_row.get("change_reason"),
                created_at=version_row["created_at"],
            )
            for version_row in version_history_rows
        ]

        return ReportResultsResponse(
            report_id=str(report_results_row["report_id"]),
            app_name=report_results_row["app_name"],
            developer_name=report_results_row["developer_name"],
            application_description=report_results_row["application_description"],
            version_number=int(report_results_row.get("version_number") or 1),
            application_version=ReportManagementService._format_application_version(
                report_results_row.get("version_number")
            ),
            selected_threats=[EditableThreat(**item) for item in normalized],
            dfd_image_path=report_results_row.get("dfd_image_path"),
            dfd_reference=ReportManagementService._normalize_dfd_reference(
                report_results_row.get("dfd_reference")
            ),
            updated_at=report_results_row.get("updated_at"),
            version_history=version_history,
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
        file_name: str | None,
        file_type: str | None,
        file_size: int | None,
        minio_bucket: str | None,
        minio_object_key: str | None,
        generated_by: AuthenticatedUser,
    ) -> ReportResultsResponse:
        normalized_threats = ReportManagementService._normalize_selected_threats(selected_threats)
        normalized_dfd_reference = ReportManagementService._normalize_dfd_reference(dfd_reference)
        archived_dfd_image_path = ReportManagementService._archive_dfd_asset(
            report_id=report_id,
            version_number=1,
            dfd_image_path=dfd_image_path,
        )
        row = ReportRepository.upsert_report_results(
            report_id=report_id,
            app_name=(app_name or "").strip() or "Application",
            developer_name=(developer_name or "").strip() or generated_by.display_name,
            application_description=(application_description or "").strip()
            or ReportManagementService.DEFAULT_DESCRIPTION,
            selected_threats=normalized_threats,
            dfd_image_path=archived_dfd_image_path,
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
            file_name=file_name,
            file_type=file_type,
            file_size=file_size,
            minio_bucket=minio_bucket,
            minio_object_key=minio_object_key,
            actor=generated_by,
            change_reason="Version initiale generee automatiquement.",
        )
        AuditService.log_action(
            actor=generated_by,
            action_type="CREATE_REPORT_RESULTS",
            entity_type="report_results",
            entity_id=report_id,
            entity_label=row["app_name"],
            parent_entity_type="report",
            parent_entity_id=report_id,
            new_values={
                "app_name": row["app_name"],
                "developer_name": row["developer_name"],
                "version_number": 1,
                "threat_count": len(normalized_threats),
                "dfd_reference": normalized_dfd_reference,
            },
        )
        return ReportManagementService._serialize_report_results(row)

    @staticmethod
    def get_report_results(report_id: str, user: AuthenticatedUser) -> ReportResultsResponse:
        report_row = ReportRepository.get_report_by_id(report_id)
        if not report_row:
            raise HTTPException(status_code=404, detail=ReportManagementService.REPORT_NOT_FOUND)

        if user_has_role(user, ReportManagementService.MANAGER_ROLE):
            ReportManagementService._ensure_manager_access_to_report(report_row, user)
        else:
            ReportManagementService._ensure_secops_access_to_report(report_row, user)

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
        modification_reasons: list[SecOpsModificationReason] | None = None,
        modification_comment: str | None = None,
    ) -> ReportResultsResponse:
        report_row = ReportRepository.get_report_by_id(report_id)
        if not report_row:
            raise HTTPException(status_code=404, detail=ReportManagementService.REPORT_NOT_FOUND)
        ReportManagementService._ensure_secops_access_to_report(report_row, actor)
        if report_row["status"] in ReportManagementService.IMMUTABLE_REPORT_STATUSES:
            raise HTTPException(
                status_code=400,
                detail="Le rapport est valide. Aucune modification n'est autorisee.",
            )
        ReportManagementService._ensure_editable_status(report_row)

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
        next_version_number = int(existing.get("version_number") or 1) + 1
        archived_dfd_image_path = ReportManagementService._archive_dfd_asset(
            report_id=report_id,
            version_number=next_version_number,
            dfd_image_path=next_dfd_image_path,
        )

        if not ReportManagementService._results_payload_changed(
            existing,
            app_name=next_app_name,
            developer_name=next_developer_name,
            application_description=next_description,
            selected_threats=normalized,
            dfd_image_path=archived_dfd_image_path,
            dfd_reference=next_dfd_reference,
        ):
            return ReportManagementService._serialize_report_results(existing)

        normalized_reasons = ReportManagementService._normalize_modification_reasons(
            modification_reasons
        )
        free_comment = (modification_comment or "").strip() or None
        if not normalized_reasons and not free_comment:
            raise HTTPException(
                status_code=400,
                detail="Precisez au moins un motif de modification SecOps.",
            )

        change_reason = ReportManagementService._format_modification_reason_summary(
            normalized_reasons,
            free_comment,
        )

        updated = ReportRepository.update_report_results(
            report_id=report_id,
            app_name=next_app_name,
            developer_name=next_developer_name,
            application_description=next_description,
            selected_threats=normalized,
            dfd_image_path=archived_dfd_image_path,
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
            dfd_image_path=archived_dfd_image_path,
            dfd_reference=next_dfd_reference,
            file_name=None,
            file_type=None,
            file_size=None,
            minio_bucket=None,
            minio_object_key=None,
            actor=actor,
            change_reason=change_reason,
        )
        LlmFeedbackService.capture_report_corrections(
            report_id=report_id,
            previous_row=existing,
            next_version_number=next_version_number,
            app_name=next_app_name,
            application_description=next_description,
            selected_threats=normalized,
            dfd_image_path=archived_dfd_image_path,
            dfd_reference=next_dfd_reference,
            actor=actor,
            correction_reason=change_reason,
            error_type=normalized_reasons[0].reason_code if normalized_reasons else "manual_correction",
        )
        AuditService.log_action(
            actor=actor,
            action_type="UPDATE_REPORT_RESULTS",
            entity_type="report_results",
            entity_id=report_id,
            entity_label=next_app_name,
            parent_entity_type="report",
            parent_entity_id=report_id,
            old_values={
                "app_name": existing.get("app_name"),
                "developer_name": existing.get("developer_name"),
                "application_description": existing.get("application_description"),
                "version_number": existing.get("version_number"),
                "selected_threats": existing.get("selected_threats"),
                "dfd_reference": existing.get("dfd_reference"),
            },
            new_values={
                "app_name": next_app_name,
                "developer_name": next_developer_name,
                "application_description": next_description,
                "version_number": next_version_number,
                "selected_threats": normalized,
                "dfd_reference": next_dfd_reference,
            },
            comment=change_reason,
            metadata={
                "modification_reason_codes": [reason.reason_code for reason in normalized_reasons],
                "modification_comment": free_comment,
            },
        )
        return ReportManagementService._serialize_report_results(updated)

    @staticmethod
    def regenerate_report(report_id: str, actor: AuthenticatedUser) -> ReportResponse:
        report_row = ReportRepository.get_report_by_id(report_id)
        if not report_row:
            raise HTTPException(status_code=404, detail=ReportManagementService.REPORT_NOT_FOUND)
        ReportManagementService._ensure_secops_access_to_report(report_row, actor)
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

        target_status = report_row["status"]
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
                else "Rapport regenere apres rejet, en attente de resoumission SecOps."
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
        ReportRepository.update_report_result_version_file_metadata(
            report_id=report_id,
            version_number=int(editable_results.get("version_number") or 1),
            file_name=report_file_name,
            file_type=ReportManagementService.PDF_CONTENT_TYPE,
            file_size=upload_result["file_size"],
            minio_bucket=upload_result["bucket"],
            minio_object_key=upload_result["object_key"],
        )
        AuditService.log_action(
            actor=actor,
            action_type="REGENERATE_REPORT",
            entity_type="report",
            entity_id=report_id,
            entity_label=app_name,
            old_values={
                "status": report_row["status"],
                "file_name": report_row["file_name"],
            },
            new_values={
                "status": updated_report["status"],
                "file_name": updated_report["file_name"],
            },
            metadata={
                "version_number": int(editable_results.get("version_number") or 1),
                "dfd_reference": dfd_reference,
            },
        )

        return ReportManagementService.get_report(report_id, actor)

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
        manager_feedback_map: dict[str, list[dict]] | None = None,
    ) -> ReportResponse:
        report_id = str(report_row["id"])
        annotations = annotations_map.get(report_id, []) if annotations_map else []
        history = history_map.get(report_id, []) if history_map else []
        manager_feedback = manager_feedback_map.get(report_id, []) if manager_feedback_map else []

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
            manager_feedback=ReportManagementService._serialize_manager_feedback(manager_feedback),
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
        actor: AuthenticatedUser,
    ) -> dict:
        report_row = ReportRepository.get_report_by_id(report_id)
        if not report_row:
            raise HTTPException(status_code=404, detail=ReportManagementService.REPORT_NOT_FOUND)
        ReportManagementService._ensure_secops_access_to_report(report_row, actor)
        if report_row["status"] in ReportManagementService.IMMUTABLE_REPORT_STATUSES:
            raise HTTPException(
                status_code=400,
                detail="Le rapport est valide. Aucune modification n'est autorisee.",
            )
        ReportManagementService._ensure_editable_status(report_row)

        extension = Path(original_file_name or "").suffix.lower()
        if extension not in ReportManagementService.ALLOWED_DFD_EXTENSIONS:
            raise HTTPException(
                status_code=400,
                detail="Format d'image DFD non supporte. Utilisez PNG, JPG, JPEG ou WEBP.",
            )

        file_bytes = file_stream.read()
        if not file_bytes:
            raise HTTPException(status_code=400, detail="Le fichier DFD est vide.")
        if len(file_bytes) > settings.MAX_DFD_UPLOAD_BYTES:
            raise HTTPException(
                status_code=400,
                detail="Le fichier DFD depasse la taille maximale autorisee.",
            )

        try:
            with Image.open(BytesIO(file_bytes)) as image:
                image.verify()
            with Image.open(BytesIO(file_bytes)) as image:
                detected_format = str(image.format or "").upper()
        except (UnidentifiedImageError, OSError) as exc:
            raise HTTPException(
                status_code=400,
                detail="Le fichier DFD fourni n'est pas une image valide.",
            ) from exc

        if detected_format not in ReportManagementService.ALLOWED_DFD_FORMATS:
            raise HTTPException(
                status_code=400,
                detail="Le format reel de l'image DFD n'est pas autorise.",
            )

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
        AuditService.log_action(
            actor=generated_by,
            action_type="CREATE_REPORT",
            entity_type="report",
            entity_id=str(report_row["id"]),
            entity_label=report_row["title"],
            new_values={
                "status": report_row["status"],
                "file_name": report_row["file_name"],
                "file_size": report_row["file_size"],
            },
            metadata={"minio_bucket": report_row["minio_bucket"]},
        )
        return ReportManagementService._serialize_report(report_row)

    @staticmethod
    def get_version_download_payload(
        report_id: str,
        version_number: int,
        user: AuthenticatedUser,
    ) -> dict:
        report_row = ReportRepository.get_report_by_id(report_id)
        if not report_row:
            raise HTTPException(status_code=404, detail=ReportManagementService.REPORT_NOT_FOUND)

        if user_has_role(user, ReportManagementService.MANAGER_ROLE):
            ReportManagementService._ensure_manager_access_to_report(report_row, user)
        else:
            ReportManagementService._ensure_secops_access_to_report(report_row, user)

        version_rows = ReportRepository.get_report_result_versions(report_id)
        target_version = next(
            (row for row in version_rows if int(row.get("version_number") or 0) == version_number),
            None,
        )
        if not target_version:
            raise HTTPException(status_code=404, detail="Version de rapport introuvable.")

        bucket = target_version.get("minio_bucket")
        object_key = target_version.get("minio_object_key")
        file_name = target_version.get("file_name") or f"rapport-v{version_number}.pdf"
        file_type = target_version.get("file_type") or ReportManagementService.PDF_CONTENT_TYPE

        if not bucket or not object_key:
            selected_threats = ReportManagementService._normalize_selected_threats(
                target_version.get("selected_threats") or []
            )
            application_version = ReportManagementService._format_application_version(version_number)
            developer_name = str(target_version.get("developer_name") or user.display_name or user.username or "Non renseigne").strip()
            app_name = str(target_version.get("app_name") or report_row.get("title") or "Application").strip()
            description = str(
                target_version.get("application_description")
                or report_row.get("description")
                or ReportManagementService.DEFAULT_DESCRIPTION
            ).strip()
            original_dfd_image_path = (target_version.get("dfd_image_path") or "").strip() or None
            dfd_image_path = ReportManagementService._archive_dfd_asset(
                report_id=report_id,
                version_number=version_number,
                dfd_image_path=original_dfd_image_path,
            )
            if dfd_image_path != original_dfd_image_path:
                ReportRepository.update_report_result_version_dfd_path(
                    report_id=report_id,
                    version_number=version_number,
                    dfd_image_path=dfd_image_path,
                )
            dfd_reference = ReportManagementService._normalize_dfd_reference(
                target_version.get("dfd_reference")
            )
            report_file_name = (
                f"rapport-{build_safe_slug(developer_name)}-"
                f"{build_safe_slug(app_name)}-{application_version}.pdf"
            )
            regenerated_pdf_path = generate_report_pdf(
                app_name=app_name,
                developer_name=developer_name,
                generated_description=description,
                selected_threats=selected_threats,
                dfd_image_path=dfd_image_path,
                dfd_reference=dfd_reference,
                application_version=application_version,
                report_file_name=report_file_name,
            )
            return {
                "report": {
                    "file_name": report_file_name,
                    "file_type": ReportManagementService.PDF_CONTENT_TYPE,
                },
                "local_path": str(Path(regenerated_pdf_path).resolve()),
                "object_response": None,
            }

        if bucket == MinioService.LOCAL_BUCKET:
            local_path = Path(object_key)
            if not local_path.exists():
                raise HTTPException(status_code=404, detail="Fichier local de cette version introuvable.")
            return {
                "report": {
                    "file_name": file_name,
                    "file_type": file_type,
                },
                "local_path": str(local_path),
                "object_response": None,
            }

        object_response = MinioService.get_object(bucket, object_key)
        return {
            "report": {
                "file_name": file_name,
                "file_type": file_type,
            },
            "local_path": None,
            "object_response": object_response,
        }

    @staticmethod
    def list_my_reports(user: AuthenticatedUser) -> list[ReportResponse]:
        ReportManagementService._ensure_secops_role(user)
        rows = ReportRepository.list_reports(generated_by=str(user.user_id))
        report_ids = [str(row["id"]) for row in rows]
        annotations_map = ReportRepository.get_annotations_for_reports(report_ids)
        history_map = ReportRepository.get_status_history_for_reports(report_ids)
        manager_feedback_map = ManagerReviewFeedbackRepository.get_feedback_for_reports(report_ids)
        return [
            ReportManagementService._serialize_report(
                row,
                annotations_map,
                history_map,
                manager_feedback_map,
            )
            for row in rows
        ]

    @staticmethod
    def list_all_reports(user: AuthenticatedUser) -> list[ReportResponse]:
        ReportManagementService._ensure_manager_role(user)
        rows = [
            row for row in ReportRepository.list_reports()
            if row["status"] in ReportManagementService.MANAGER_VISIBLE_STATUSES
        ]
        report_ids = [str(row["id"]) for row in rows]
        annotations_map = ReportRepository.get_annotations_for_reports(report_ids)
        history_map = ReportRepository.get_status_history_for_reports(report_ids)
        manager_feedback_map = ManagerReviewFeedbackRepository.get_feedback_for_reports(report_ids)
        return [
            ReportManagementService._serialize_report(
                row,
                annotations_map,
                history_map,
                manager_feedback_map,
            )
            for row in rows
        ]

    @staticmethod
    def get_report(report_id: str, user: AuthenticatedUser) -> ReportResponse:
        row = ReportRepository.get_report_by_id(report_id)
        if not row:
            raise HTTPException(status_code=404, detail=ReportManagementService.REPORT_NOT_FOUND)

        if user_has_role(user, ReportManagementService.MANAGER_ROLE):
            ReportManagementService._ensure_manager_access_to_report(row, user)
        else:
            ReportManagementService._ensure_secops_access_to_report(row, user)

        annotations_map = {report_id: ReportRepository.get_annotations(report_id)}
        history_map = {report_id: ReportRepository.get_status_history(report_id)}
        manager_feedback_map = {
            report_id: ManagerReviewFeedbackRepository.get_feedback_for_report(report_id)
        }
        return ReportManagementService._serialize_report(
            row,
            annotations_map,
            history_map,
            manager_feedback_map,
        )

    @staticmethod
    def get_download_payload(report_id: str, user: AuthenticatedUser) -> dict:
        report_row = ReportRepository.get_report_by_id(report_id)
        if not report_row:
            raise HTTPException(status_code=404, detail=ReportManagementService.REPORT_NOT_FOUND)

        if user_has_role(user, ReportManagementService.MANAGER_ROLE):
            ReportManagementService._ensure_manager_access_to_report(report_row, user)
        else:
            ReportManagementService._ensure_secops_access_to_report(report_row, user)

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
                    "cause": None,
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
        feedback_items: list[ManagerReviewFeedbackItem] | None = None,
    ) -> ReportResponse:
        if (new_status or "").strip().upper() == "PENDING":
            ReportManagementService._ensure_secops_role(actor)
        else:
            ReportManagementService._ensure_manager_role(actor)

        normalized_status = (new_status or "").strip().upper()
        existing = ReportRepository.get_report_by_id(report_id)
        if not existing:
            raise HTTPException(status_code=404, detail=ReportManagementService.REPORT_NOT_FOUND)

        if normalized_status == "PENDING":
            ReportManagementService._ensure_report_owner(existing, actor)
        else:
            ReportManagementService._ensure_manager_access_to_report(existing, actor)

        allowed_transitions = ReportManagementService.ALLOWED_STATUS_TRANSITIONS.get(
            existing["status"],
            set(),
        )
        if normalized_status not in allowed_transitions:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Transition de statut non supportee pour ce rapport.",
            )

        normalized_feedback = [
            ManagerReviewFeedbackItem(
                decision_type=(item.decision_type or normalized_status).strip().upper() or normalized_status,
                reason_code=item.reason_code.strip().upper(),
                severity=(item.severity or "").strip().upper() or None,
                section_type=(item.section_type or "GLOBAL").strip().upper() or "GLOBAL",
                section_identifier=(item.section_identifier or "").strip() or None,
                comment=(item.comment or "").strip() or None,
            )
            for item in (feedback_items or [])
            if item.reason_code.strip()
        ]

        if normalized_status == "REJECTED" and not normalized_feedback:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Le rejet manager exige au moins un motif structure.",
            )

        if normalized_status == "PENDING" and existing["status"] == "REJECTED":
            report_results = ReportRepository.get_report_results(report_id)
            if not report_results:
                raise HTTPException(
                    status_code=404,
                    detail=ReportManagementService.REPORT_RESULTS_NOT_FOUND,
                )
            validated_at = existing.get("validated_at")
            updated_at = report_results.get("updated_at")
            if validated_at and updated_at and updated_at <= validated_at:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Corrigez le rapport avant de le resoumettre au manager.",
                )

        status_comment = comment
        if normalized_status == "REJECTED":
            status_comment = ReportManagementService._build_manager_reject_comment(
                normalized_feedback,
                comment,
            )
        elif normalized_status == "PENDING":
            status_comment = (comment or "").strip() or (
                "Rapport resoumis au manager."
                if existing["status"] == "REJECTED"
                else "Rapport soumis au manager."
            )

        updated = ReportRepository.update_report_status(
            report_id=report_id,
            new_status=normalized_status,
            actor=actor,
            comment=status_comment,
        )
        if not updated:
            raise HTTPException(status_code=404, detail=ReportManagementService.REPORT_NOT_FOUND)

        if normalized_status == "REJECTED":
            report_results = ReportRepository.get_report_results(report_id)
            report_version_number = (
                int(report_results.get("version_number") or 1) if report_results else None
            )
            ManagerReviewFeedbackRepository.create_feedback_entries(
                report_id=report_id,
                report_version_number=report_version_number,
                feedback_items=normalized_feedback,
                actor=actor,
            )

        action_type = {
            "PENDING": "SUBMIT_REPORT",
            "APPROVED": "APPROVE_REPORT",
            "REJECTED": "REJECT_REPORT",
        }[normalized_status]
        AuditService.log_action(
            actor=actor,
            action_type=action_type,
            entity_type="report",
            entity_id=report_id,
            entity_label=updated["title"],
            old_values={"status": existing["status"]},
            new_values={"status": normalized_status},
            comment=status_comment,
            metadata={
                "manager_feedback_reason_codes": [
                    item.reason_code for item in normalized_feedback
                ],
            },
        )

        return ReportManagementService.get_report(report_id, actor)

    @staticmethod
    def delete_report(report_id: str, actor: AuthenticatedUser) -> None:
        ReportManagementService._ensure_secops_role(actor)
        report_row = ReportRepository.get_report_by_id(report_id)
        if not report_row:
            raise HTTPException(status_code=404, detail=ReportManagementService.REPORT_NOT_FOUND)

        ReportManagementService._ensure_report_owner(report_row, actor)
        if report_row["status"] != "DRAFT":
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Seuls les rapports en brouillon peuvent etre supprimes.",
            )

        try:
            storage_bucket = report_row.get("minio_bucket")
            storage_object_key = report_row.get("minio_object_key")
            if storage_bucket and storage_object_key:
                MinioService.delete_object(storage_bucket, storage_object_key)
        except Exception:
            logger.warning(
                "Suppression stockage rapport en echec: report_id=%s bucket=%s object_key=%s",
                report_id,
                report_row.get("minio_bucket"),
                report_row.get("minio_object_key"),
                exc_info=True,
            )

        deleted = ReportRepository.delete_report(report_id)
        if not deleted:
            raise HTTPException(status_code=404, detail=ReportManagementService.REPORT_NOT_FOUND)

        AuditService.log_action(
            actor=actor,
            action_type="DELETE_REPORT",
            entity_type="report",
            entity_id=report_id,
            entity_label=report_row["title"],
            old_values={
                "status": report_row["status"],
                "file_name": report_row.get("file_name"),
                "minio_bucket": report_row.get("minio_bucket"),
                "minio_object_key": report_row.get("minio_object_key"),
            },
            comment="Suppression du brouillon SecOps.",
        )

    @staticmethod
    def get_manager_dashboard_metrics(user: AuthenticatedUser) -> ManagerDashboardMetricsResponse:
        ReportManagementService._ensure_manager_role(user)
        reports = [
            report for report in ReportRepository.list_reports()
            if report["status"] in ReportManagementService.MANAGER_VISIBLE_STATUSES
        ]
        report_ids = [str(report["id"]) for report in reports]
        results_by_report = ReportRepository.get_report_results_for_reports(report_ids)

        total_reports = len(reports)
        global_approved_reports = sum(1 for report in reports if report["status"] == "APPROVED")
        global_final_decisions = [
            report for report in reports if report["status"] in {"APPROVED", "REJECTED"}
        ]
        global_approval_rate = (
            round((global_approved_reports / len(global_final_decisions)) * 100, 2)
            if global_final_decisions
            else 0.0
        )
        my_final_decisions = [
            report
            for report in reports
            if report["status"] in {"APPROVED", "REJECTED"}
            and str(report.get("validated_by") or "") == str(user.user_id)
        ]
        my_approved_reports = sum(
            1
            for report in my_final_decisions
            if report["status"] == "APPROVED"
        )
        my_approval_rate = (
            round((my_approved_reports / len(my_final_decisions)) * 100, 2)
            if my_final_decisions
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
            application_description = ReportManagementService._normalize_text(
                report_result.get("application_description")
            )

            attack_surface_score = ReportManagementService._compute_attack_surface_score(
                application_description,
                selected_threats,
            )
            business_impact_score = ReportManagementService._compute_business_impact_score(
                application_description
            )
            threat_severity_score = ReportManagementService._compute_threat_severity_score(
                selected_threats
            )
            reference_exposure_score = ReportManagementService._compute_reference_exposure_score(
                selected_threats
            )
            protection_adjustment = ReportManagementService._compute_protection_adjustment(
                threat_count,
                mitigation_count,
                application_description,
            )

            # Score manager compose :
            # - surface d attaque (0-20)
            # - impact metier / sensibilite des donnees (0-20)
            # - richesse et severite des menaces/scenarios (0-25)
            # - exposition technique issue des references CVE/CVSS quand presentes (0-15)
            # - ajustement protections / mitigations (-10 a +10)
            risk_score = max(
                0,
                min(
                    100,
                    attack_surface_score
                    + business_impact_score
                    + threat_severity_score
                    + reference_exposure_score
                    + protection_adjustment,
                ),
            )

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
            approved_reports=global_approved_reports,
            approval_rate=global_approval_rate,
            global_approved_reports=global_approved_reports,
            global_approval_rate=global_approval_rate,
            my_approved_reports=my_approved_reports,
            my_approval_rate=my_approval_rate,
            average_validation_time_hours=average_validation_time_hours,
            reports_by_month=reports_by_month,
            most_frequent_threats=most_frequent_threats,
            riskiest_applications=riskiest_applications,
        )

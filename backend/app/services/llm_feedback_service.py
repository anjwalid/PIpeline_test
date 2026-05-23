from __future__ import annotations

import json
import logging

from app.core.auth import AuthenticatedUser
from app.repositories.llm_feedback_repository import LlmFeedbackRepository
from app.schemas.llm_feedback import LlmFeedbackCreateRequest, LlmFeedbackResponse

logger = logging.getLogger(__name__)


class LlmFeedbackService:
    SECTION_LABELS = {
        "application_description": "Description applicative",
        "dfd": "DFD",
        "threat": "Menace",
        "attack_scenario": "Scenario d'attaque",
        "mitigation": "Mitigation",
    }

    @staticmethod
    def _serialize_row(row: dict) -> LlmFeedbackResponse:
        return LlmFeedbackResponse(
            id=row["id"],
            report_id=str(row["report_id"]),
            report_version_number=row.get("report_version_number"),
            section_type=row["section_type"],
            section_identifier=row.get("section_identifier"),
            threat_name=row.get("threat_name"),
            original_content=row["original_content"],
            corrected_content=row["corrected_content"],
            correction_reason=row.get("correction_reason"),
            error_type=row["error_type"],
            created_by=str(row["created_by"]) if row.get("created_by") else None,
            created_by_username=row.get("created_by_username"),
            created_by_email=row.get("created_by_email"),
            created_at=row["created_at"],
        )

    @staticmethod
    def create_feedback(
        *,
        report_id: str,
        payload: LlmFeedbackCreateRequest,
        actor: AuthenticatedUser,
    ) -> LlmFeedbackResponse:
        row = LlmFeedbackRepository.create_feedback(
            report_id=report_id,
            report_version_number=payload.report_version_number,
            section_type=payload.section_type.strip(),
            section_identifier=(payload.section_identifier or "").strip() or None,
            threat_name=(payload.threat_name or "").strip() or None,
            original_content=payload.original_content.strip(),
            corrected_content=payload.corrected_content.strip(),
            correction_reason=(payload.correction_reason or "").strip() or None,
            error_type=payload.error_type.strip(),
            actor=actor,
        )
        return LlmFeedbackService._serialize_row(row)

    @staticmethod
    def list_feedback_for_report(report_id: str) -> list[LlmFeedbackResponse]:
        rows = LlmFeedbackRepository.list_feedback_for_report(report_id)
        return [LlmFeedbackService._serialize_row(row) for row in rows]

    @staticmethod
    def _normalize_text(value: str | None) -> str:
        return " ".join(str(value or "").split()).strip()

    @staticmethod
    def _truncate(value: str | None, limit: int = 220) -> str:
        text = LlmFeedbackService._normalize_text(value)
        if len(text) <= limit:
            return text
        return text[: limit - 3].rstrip() + "..."

    @staticmethod
    def _build_manual_reason(section_type: str, threat_name: str | None) -> str:
        label = LlmFeedbackService.SECTION_LABELS.get(section_type, section_type)
        if threat_name:
            return f"Correction SecOps manuelle sur {label.lower()} liee a la menace '{threat_name}'."
        return f"Correction SecOps manuelle sur {label.lower()}."

    @staticmethod
    def _compare_text_lists(
        *,
        section_type: str,
        threat_name: str,
        original_values: list[str],
        corrected_values: list[str],
    ) -> list[dict]:
        entries: list[dict] = []
        max_length = max(len(original_values), len(corrected_values))

        for index in range(max_length):
            original_value = (
                str(original_values[index]).strip()
                if index < len(original_values)
                else "[absent]"
            )
            corrected_value = (
                str(corrected_values[index]).strip()
                if index < len(corrected_values)
                else "[supprime par SecOps]"
            )
            if LlmFeedbackService._normalize_text(original_value) == LlmFeedbackService._normalize_text(
                corrected_value
            ):
                continue

            item_label = "scenario" if section_type == "attack_scenario" else "mitigation"
            entries.append(
                {
                    "section_type": section_type,
                    "section_identifier": f"{threat_name}::{item_label}_{index + 1}",
                    "threat_name": threat_name,
                    "original_content": original_value,
                    "corrected_content": corrected_value,
                    "correction_reason": LlmFeedbackService._build_manual_reason(
                        section_type, threat_name
                    ),
                    "error_type": "manual_correction",
                }
            )

        return entries

    @staticmethod
    def _build_diff_entries(
        *,
        previous_row: dict,
        app_name: str,
        application_description: str,
        selected_threats: list[dict],
        dfd_image_path: str | None,
        dfd_reference: str,
    ) -> list[dict]:
        entries: list[dict] = []

        previous_description = str(previous_row.get("application_description") or "").strip()
        if LlmFeedbackService._normalize_text(previous_description) != LlmFeedbackService._normalize_text(
            application_description
        ):
            entries.append(
                {
                    "section_type": "application_description",
                    "section_identifier": app_name or "application",
                    "threat_name": None,
                    "original_content": previous_description or "[vide]",
                    "corrected_content": application_description or "[vide]",
                    "correction_reason": LlmFeedbackService._build_manual_reason(
                        "application_description", None
                    ),
                    "error_type": "manual_correction",
                }
            )

        previous_dfd_payload = {
            "dfd_image_path": (previous_row.get("dfd_image_path") or "").strip() or None,
            "dfd_reference": str(previous_row.get("dfd_reference") or "").strip() or "DFD-01",
        }
        next_dfd_payload = {
            "dfd_image_path": (dfd_image_path or "").strip() or None,
            "dfd_reference": dfd_reference,
        }
        if previous_dfd_payload != next_dfd_payload:
            entries.append(
                {
                    "section_type": "dfd",
                    "section_identifier": "global_dfd",
                    "threat_name": None,
                    "original_content": json.dumps(previous_dfd_payload, ensure_ascii=False),
                    "corrected_content": json.dumps(next_dfd_payload, ensure_ascii=False),
                    "correction_reason": LlmFeedbackService._build_manual_reason("dfd", None),
                    "error_type": "manual_correction",
                }
            )

        previous_threats = previous_row.get("selected_threats") or []
        previous_by_name = {
            str(item.get("name") or "").strip().casefold(): item
            for item in previous_threats
            if str(item.get("name") or "").strip()
        }
        next_by_name = {
            str(item.get("name") or "").strip().casefold(): item
            for item in selected_threats
            if str(item.get("name") or "").strip()
        }

        for threat_key in sorted(set(previous_by_name) | set(next_by_name)):
            previous_threat = previous_by_name.get(threat_key)
            next_threat = next_by_name.get(threat_key)

            if not previous_threat and next_threat:
                threat_name = str(next_threat.get("name") or "").strip() or "menace"
                entries.append(
                    {
                        "section_type": "threat",
                        "section_identifier": threat_name,
                        "threat_name": threat_name,
                        "original_content": "[absent]",
                        "corrected_content": json.dumps(next_threat, ensure_ascii=False),
                        "correction_reason": LlmFeedbackService._build_manual_reason(
                            "threat", threat_name
                        ),
                        "error_type": "manual_correction",
                    }
                )
                continue

            if previous_threat and not next_threat:
                threat_name = str(previous_threat.get("name") or "").strip() or "menace"
                entries.append(
                    {
                        "section_type": "threat",
                        "section_identifier": threat_name,
                        "threat_name": threat_name,
                        "original_content": json.dumps(previous_threat, ensure_ascii=False),
                        "corrected_content": "[supprime par SecOps]",
                        "correction_reason": LlmFeedbackService._build_manual_reason(
                            "threat", threat_name
                        ),
                        "error_type": "manual_correction",
                    }
                )
                continue

            if not previous_threat or not next_threat:
                continue

            threat_name = str(next_threat.get("name") or previous_threat.get("name") or "").strip()
            previous_description_text = str(previous_threat.get("description") or "").strip()
            next_description_text = str(next_threat.get("description") or "").strip()
            if LlmFeedbackService._normalize_text(previous_description_text) != LlmFeedbackService._normalize_text(
                next_description_text
            ):
                entries.append(
                    {
                        "section_type": "threat",
                        "section_identifier": threat_name,
                        "threat_name": threat_name or None,
                        "original_content": previous_description_text or "[vide]",
                        "corrected_content": next_description_text or "[vide]",
                        "correction_reason": LlmFeedbackService._build_manual_reason(
                            "threat", threat_name
                        ),
                        "error_type": "manual_correction",
                    }
                )

            entries.extend(
                LlmFeedbackService._compare_text_lists(
                    section_type="attack_scenario",
                    threat_name=threat_name,
                    original_values=previous_threat.get("attack_scenarios") or [],
                    corrected_values=next_threat.get("attack_scenarios") or [],
                )
            )
            entries.extend(
                LlmFeedbackService._compare_text_lists(
                    section_type="mitigation",
                    threat_name=threat_name,
                    original_values=previous_threat.get("mitigations") or [],
                    corrected_values=next_threat.get("mitigations") or [],
                )
            )

        return entries

    @staticmethod
    def capture_report_corrections(
        *,
        report_id: str,
        previous_row: dict,
        next_version_number: int,
        app_name: str,
        application_description: str,
        selected_threats: list[dict],
        dfd_image_path: str | None,
        dfd_reference: str,
        actor: AuthenticatedUser,
        correction_reason: str | None = None,
        error_type: str = "manual_correction",
    ) -> list[LlmFeedbackResponse]:
        entries = LlmFeedbackService._build_diff_entries(
            previous_row=previous_row,
            app_name=app_name,
            application_description=application_description,
            selected_threats=selected_threats,
            dfd_image_path=dfd_image_path,
            dfd_reference=dfd_reference,
        )

        created_feedback: list[LlmFeedbackResponse] = []
        for entry in entries:
            row = LlmFeedbackRepository.create_feedback(
                report_id=report_id,
                report_version_number=next_version_number,
                section_type=entry["section_type"],
                section_identifier=entry.get("section_identifier"),
                threat_name=entry.get("threat_name"),
                original_content=entry["original_content"],
                corrected_content=entry["corrected_content"],
                correction_reason=correction_reason or entry.get("correction_reason"),
                error_type=error_type or entry["error_type"],
                actor=actor,
            )
            created_feedback.append(LlmFeedbackService._serialize_row(row))

        if created_feedback:
            logger.info(
                "Corrections SecOps memorisees: report_id=%s count=%s",
                report_id,
                len(created_feedback),
            )
        return created_feedback

    @staticmethod
    def build_prompt_memory(
        *,
        section_types: list[str],
        threat_names: list[str] | None = None,
        limit: int = 6,
    ) -> str:
        rows = LlmFeedbackRepository.list_feedback_for_prompt(
            section_types=section_types,
            threat_names=threat_names,
            limit=limit,
        )
        if not rows:
            return ""

        seen_keys: set[tuple[str, str, str]] = set()
        lines: list[str] = []

        for row in rows:
            label = LlmFeedbackService.SECTION_LABELS.get(row["section_type"], row["section_type"])
            original_content = LlmFeedbackService._truncate(row.get("original_content"))
            corrected_content = LlmFeedbackService._truncate(row.get("corrected_content"))
            reason = LlmFeedbackService._truncate(row.get("correction_reason"), limit=140)
            threat_name = str(row.get("threat_name") or "").strip()

            dedupe_key = (
                row["section_type"],
                original_content.casefold(),
                corrected_content.casefold(),
            )
            if dedupe_key in seen_keys:
                continue
            seen_keys.add(dedupe_key)

            threat_prefix = f" [{threat_name}]" if threat_name else ""
            line = (
                f"- {label}{threat_prefix}: eviter '{original_content}'. "
                f"Correction valide attendue: '{corrected_content}'."
            )
            if reason:
                line += f" Motif: {reason}."
            lines.append(line)

            if len(lines) >= limit:
                break

        if not lines:
            return ""

        return (
            "Retours d'experience SecOps a respecter absolument :\n"
            + "\n".join(lines)
        )

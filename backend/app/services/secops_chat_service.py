from __future__ import annotations

import json
import logging
from http import HTTPStatus
from typing import Any

from fastapi import HTTPException

from app.core.auth import AuthenticatedUser, user_has_role
from app.core.config import settings
from app.repositories.analysis_repository import AnalysisRepository
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.questionnaire_repository import QuestionnaireRepository
from app.repositories.report_repository import ReportRepository
from app.services.llm_clients import (
    LlmServiceBadRequestError,
    LlmGuardrailBlockedError,
    LlmServiceTimeoutError,
    LlmServiceUnavailableError,
    call_mistral,
    clean_text_response,
)
from app.services.report_management_service import ReportManagementService

logger = logging.getLogger(__name__)


class SecOpsChatService:
    GREETING_KEYWORDS = {"bonjour", "bonsoir", "salut", "hello", "hi", "salam", "coucou"}
    ALLOWED_KEYWORDS = {
        "menace", "menaces", "threat", "threats", "scenario", "scenarios", "scénario",
        "scénarios", "mitigation", "mitigations", "dfd", "flux", "attaque", "attaques",
        "risque", "risques", "security", "sécurité", "auth", "authentification",
        "questionnaire", "question", "option", "options", "choix", "expliquer",
        "explique", "comprendre", "rapport", "report", "application", "architecture",
    }
    TEMPORARY_UNAVAILABLE_REPLY = (
        "Le service SecOps est temporairement indisponible. Merci de reessayer."
    )
    OUT_OF_SCOPE_REPLY = (
        "Je suis limite au contexte SecOps: questionnaire, rapport, menaces, mitigations et DFD."
    )

    @staticmethod
    def _is_greeting(message: str) -> bool:
        return (message or "").strip().casefold() in SecOpsChatService.GREETING_KEYWORDS

    @staticmethod
    def _is_in_scope(message: str) -> bool:
        if not settings.SECOPS_CHAT_REQUIRE_SCOPE_ALLOWLIST:
            return True
        normalized = (message or "").casefold()
        return any(keyword in normalized for keyword in SecOpsChatService.ALLOWED_KEYWORDS)

    @staticmethod
    def _option(action_id: str, label: str, payload: dict | None = None) -> dict:
        return {"action_id": action_id, "label": label, "payload": payload or {}}

    @staticmethod
    def _group(title: str, options: list[dict]) -> dict:
        return {"title": title, "options": options}

    @staticmethod
    def _load_report_bundle(report_id: str, current_user: AuthenticatedUser) -> tuple[dict, dict | None]:
        report_row = ReportRepository.get_report_by_id(report_id)
        if not report_row:
            raise HTTPException(status_code=404, detail=ReportManagementService.REPORT_NOT_FOUND)

        if user_has_role(current_user, ReportManagementService.MANAGER_ROLE):
            ReportManagementService._ensure_manager_access_to_report(report_row, current_user)
        else:
            ReportManagementService._ensure_secops_access_to_report(report_row, current_user)

        return report_row, ReportRepository.get_report_results(report_id)

    @staticmethod
    def _list_accessible_reports(current_user: AuthenticatedUser) -> list[dict]:
        if user_has_role(current_user, ReportManagementService.MANAGER_ROLE):
            rows = [
                row for row in ReportRepository.list_reports()
                if row["status"] in ReportManagementService.MANAGER_VISIBLE_STATUSES
            ]
        else:
            rows = ReportRepository.list_reports(generated_by=str(current_user.user_id))
        return rows[:12]

    @staticmethod
    def _find_active_question(draft_context: dict[str, Any] | None) -> dict[str, Any] | None:
        if not draft_context:
            return None
        active_question = draft_context.get("active_question")
        return active_question if isinstance(active_question, dict) else None

    @staticmethod
    def _load_active_questionnaire() -> dict | None:
        return QuestionnaireRepository.get_active_questionnaire()

    @staticmethod
    def _find_question_in_questionnaire(questionnaire: dict | None, question_code: str) -> dict | None:
        for question in (questionnaire or {}).get("questions") or []:
            if str(question.get("code") or "").strip() == question_code:
                return question
        return None

    @staticmethod
    def _question_options_group(active_question: dict[str, Any]) -> dict | None:
        visible_options = active_question.get("visible_options") or []
        if not isinstance(visible_options, list) or not visible_options:
            return None

        return SecOpsChatService._group(
            "Options De La Question",
            [
                SecOpsChatService._option(
                    "QUESTION_OPTION_EXPLAIN",
                    str(option.get("label") or option.get("value") or "Option"),
                    {"option_value": str(option.get("value") or ""), "option_label": str(option.get("label") or "")},
                )
                for option in visible_options[:8]
                if str(option.get("label") or option.get("value") or "").strip()
            ],
        )

    @staticmethod
    def _build_main_menu(
        *,
        report_id: str | None,
        draft_context: dict[str, Any] | None,
        current_user: AuthenticatedUser,
    ) -> dict:
        groups: list[dict] = []
        active_question = SecOpsChatService._find_active_question(draft_context)

        groups.append(
            SecOpsChatService._group(
                "Options Generales",
                [
                    SecOpsChatService._option("GENERAL_THREAT_ENTRY", "Comprendre une menace"),
                    SecOpsChatService._option("GENERAL_REPORTS_MENU", "Rapports generes"),
                    SecOpsChatService._option("GENERAL_QUESTIONNAIRE_MENU", "Questionnaire"),
                ],
            )
        )

        if active_question:
            question_number = str(active_question.get("number") or active_question.get("code") or "question")
            groups.append(
                SecOpsChatService._group(
                    "Aide Questionnaire",
                    [
                        SecOpsChatService._option("QUESTION_EXPLAIN", f"Comprendre {question_number}"),
                        SecOpsChatService._option("QUESTION_FILL_HELP", "Que faut-il renseigner ?"),
                        SecOpsChatService._option("QUESTION_OPTIONS_MENU", "Comprendre les options"),
                    ],
                )
            )
            options_group = SecOpsChatService._question_options_group(active_question)
            if options_group:
                groups.append(options_group)

        if report_id:
            report_row, report_results = SecOpsChatService._load_report_bundle(report_id, current_user)
            app_name = (
                str((report_results or {}).get("app_name") or report_row.get("title") or "Application").strip()
            )
            groups.append(
                SecOpsChatService._group(
                    f"Rapport {app_name}",
                    [
                        SecOpsChatService._option("REPORT_SUMMARY", "Resumer le rapport"),
                        SecOpsChatService._option("REPORT_APP_EXPLAIN", "Comprendre l'application"),
                        SecOpsChatService._option("REPORT_DFD_EXPLAIN", "Comprendre le DFD"),
                        SecOpsChatService._option("REPORT_THREAT_MENU", "Comprendre une menace"),
                    ],
                )
            )

            selected_threats = (report_results or {}).get("selected_threats") or []
            if selected_threats:
                groups.append(
                    SecOpsChatService._group(
                        "Menaces Du Rapport",
                        [
                            SecOpsChatService._option(
                                "THREAT_MENU",
                                str(threat.get("name") or "Menace"),
                                {"threat_name": str(threat.get("name") or "")},
                            )
                            for threat in selected_threats[:10]
                            if str(threat.get("name") or "").strip()
                        ],
                    )
                )

        accessible_reports = SecOpsChatService._list_accessible_reports(current_user)
        if accessible_reports:
            groups.append(
                SecOpsChatService._group(
                    "Rapports Disponibles",
                    [
                        SecOpsChatService._option(
                            "REPORT_SELECT",
                            str(report.get("title") or report.get("app_name") or "Rapport").strip(),
                            {"report_id": str(report.get("id") or "")},
                        )
                        for report in accessible_reports
                        if str(report.get("id") or "").strip()
                    ],
                )
            )

        return {
            "reply": "Commencez par choisir une option generale.",
            "option_groups": groups,
        }

    @staticmethod
    def _reply_question_explain(active_question: dict[str, Any]) -> dict:
        label = str(active_question.get("label") or "Cette question").strip()
        aide = str(active_question.get("aide") or active_question.get("help_text") or "").strip()
        question_type = str(active_question.get("question_type") or "").strip()
        reply = f"{label}. {aide}" if aide else f"{label}. Cette question sert a qualifier le contexte securite."
        if question_type:
            reply += f" Type attendu: {question_type}."
        return {"reply": reply, "option_groups": []}

    @staticmethod
    def _reply_questionnaire_question_explain(question: dict[str, Any]) -> dict:
        label = str(question.get("label") or "Cette question").strip()
        aide = str(question.get("aide") or question.get("help_text") or "").strip()
        question_type = str(question.get("question_type") or "").strip()
        visible_options = question.get("options") or []

        groups: list[dict] = []
        if visible_options:
            groups.append(
                SecOpsChatService._group(
                    "Options De La Question",
                    [
                        SecOpsChatService._option(
                            "QUESTIONNAIRE_OPTION_EXPLAIN",
                            str(option.get("label") or option.get("value") or "Option"),
                            {
                                "question_code": str(question.get("code") or ""),
                                "option_value": str(option.get("value") or ""),
                                "option_label": str(option.get("label") or ""),
                            },
                        )
                        for option in visible_options[:8]
                        if str(option.get("label") or option.get("value") or "").strip()
                    ],
                )
            )

        reply = f"{label}. {aide}" if aide else f"{label}. Cette question sert a qualifier le contexte."
        if question_type:
          reply += f" Type: {question_type}."
        return {"reply": reply, "option_groups": groups}

    @staticmethod
    def _reply_question_fill_help(active_question: dict[str, Any]) -> dict:
        label = str(active_question.get("label") or "Cette question").strip()
        visible_options = active_question.get("visible_options") or []
        if visible_options:
            option_labels = ", ".join(
                str(option.get("label") or option.get("value") or "").strip()
                for option in visible_options[:5]
                if str(option.get("label") or option.get("value") or "").strip()
            )
            reply = f"Pour {label}, choisissez l option qui correspond le mieux au cas reel. Options visibles: {option_labels}."
        else:
            reply = f"Pour {label}, renseignez une valeur concrete et fidele a l application."
        return {"reply": reply, "option_groups": []}

    @staticmethod
    def _reply_question_options_menu(active_question: dict[str, Any]) -> dict:
        group = SecOpsChatService._question_options_group(active_question)
        if not group:
            return {"reply": "Cette question n a pas d options visibles a expliquer.", "option_groups": []}
        return {
            "reply": "Choisissez l option a expliquer.",
            "option_groups": [group],
        }

    @staticmethod
    def _reply_question_option_explain(
        *,
        draft_context: dict[str, Any] | None,
        option_value: str,
        option_label: str,
    ) -> dict:
        active_question = SecOpsChatService._find_active_question(draft_context)
        if not active_question:
            return {"reply": "Aucune question active n est disponible.", "option_groups": []}

        questionnaire_code = str((draft_context or {}).get("questionnaire_code") or "").strip()
        question_code = str(active_question.get("code") or "").strip()
        option_candidates = [option_value, option_label]
        context_rows = (
            AnalysisRepository.get_answer_context_entries(
                questionnaire_code=questionnaire_code,
                question_code=question_code,
                option_values=option_candidates,
            )
            if questionnaire_code and question_code
            else []
        )
        explanation = ""
        if context_rows:
            explanation = str(context_rows[0].get("llm_sentence") or "").strip()
        if not explanation:
            explanation = f"L option {option_label or option_value} represente le cas correspondant a votre architecture."
        return {"reply": explanation, "option_groups": []}

    @staticmethod
    def _reply_questionnaire_option_explain(
        *,
        question: dict[str, Any] | None,
        option_value: str,
        option_label: str,
    ) -> dict:
        if not question:
            return {"reply": "Cette question est introuvable dans le questionnaire actif.", "option_groups": []}

        option_candidates = [option_value, option_label]
        questionnaire_code = str((question.get("questionnaire_code") or "")).strip()
        question_code = str(question.get("code") or "").strip()
        context_rows = (
            AnalysisRepository.get_answer_context_entries(
                questionnaire_code=questionnaire_code,
                question_code=question_code,
                option_values=option_candidates,
            )
            if questionnaire_code and question_code
            else []
        )
        explanation = ""
        if context_rows:
            explanation = str(context_rows[0].get("llm_sentence") or "").strip()
        if not explanation:
            explanation = f"L option {option_label or option_value} correspond au cas que vous voulez declarer dans le questionnaire."
        return {"reply": explanation, "option_groups": []}

    @staticmethod
    def _find_report_threat(report_results: dict | None, threat_name: str) -> dict | None:
        for threat in (report_results or {}).get("selected_threats") or []:
            if str(threat.get("name") or "").strip() == threat_name:
                return threat
        return None

    @staticmethod
    def _reply_report_summary(report_row: dict, report_results: dict | None) -> dict:
        app_name = str((report_results or {}).get("app_name") or report_row.get("title") or "Application").strip()
        description = str((report_results or {}).get("application_description") or report_row.get("description") or "").strip()
        threat_count = len((report_results or {}).get("selected_threats") or [])
        reply = f"Le rapport {app_name} contient {threat_count} menace(s). {description[:220]}".strip()
        return {"reply": reply, "option_groups": []}

    @staticmethod
    def _reply_report_app_explain(report_row: dict, report_results: dict | None) -> dict:
        description = str((report_results or {}).get("application_description") or report_row.get("description") or "").strip()
        return {"reply": description or "La description applicative n est pas disponible.", "option_groups": []}

    @staticmethod
    def _reply_report_dfd_explain(report_results: dict | None) -> dict:
        dfd_reference = str((report_results or {}).get("dfd_reference") or "DFD-01").strip()
        reply = f"Le DFD de reference est {dfd_reference}. Il sert a visualiser les composants, les flux et les frontieres de confiance du rapport."
        return {"reply": reply, "option_groups": []}

    @staticmethod
    def _reply_report_threat_menu(report_results: dict | None) -> dict:
        selected_threats = (report_results or {}).get("selected_threats") or []
        if not selected_threats:
            return {"reply": "Aucune menace n est disponible dans ce rapport.", "option_groups": []}
        return {
            "reply": "Choisissez la menace que vous voulez comprendre.",
            "option_groups": [
                SecOpsChatService._group(
                    "Menaces Du Rapport",
                    [
                        SecOpsChatService._option(
                            "THREAT_MENU",
                            str(threat.get("name") or "Menace"),
                            {"threat_name": str(threat.get("name") or "")},
                        )
                        for threat in selected_threats[:12]
                        if str(threat.get("name") or "").strip()
                    ],
                )
            ],
        }

    @staticmethod
    def _reply_report_select(report_id: str, current_user: AuthenticatedUser) -> dict:
        report_row, report_results = SecOpsChatService._load_report_bundle(report_id, current_user)
        app_name = str((report_results or {}).get("app_name") or report_row.get("title") or "Application").strip()
        selected_threats = (report_results or {}).get("selected_threats") or []
        groups = [
            SecOpsChatService._group(
                f"Rapport {app_name}",
                [
                    SecOpsChatService._option("REPORT_SUMMARY", "Resumer le rapport", {"report_id": report_id}),
                    SecOpsChatService._option("REPORT_APP_EXPLAIN", "Comprendre l'application", {"report_id": report_id}),
                    SecOpsChatService._option("REPORT_DFD_EXPLAIN", "Comprendre le DFD", {"report_id": report_id}),
                    SecOpsChatService._option("REPORT_THREAT_MENU", "Comprendre une menace", {"report_id": report_id}),
                ],
            )
        ]
        if selected_threats:
            groups.append(
                SecOpsChatService._group(
                    "Menaces Du Rapport",
                    [
                        SecOpsChatService._option(
                            "THREAT_MENU",
                            str(threat.get("name") or "Menace"),
                            {"report_id": report_id, "threat_name": str(threat.get("name") or "")},
                        )
                        for threat in selected_threats[:10]
                        if str(threat.get("name") or "").strip()
                    ],
                )
            )
        return {
            "reply": f"Rapport {app_name} charge. Choisissez ce que vous voulez comprendre.",
            "option_groups": groups,
        }

    @staticmethod
    def _reply_reports_menu(current_user: AuthenticatedUser) -> dict:
        accessible_reports = SecOpsChatService._list_accessible_reports(current_user)
        if not accessible_reports:
            return {"reply": "Aucun rapport disponible pour le moment.", "option_groups": []}
        return {
            "reply": "Choisissez un rapport genere.",
            "option_groups": [
                SecOpsChatService._group(
                    "Rapports Generes",
                    [
                        SecOpsChatService._option(
                            "REPORT_SELECT",
                            str(report.get("title") or report.get("app_name") or "Rapport").strip(),
                            {"report_id": str(report.get("id") or "")},
                        )
                        for report in accessible_reports
                        if str(report.get("id") or "").strip()
                    ],
                )
            ],
        }

    @staticmethod
    def _reply_general_threat_entry(current_user: AuthenticatedUser) -> dict:
        accessible_reports = SecOpsChatService._list_accessible_reports(current_user)
        if not accessible_reports:
            return {"reply": "Aucun rapport disponible pour explorer les menaces.", "option_groups": []}
        return {
            "reply": "Pour comprendre une menace, choisissez d abord un rapport.",
            "option_groups": [
                SecOpsChatService._group(
                    "Rapports Avec Menaces",
                    [
                        SecOpsChatService._option(
                            "REPORT_SELECT",
                            str(report.get("title") or "Rapport").strip(),
                            {"report_id": str(report.get("id") or "")},
                        )
                        for report in accessible_reports
                        if str(report.get("id") or "").strip()
                    ],
                )
            ],
        }

    @staticmethod
    def _reply_questionnaire_menu(draft_context: dict[str, Any] | None) -> dict:
        active_question = SecOpsChatService._find_active_question(draft_context)
        if active_question:
            question_number = str(active_question.get("number") or active_question.get("code") or "question")
            groups = [
                SecOpsChatService._group(
                    "Question Active",
                    [
                        SecOpsChatService._option("QUESTION_EXPLAIN", f"Comprendre {question_number}"),
                        SecOpsChatService._option("QUESTION_FILL_HELP", "Que faut-il renseigner ?"),
                        SecOpsChatService._option("QUESTION_OPTIONS_MENU", "Comprendre les options"),
                    ],
                )
            ]
            return {"reply": "Voici l aide disponible sur la question en cours.", "option_groups": groups}

        questionnaire = SecOpsChatService._load_active_questionnaire()
        if not questionnaire:
            return {"reply": "Aucun questionnaire actif n est disponible.", "option_groups": []}

        question_options = []
        sorted_questions = sorted(
            questionnaire.get("questions") or [],
            key=lambda question: (question.get("step_id") or 0, question.get("display_order") or 0),
        )
        for question in sorted_questions[:12]:
            question_options.append(
                SecOpsChatService._option(
                    "QUESTIONNAIRE_QUESTION_SELECT",
                    str(question.get("label") or question.get("code") or "Question").strip(),
                    {"question_code": str(question.get("code") or "")},
                )
            )

        return {
            "reply": "Choisissez une question du questionnaire a comprendre.",
            "option_groups": [SecOpsChatService._group("Questions Du Questionnaire", question_options)],
        }

    @staticmethod
    def _reply_threat_menu(report_results: dict | None, threat_name: str) -> dict:
        threat = SecOpsChatService._find_report_threat(report_results, threat_name)
        if not threat:
            return {"reply": "Cette menace est introuvable dans le rapport.", "option_groups": []}
        return {
            "reply": f"Choisissez ce que vous voulez comprendre sur {threat_name}.",
            "option_groups": [
                SecOpsChatService._group(
                    "Actions Sur La Menace",
                    [
                        SecOpsChatService._option("THREAT_WHY", "Pourquoi retenue ?", {"threat_name": threat_name}),
                        SecOpsChatService._option("THREAT_SCENARIOS", "Voir les scenarios", {"threat_name": threat_name}),
                        SecOpsChatService._option("THREAT_MITIGATIONS", "Voir les mitigations", {"threat_name": threat_name}),
                        SecOpsChatService._option("THREAT_SUMMARY", "Resume simple", {"threat_name": threat_name}),
                    ],
                )
            ],
        }

    @staticmethod
    def _reply_threat_why(report_results: dict | None, threat_name: str) -> dict:
        threat = SecOpsChatService._find_report_threat(report_results, threat_name)
        if not threat:
            return {"reply": "Cette menace est introuvable dans le rapport.", "option_groups": []}
        description = str(threat.get("description") or "").strip()
        reply = description or f"La menace {threat_name} a ete retenue car elle est coherente avec l architecture et les flux du rapport."
        return {"reply": reply, "option_groups": []}

    @staticmethod
    def _reply_threat_scenarios(report_results: dict | None, threat_name: str) -> dict:
        threat = SecOpsChatService._find_report_threat(report_results, threat_name)
        scenarios = (threat or {}).get("attack_scenarios") or []
        if not scenarios:
            return {"reply": "Aucun scenario n est disponible pour cette menace.", "option_groups": []}
        reply = "Scenarios: " + " | ".join(str(item).strip() for item in scenarios[:3] if str(item).strip())
        return {"reply": reply, "option_groups": []}

    @staticmethod
    def _reply_threat_mitigations(report_results: dict | None, threat_name: str) -> dict:
        threat = SecOpsChatService._find_report_threat(report_results, threat_name)
        mitigations = (threat or {}).get("mitigations") or []
        if not mitigations:
            return {"reply": "Aucune mitigation n est disponible pour cette menace.", "option_groups": []}
        reply = "Mitigations: " + " | ".join(str(item).strip() for item in mitigations[:3] if str(item).strip())
        return {"reply": reply, "option_groups": []}

    @staticmethod
    def _reply_threat_summary(report_results: dict | None, threat_name: str) -> dict:
        threat = SecOpsChatService._find_report_threat(report_results, threat_name)
        if not threat:
            return {"reply": "Cette menace est introuvable dans le rapport.", "option_groups": []}
        description = str(threat.get("description") or "").strip()
        reply = f"{threat_name}: {description}" if description else f"{threat_name}: risque a surveiller dans ce rapport."
        return {"reply": reply, "option_groups": []}

    @staticmethod
    def _build_catalog_context(limit: int = 18) -> str:
        threats = CatalogRepository.list_threats_for_analysis()
        if not threats:
            return "Aucune menace disponible."
        return json.dumps(
            [
                {
                    "name": str(threat.get("nom_menace") or "").strip(),
                    "description": str(threat.get("description") or "").strip(),
                }
                for threat in threats[:limit]
            ],
            ensure_ascii=False,
            indent=2,
        )

    @staticmethod
    def _build_runtime_context(
        *,
        current_user: AuthenticatedUser,
        report_id: str | None,
        draft_context: dict[str, Any] | None,
    ) -> str:
        sections: list[str] = []
        if report_id:
            report_row, report_results = SecOpsChatService._load_report_bundle(report_id, current_user)
            sections.append(
                f"Rapport courant: {str((report_results or {}).get('app_name') or report_row.get('title') or 'Application').strip()}"
            )
        active_question = SecOpsChatService._find_active_question(draft_context)
        if active_question:
            sections.append(
                f"Question active: {str(active_question.get('label') or active_question.get('code') or 'Question').strip()}"
            )
        if not sections:
            return "Aucun contexte detaille disponible."
        return "\n".join(sections)

    @staticmethod
    def _reply_free_prompt(
        *,
        message: str,
        current_user: AuthenticatedUser,
        report_id: str | None,
        draft_context: dict[str, Any] | None,
        force_general_mode: bool = False,
    ) -> dict:
        user_message = (message or "").strip()
        if not user_message:
            return SecOpsChatService._build_main_menu(
                report_id=report_id,
                draft_context=draft_context,
                current_user=current_user,
            )
        if force_general_mode or settings.SECOPS_CHAT_GENERAL_MODE:
            return SecOpsChatService._reply_general_prompt(
                message=user_message,
                current_user=current_user,
                report_id=report_id,
                draft_context=draft_context,
            )
        if SecOpsChatService._is_greeting(user_message):
            return {
                "reply": "Bonjour. Choisissez une aide questionnaire, rapport ou menace.",
                "option_groups": SecOpsChatService._build_main_menu(
                    report_id=report_id,
                    draft_context=draft_context,
                    current_user=current_user,
                )["option_groups"],
            }
        if not SecOpsChatService._is_in_scope(user_message):
            return {"reply": SecOpsChatService.OUT_OF_SCOPE_REPLY, "option_groups": []}

        lowered = user_message.casefold()
        if not report_id and "menace" in lowered:
            return SecOpsChatService._reply_general_threat_entry(current_user)
        if not report_id and "rapport" in lowered:
            return SecOpsChatService._reply_reports_menu(current_user)
        if "questionnaire" in lowered or "question" in lowered:
            return SecOpsChatService._reply_questionnaire_menu(draft_context)

        runtime_context = SecOpsChatService._build_runtime_context(
            current_user=current_user,
            report_id=report_id,
            draft_context=draft_context,
        )
        prompt = (
            "Tu es ASTORIA Guard.\n"
            "Reponds en francais, tres court, 2 a 4 phrases max.\n"
            "Si le contexte contient une question active, priorise son explication.\n"
            "Si le contexte contient un rapport, reste aligne avec lui.\n"
            "Pas de markdown brut visible.\n\n"
            f"Contexte:\n{runtime_context}\n\n"
            f"Catalogue minimal:\n{SecOpsChatService._build_catalog_context()}\n\n"
            f"Question:\n{user_message}\n"
        )
        try:
            return {"reply": clean_text_response(call_mistral(prompt)), "option_groups": []}
        except LlmGuardrailBlockedError:
            raise
        except LlmServiceBadRequestError:
            raise
        except LlmServiceTimeoutError:
            logger.warning("Timeout Mistral pendant une reponse SecOps", extra={"http_status": HTTPStatus.GATEWAY_TIMEOUT})
            return {"reply": "Le service SecOps met trop de temps a repondre.", "option_groups": []}
        except LlmServiceUnavailableError:
            logger.warning("Service Mistral indisponible pendant une reponse SecOps", extra={"http_status": HTTPStatus.BAD_GATEWAY})
            return {"reply": SecOpsChatService.TEMPORARY_UNAVAILABLE_REPLY, "option_groups": []}
        except Exception:
            logger.exception("Echec reponse chatbot SecOps")
            return {"reply": SecOpsChatService.TEMPORARY_UNAVAILABLE_REPLY, "option_groups": []}

    @staticmethod
    def _reply_general_prompt(
        *,
        message: str,
        current_user: AuthenticatedUser,
        report_id: str | None,
        draft_context: dict[str, Any] | None,
    ) -> dict:
        runtime_context = SecOpsChatService._build_runtime_context(
            current_user=current_user,
            report_id=report_id,
            draft_context=draft_context,
        )
        prompt = (
            "Tu es ASTORIA Guard, un assistant conversationnel generaliste.\n"
            "Reponds en francais de facon naturelle, claire et utile.\n"
            "Si un contexte applicatif est fourni, utilise-le seulement s il est pertinent.\n"
            "N invente pas des faits specifiques si l information manque.\n"
            "Pas de markdown brut visible.\n\n"
            f"Contexte optionnel:\n{runtime_context}\n\n"
            f"Message utilisateur:\n{message}\n"
        )
        try:
            return {"reply": clean_text_response(call_mistral(prompt)), "option_groups": []}
        except LlmGuardrailBlockedError:
            raise
        except LlmServiceBadRequestError:
            raise
        except LlmServiceTimeoutError:
            logger.warning("Timeout Mistral pendant une reponse chatbot general", extra={"http_status": HTTPStatus.GATEWAY_TIMEOUT})
            return {"reply": "Le chatbot met trop de temps a repondre.", "option_groups": []}
        except LlmServiceUnavailableError:
            logger.warning("Service Mistral indisponible pendant une reponse chatbot general", extra={"http_status": HTTPStatus.BAD_GATEWAY})
            return {"reply": SecOpsChatService.TEMPORARY_UNAVAILABLE_REPLY, "option_groups": []}
        except Exception:
            logger.exception("Echec reponse chatbot general")
            return {"reply": SecOpsChatService.TEMPORARY_UNAVAILABLE_REPLY, "option_groups": []}

    @staticmethod
    def respond(
        *,
        message: str,
        current_user: AuthenticatedUser,
        report_id: str | None = None,
        draft_context: dict[str, Any] | None = None,
        chat_mode: str | None = None,
        action_id: str | None = None,
        action_payload: dict[str, Any] | None = None,
    ) -> dict:
        action = str(action_id or "").strip().upper()
        normalized_chat_mode = str(chat_mode or "").strip().lower()
        force_general_mode = normalized_chat_mode == "normal"
        payload = action_payload or {}
        effective_report_id = str(payload.get("report_id") or report_id or "").strip() or None
        active_question = SecOpsChatService._find_active_question(draft_context)
        report_row = report_results = None
        if effective_report_id:
            report_row, report_results = SecOpsChatService._load_report_bundle(effective_report_id, current_user)

        if force_general_mode and action == "SHOW_MAIN_MENU":
            return {
                "reply": "Mode chat normal active. Posez votre question librement.",
                "option_groups": [],
            }
        if force_general_mode and action == "":
            return SecOpsChatService._reply_free_prompt(
                message=message,
                current_user=current_user,
                report_id=effective_report_id,
                draft_context=draft_context,
                force_general_mode=True,
            )
        if action in {"", "SHOW_MAIN_MENU"}:
            return SecOpsChatService._build_main_menu(
                report_id=effective_report_id,
                draft_context=draft_context,
                current_user=current_user,
            )
        if action == "GENERAL_THREAT_ENTRY":
            return SecOpsChatService._reply_general_threat_entry(current_user)
        if action == "GENERAL_REPORTS_MENU":
            return SecOpsChatService._reply_reports_menu(current_user)
        if action == "GENERAL_QUESTIONNAIRE_MENU":
            return SecOpsChatService._reply_questionnaire_menu(draft_context)
        if action == "QUESTION_EXPLAIN" and active_question:
            return SecOpsChatService._reply_question_explain(active_question)
        if action == "QUESTION_FILL_HELP" and active_question:
            return SecOpsChatService._reply_question_fill_help(active_question)
        if action == "QUESTION_OPTIONS_MENU" and active_question:
            return SecOpsChatService._reply_question_options_menu(active_question)
        if action == "QUESTION_OPTION_EXPLAIN":
            return SecOpsChatService._reply_question_option_explain(
                draft_context=draft_context,
                option_value=str(payload.get("option_value") or "").strip(),
                option_label=str(payload.get("option_label") or "").strip(),
            )
        if action == "QUESTIONNAIRE_QUESTION_SELECT":
            questionnaire = SecOpsChatService._load_active_questionnaire()
            question = SecOpsChatService._find_question_in_questionnaire(
                questionnaire,
                str(payload.get("question_code") or "").strip(),
            )
            if question and questionnaire:
                question = {
                    **question,
                    "questionnaire_code": str(questionnaire.get("code") or "").strip(),
                }
            return SecOpsChatService._reply_questionnaire_question_explain(question or {})
        if action == "QUESTIONNAIRE_OPTION_EXPLAIN":
            questionnaire = SecOpsChatService._load_active_questionnaire()
            question = SecOpsChatService._find_question_in_questionnaire(
                questionnaire,
                str(payload.get("question_code") or "").strip(),
            )
            if question and questionnaire:
                question = {
                    **question,
                    "questionnaire_code": str(questionnaire.get("code") or "").strip(),
                }
            return SecOpsChatService._reply_questionnaire_option_explain(
                question=question,
                option_value=str(payload.get("option_value") or "").strip(),
                option_label=str(payload.get("option_label") or "").strip(),
            )
        if action == "REPORT_SUMMARY" and report_row:
            return SecOpsChatService._reply_report_summary(report_row, report_results)
        if action == "REPORT_APP_EXPLAIN" and report_row:
            return SecOpsChatService._reply_report_app_explain(report_row, report_results)
        if action == "REPORT_DFD_EXPLAIN":
            return SecOpsChatService._reply_report_dfd_explain(report_results)
        if action == "REPORT_SELECT" and effective_report_id:
            return SecOpsChatService._reply_report_select(effective_report_id, current_user)
        if action == "REPORT_THREAT_MENU":
            return SecOpsChatService._reply_report_threat_menu(report_results)
        if action == "THREAT_MENU":
            return SecOpsChatService._reply_threat_menu(report_results, str(payload.get("threat_name") or "").strip())
        if action == "THREAT_WHY":
            return SecOpsChatService._reply_threat_why(report_results, str(payload.get("threat_name") or "").strip())
        if action == "THREAT_SCENARIOS":
            return SecOpsChatService._reply_threat_scenarios(report_results, str(payload.get("threat_name") or "").strip())
        if action == "THREAT_MITIGATIONS":
            return SecOpsChatService._reply_threat_mitigations(report_results, str(payload.get("threat_name") or "").strip())
        if action == "THREAT_SUMMARY":
            return SecOpsChatService._reply_threat_summary(report_results, str(payload.get("threat_name") or "").strip())

        return SecOpsChatService._reply_free_prompt(
            message=message,
            current_user=current_user,
            report_id=effective_report_id,
            draft_context=draft_context,
            force_general_mode=force_general_mode,
        )

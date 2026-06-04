from __future__ import annotations

import json
import logging
from http import HTTPStatus
from typing import Any

from fastapi import HTTPException

from app.core.auth import AuthenticatedUser, user_has_role
from app.repositories.analysis_repository import AnalysisRepository
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.questionnaire_repository import QuestionnaireRepository
from app.repositories.report_repository import ReportRepository
from app.services.llm_clients import (
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
        "commencer", "démarrer", "lancer", "nouvelle", "analyser", "analyse",
        "historique", "dashboard", "tableau", "naviguer", "accéder", "trouver",
        "aide", "guide", "comment", "utiliser", "faire",
    }

    GUIDE_ANALYSIS_KEYWORDS = {"commencer", "demarrer", "lancer", "nouvelle analyse", "comment analyser", "faire une analyse", "comment faire"}
    GUIDE_HISTORY_KEYWORDS = {"historique", "mes rapports", "voir mes analyses", "rapports precedents"}
    TOUR_KEYWORDS = {"guide complet", "tout montrer", "montre-moi tout", "tutoriel", "premiers pas", "je suis nouveau", "apprends-moi", "tour"}
    GUIDE_DASHBOARD_KEYWORDS = {"dashboard", "tableau de bord", "accueil", "page principale"}
    TEMPORARY_UNAVAILABLE_REPLY = (
        "Le service SecOps est temporairement indisponible. Merci de reessayer."
    )
    OUT_OF_SCOPE_REPLY = (
        "Je suis limite au contexte SecOps: questionnaire, rapport, menaces, mitigations et DFD."
    )
    GUARDRAIL_BLOCKED_REPLY = (
        "Cette demande ne peut pas etre traitee en raison des politiques de securite."
    )

    @staticmethod
    def _is_greeting(message: str) -> bool:
        return (message or "").strip().casefold() in SecOpsChatService.GREETING_KEYWORDS

    @staticmethod
    def _is_in_scope(message: str) -> bool:
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
        aide = str(active_question.get("aide") or active_question.get("help_text") or "").strip()
        label = str(active_question.get("label") or "Cette question").strip()
        reply = aide if aide else f"{label} — Cette question sert a qualifier le contexte securite."
        return {"reply": reply, "option_groups": []}

    @staticmethod
    def _reply_questionnaire_question_explain(question: dict[str, Any]) -> dict:
        aide = str(question.get("aide") or question.get("help_text") or "").strip()
        label = str(question.get("label") or "Cette question").strip()
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

        reply = aide if aide else f"{label} — Cette question sert a qualifier le contexte de securite."
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
            "reply": f"Rapport \"{app_name}\" chargé. Choisissez ce que vous voulez comprendre.",
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

    SECTION_LABELS: dict[str, str] = {
        "dashboard": "Tableau de bord",
        "analysis": "Nouvelle analyse",
        "history": "Historique des rapports",
    }

    VIEW_STATE_LABELS: dict[str, str] = {
        "form": "Remplissage du questionnaire",
        "loading": "Analyse en cours de traitement",
        "report": "Consultation du rapport genere",
        "report_editor": "Edition des resultats du rapport",
        "error": "Erreur lors de l'analyse",
    }

    @staticmethod
    def _build_runtime_context(
        *,
        current_user: AuthenticatedUser,
        report_id: str | None,
        draft_context: dict[str, Any] | None,
        current_section: str | None = None,
        view_state: str | None = None,
    ) -> str:
        sections: list[str] = []

        if current_section:
            label = SecOpsChatService.SECTION_LABELS.get(current_section, current_section)
            sections.append(f"Section active: {label}")

        if view_state:
            label = SecOpsChatService.VIEW_STATE_LABELS.get(view_state, view_state)
            sections.append(f"Etat de la vue: {label}")

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
    def _reply_tour_menu() -> dict:
        return {
            "reply": "Je peux vous guider pas à pas. Choisissez un guide :",
            "option_groups": [
                SecOpsChatService._group(
                    "Guides disponibles",
                    [
                        SecOpsChatService._option("TOUR_ANALYSE", "Faire une nouvelle analyse"),
                        SecOpsChatService._option("TOUR_HISTORY", "Consulter l'historique"),
                        SecOpsChatService._option("TOUR_DASHBOARD", "Comprendre le Dashboard"),
                    ],
                )
            ],
        }

    @staticmethod
    def _detect_tour_intent(message: str) -> bool:
        lowered = message.casefold()
        return any(kw in lowered for kw in SecOpsChatService.TOUR_KEYWORDS)

    @staticmethod
    def _detect_guide_target(message: str) -> str | None:
        lowered = message.casefold()
        if any(kw in lowered for kw in SecOpsChatService.GUIDE_ANALYSIS_KEYWORDS):
            return "analysis"
        if any(kw in lowered for kw in SecOpsChatService.GUIDE_HISTORY_KEYWORDS):
            return "history"
        if any(kw in lowered for kw in SecOpsChatService.GUIDE_DASHBOARD_KEYWORDS):
            return "dashboard"
        return None

    @staticmethod
    def _reply_guide(target: str) -> dict:
        guides = {
            "analysis": (
                "Pour lancer une nouvelle analyse, ouvre le menu de navigation et clique sur \"Nouvelle analyse\". "
                "Tu pourras ensuite remplir le questionnaire décrivant ton application.",
                "GUIDE_HIGHLIGHT_ANALYSIS",
                "Me montrer Nouvelle analyse",
            ),
            "history": (
                "L'historique de tes rapports est accessible via le menu de navigation, section \"Historique\". "
                "Tu y retrouves tous tes rapports générés avec leur statut.",
                "GUIDE_HIGHLIGHT_HISTORY",
                "Me montrer l'Historique",
            ),
            "dashboard": (
                "Le tableau de bord est la page d'accueil de l'application. "
                "Tu peux y accéder via le menu de navigation, section \"Dashboard\".",
                "GUIDE_HIGHLIGHT_DASHBOARD",
                "Me montrer le Dashboard",
            ),
        }
        reply_text, action_id, label = guides.get(target, guides["analysis"])
        return {
            "reply": reply_text,
            "option_groups": [
                SecOpsChatService._group(
                    "Navigation guidée",
                    [SecOpsChatService._option(action_id, label)],
                )
            ],
        }

    @staticmethod
    def _build_faq_response(faq: dict) -> dict:
        answer = faq.get("answer", "")
        action_id = faq.get("action_id")
        action_label = faq.get("action_label")

        if action_id == "SHOW_TOURS":
            return {
                "reply": answer,
                "option_groups": [
                    SecOpsChatService._group(
                        "Guides disponibles",
                        [
                            SecOpsChatService._option("TOUR_ANALYSE", "Faire une nouvelle analyse"),
                            SecOpsChatService._option("TOUR_HISTORY", "Consulter l'historique"),
                            SecOpsChatService._option("TOUR_DASHBOARD", "Comprendre le Dashboard"),
                        ],
                    )
                ],
            }
        if action_id:
            return {
                "reply": answer,
                "option_groups": [
                    SecOpsChatService._group(
                        "Guide interactif",
                        [SecOpsChatService._option(action_id, action_label or "Me montrer")],
                    )
                ],
            }
        return {"reply": answer, "option_groups": []}

    @staticmethod
    def _format_history(history: list[dict]) -> str:
        if not history:
            return ""
        lines = ["Historique de la conversation (contexte):"]
        for msg in history[-6:]:
            role = "Utilisateur" if msg.get("role") == "user" else "Assistant"
            lines.append(f"{role}: {str(msg.get('content') or '').strip()}")
        return "\n".join(lines)

    @staticmethod
    def _reply_regulatory_menu() -> dict:
        from app.services.regulatory_service import list_documents
        docs = [d for d in list_documents() if d.get("status") == "indexed"]
        if not docs:
            return {
                "reply": "Aucun document reglementaire n'est encore disponible. L'administrateur doit d'abord en uploader dans la section 'Base reglementaire'.",
                "option_groups": [],
            }
        return {
            "reply": "Voici les documents reglementaires disponibles. Sur lequel souhaitez-vous des informations ?",
            "option_groups": [
                SecOpsChatService._group(
                    "Documents disponibles",
                    [
                        SecOpsChatService._option(
                            "REGULATORY_DOC_QUERY",
                            str(doc["display_name"]),
                            {"doc_name": str(doc["display_name"]), "doc_id": doc["id"]},
                        )
                        for doc in docs[:10]
                    ],
                )
            ],
        }

    @staticmethod
    def _reply_regulatory_doc_entry(doc_name: str, doc_id: Any) -> dict:
        if not doc_name:
            return {"reply": "Document introuvable.", "option_groups": []}

        shortcuts: list[str] = []
        if doc_id:
            try:
                from app.services.regulatory_service import list_documents
                docs = list_documents()
                doc = next((d for d in docs if d["id"] == int(doc_id)), None)
                if doc:
                    raw = doc.get("shortcuts") or []
                    shortcuts = raw if isinstance(raw, list) else []
            except Exception:
                pass

        if not shortcuts:
            shortcuts = ["Vue d'ensemble", "Principales obligations", "Sanctions", "Comment se conformer"]

        return {
            "reply": f"Bonjour ! Alors dis-moi, qu'est-ce que tu veux savoir sur {doc_name} ?",
            "option_groups": [
                SecOpsChatService._group(
                    f"Questions sur {doc_name}",
                    [
                        SecOpsChatService._option(
                            "REGULATORY_DOC_CUSTOM_QUERY",
                            shortcut,
                            {"doc_name": doc_name, "doc_id": doc_id, "question": shortcut},
                        )
                        for shortcut in shortcuts
                    ],
                )
            ],
        }

    @staticmethod
    def _reply_free_prompt(
        *,
        message: str,
        current_user: AuthenticatedUser,
        report_id: str | None,
        draft_context: dict[str, Any] | None,
        history: list[dict] | None = None,
        current_section: str | None = None,
        view_state: str | None = None,
        regulatory_doc_context: str | None = None,
    ) -> dict:
        user_message = (message or "").strip()
        if not user_message:
            return SecOpsChatService._build_main_menu(
                report_id=report_id,
                draft_context=draft_context,
                current_user=current_user,
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

        # Si contexte réglementaire actif → aller directement au RAG réglementaire
        from app.services.regulatory_service import is_regulatory_question as _is_reg_check
        _is_reg_early = bool(regulatory_doc_context) or _is_reg_check(user_message)

        if not _is_reg_early:
            # Recherche semantique dans le FAQ (ignorée en contexte réglementaire)
            from app.services.faq_service import query_faq, is_in_scope_semantic
            faq_result = query_faq(user_message)
            if faq_result:
                return SecOpsChatService._build_faq_response(faq_result)

            # Scope check semantique
            if not is_in_scope_semantic(user_message):
                return {"reply": SecOpsChatService.OUT_OF_SCOPE_REPLY, "option_groups": []}

            lowered = user_message.casefold()
            if not report_id and "menace" in lowered:
                return SecOpsChatService._reply_general_threat_entry(current_user)
            if not report_id and "rapport" in lowered:
                return SecOpsChatService._reply_reports_menu(current_user)
            if "questionnaire" in lowered or "question" in lowered:
                return SecOpsChatService._reply_questionnaire_menu(draft_context)

        if SecOpsChatService._detect_tour_intent(user_message):
            return SecOpsChatService._reply_tour_menu()

        guide_target = SecOpsChatService._detect_guide_target(user_message)
        if guide_target:
            return SecOpsChatService._reply_guide(guide_target)

        runtime_context = SecOpsChatService._build_runtime_context(
            current_user=current_user,
            report_id=report_id,
            draft_context=draft_context,
            current_section=current_section,
            view_state=view_state,
        )
        from app.services.rag_service import query_context
        from app.services.regulatory_service import query_regulatory, is_regulatory_question
        is_reg = is_regulatory_question(user_message)
        if regulatory_doc_context:
            is_reg = True
        if not is_reg and history:
            history_recent = history[-4:]
            all_text = " ".join(m.get("content", "") for m in history_recent)
            if is_regulatory_question(all_text):
                is_reg = True

        print(f"[RAG] is_reg={is_reg} reg_doc='{regulatory_doc_context}' msg='{user_message[:50]}'", flush=True)

        rag_context = "" if is_reg else query_context(user_message, top_k=4)
        qdrant_query = user_message
        logger.info("[RAG-REG] Question: '%s' | Réglementaire détectée: %s", user_message[:80], is_reg)
        regulatory_context = query_regulatory(qdrant_query, top_k=3) if is_reg else ""
        if regulatory_context:
            logger.info("[RAG-REG] Extraits trouvés (%d caractères) — injectés dans le prompt", len(regulatory_context))
        else:
            logger.info("[RAG-REG] Aucun extrait réglementaire injecté")
        history_text = SecOpsChatService._format_history(history or [])

        if regulatory_context:
            prompt_parts = [
                "Tu es un assistant specialise en securite et conformite reglementaire.",
                "Reponds UNIQUEMENT en te basant sur les extraits fournis ci-dessous.",
                "N invente aucun element absent des extraits. Si l information manque, dis-le clairement.",
                "Reponds en francais. 5 phrases maximum. Pas de markdown.",
            ]
            if history_text:
                prompt_parts.append(f"\n{history_text}")
            prompt_parts.append(
                f"\nExtraits reglementaires:\n{regulatory_context}"
            )
        elif is_reg:
            prompt_parts = [
                "Tu es un assistant specialise en conformite reglementaire et securite informatique.",
                "Reponds a la question sur la norme ou la loi mentionnee.",
                "Reponds en francais. 5 phrases maximum. Pas de markdown.",
            ]
            if history_text:
                prompt_parts.append(f"\n{history_text}")
        else:
            prompt_parts = [
                "Tu es un assistant specialise en securite informatique et threat modeling.",
                "Reponds en francais. 5 phrases maximum.",
                "Adapte ta reponse au contexte fourni.",
                "Pas de markdown.",
                "",
                f"Contexte:\n{runtime_context}",
            ]
            if history_text:
                prompt_parts.append(f"\n{history_text}")
            if rag_context:
                prompt_parts.append(
                    f"\nConnaissances techniques disponibles:\n{rag_context}"
                )
        prompt_parts.append(f"\nQuestion:\n{user_message}")
        prompt = "\n".join(prompt_parts)
        try:
            return {"reply": clean_text_response(call_mistral(prompt)), "option_groups": []}
        except LlmGuardrailBlockedError:
            logger.warning("Guardrail bloque une reponse SecOps")
            return {"reply": SecOpsChatService.GUARDRAIL_BLOCKED_REPLY, "option_groups": []}
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
    def respond(
        *,
        message: str,
        current_user: AuthenticatedUser,
        report_id: str | None = None,
        draft_context: dict[str, Any] | None = None,
        chat_mode: str | None = None,
        action_id: str | None = None,
        action_payload: dict[str, Any] | None = None,
        history: list[dict] | None = None,
        current_section: str | None = None,
        view_state: str | None = None,
        regulatory_doc_context: str | None = None,
    ) -> dict:
        action = str(action_id or "").strip().upper()
        print(f"[RESPOND] action='{action}' msg='{(message or '')[:40]}' reg_doc='{regulatory_doc_context}'")
        payload = action_payload or {}
        effective_report_id = str(payload.get("report_id") or report_id or "").strip() or None
        active_question = SecOpsChatService._find_active_question(draft_context)
        report_row = report_results = None
        if effective_report_id:
            report_row, report_results = SecOpsChatService._load_report_bundle(effective_report_id, current_user)

        if action == "SHOW_MAIN_MENU" or (action == "" and not message.strip()):
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
        if action == "REGULATORY_MENU":
            return SecOpsChatService._reply_regulatory_menu()
        if action == "REGULATORY_DOC_QUERY":
            doc_name = str(payload.get("doc_name") or "").strip()
            doc_id = payload.get("doc_id")
            return SecOpsChatService._reply_regulatory_doc_entry(doc_name, doc_id)
        if action == "REGULATORY_DOC_CUSTOM_QUERY":
            doc_name = str(payload.get("doc_name") or "").strip()
            question = str(payload.get("question") or "").strip()
            if not question:
                question = f"Explique {doc_name}"
            full_question = f"{question} — dans le document {doc_name}"
            return SecOpsChatService._reply_free_prompt(
                message=full_question,
                current_user=current_user,
                report_id=effective_report_id,
                draft_context=draft_context,
                history=history,
            )

        return SecOpsChatService._reply_free_prompt(
            message=message,
            current_user=current_user,
            report_id=effective_report_id,
            draft_context=draft_context,
            history=history,
            current_section=current_section,
            view_state=view_state,
            regulatory_doc_context=regulatory_doc_context,
        )

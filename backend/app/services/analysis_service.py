import json
import logging
from pathlib import Path
import re
import uuid

from app.core.auth import AuthenticatedUser
from app.core.exceptions import AnalysisStepError
from app.repositories.analysis_repository import AnalysisRepository
from app.repositories.catalog_repository import CatalogRepository
from app.repositories.questionnaire_repository import QuestionnaireRepository
from app.services.audit_service import AuditService
from app.services.cve_enrichment_service import CveEnrichmentService
from app.services.dfd_generator import generate_dfd_with_pytm
from app.services.llm_feedback_service import LlmFeedbackService
from app.services.llm_clients import (
    call_gemini,
    call_mistral,
    clean_text_response,
    extract_json_object,
    validate_model_output_with_judge,
)
from app.services.prompts import (
    APPLICATION_DESCRIPTION_PROMPT,
    DFD_SYSTEM_PROMPT,
    SCENARIO_ENRICHMENT_PROMPT,
    THREAT_MITIGATION_PROMPT,
    THREAT_SELECTION_PROMPT,
)
from app.services.report_management_service import ReportManagementService
from app.services.report_service import build_safe_slug, generate_report_pdf

logger = logging.getLogger(__name__)


class AnalysisService:
    _latest_report_path: str | None = None
    _latest_dfd_path: str | None = None
    _latest_report_owner_id: uuid.UUID | None = None
    _latest_dfd_owner_id: uuid.UUID | None = None
    _MATCHING_STOPWORDS = {
        "the", "and", "for", "with", "from", "that", "this", "dans", "avec", "pour", "sans",
        "une", "des", "les", "est", "sur", "par", "aux", "via", "plus", "moins", "contre",
        "entre", "sont", "etre", "ont", "nous", "vous", "leur", "leurs", "cela", "comme",
        "application", "applicatif", "service", "systeme", "donnees", "utilisateur",
        "interne", "externes", "externe", "microservice", "frontend", "backend",
        "mitigation", "security", "securite", "solution", "plateforme", "outil",
    }

    @staticmethod
    def _normalize_answer_candidates(answer_row: dict) -> list[str]:
        answer_text = answer_row.get("answer_text")
        answer_boolean = answer_row.get("answer_boolean")
        answer_json = answer_row.get("answer_json")

        if isinstance(answer_text, str) and answer_text.strip():
            return [answer_text.strip()]

        if isinstance(answer_boolean, bool):
            return [
                "YES" if answer_boolean else "NO",
                "TRUE" if answer_boolean else "FALSE",
                "true" if answer_boolean else "false",
            ]

        if isinstance(answer_json, list):
            return [str(item).strip() for item in answer_json if str(item).strip()]

        return []

    @staticmethod
    def _render_answer_value(answer_row: dict) -> str:
        answer_text = answer_row.get("answer_text")
        answer_boolean = answer_row.get("answer_boolean")
        answer_json = answer_row.get("answer_json")

        if isinstance(answer_text, str) and answer_text.strip():
            return answer_text.strip()
        if isinstance(answer_boolean, bool):
            return "Oui" if answer_boolean else "Non"
        if isinstance(answer_json, list):
            values = [str(item).strip() for item in answer_json if str(item).strip()]
            return ", ".join(values)
        return ""

    @staticmethod
    def _build_fallback_sentence(question_meta: dict, answer_row: dict) -> str | None:
        answer_value = AnalysisService._render_answer_value(answer_row)
        if not answer_value:
            return None

        label = (question_meta.get("label") or answer_row.get("question_code") or "").strip()
        if not label:
            return None

        return f"{label} : {answer_value}."

    @staticmethod
    def _build_context_bundle(analysis_id: int, questionnaire_code: str, questionnaire_data: dict) -> dict:
        answers = AnalysisRepository.get_analysis_answers(analysis_id)
        questions_by_code = {
            question["code"]: question
            for question in questionnaire_data.get("questions", [])
        }

        llm_sentences: list[str] = []
        diagram_hints: list[str] = []
        question_summaries: list[str] = []

        for answer_row in answers:
            question_code = answer_row["question_code"]
            question_meta = questions_by_code.get(question_code, {})
            candidates = AnalysisService._normalize_answer_candidates(answer_row)
            context_rows = AnalysisRepository.get_answer_context_entries(
                questionnaire_code=questionnaire_code,
                question_code=question_code,
                option_values=candidates,
            )

            if context_rows:
                for context_row in context_rows:
                    sentence = (context_row.get("llm_sentence") or "").strip()
                    hint = (context_row.get("diagram_hint") or "").strip()

                    if sentence and sentence not in llm_sentences:
                        llm_sentences.append(sentence)
                    if hint and hint not in diagram_hints:
                        diagram_hints.append(hint)
            else:
                fallback_sentence = AnalysisService._build_fallback_sentence(question_meta, answer_row)
                if fallback_sentence and fallback_sentence not in llm_sentences:
                    llm_sentences.append(fallback_sentence)

            display_value = AnalysisService._render_answer_value(answer_row)
            if display_value:
                label = (question_meta.get("label") or question_code).strip()
                question_summaries.append(f"- {label}: {display_value}")

        context_parts = ["Contexte applicatif extrait du questionnaire :"]
        if llm_sentences:
            context_parts.extend(f"- {sentence}" for sentence in llm_sentences)
        else:
            context_parts.append("- Aucun contexte traduisible n a ete trouve dans questionnaire_answer_context.")

        if diagram_hints:
            context_parts.append("")
            context_parts.append("Indications diagramme :")
            context_parts.extend(f"- {hint}" for hint in diagram_hints)

        if question_summaries:
            context_parts.append("")
            context_parts.append("Reponses brutes utiles :")
            context_parts.extend(question_summaries)

        return {
            "llm_sentences": llm_sentences,
            "diagram_hints": diagram_hints,
            "question_summaries": question_summaries,
            "context_text": "\n".join(context_parts),
        }

    @staticmethod
    def _generate_application_description(app_name: str, app_description: str, context_bundle: dict) -> str:
        feedback_memory = LlmFeedbackService.build_prompt_memory(
            section_types=["application_description"],
        )
        prompt = (
            f"{APPLICATION_DESCRIPTION_PROMPT}\n\n"
            f"Nom de l application :\n{app_name}\n\n"
            f"Description initiale fournie :\n{app_description}\n\n"
            f"{context_bundle['context_text']}\n\n"
            f"{feedback_memory}\n"
        )
        return clean_text_response(call_mistral(prompt))

    @staticmethod
    def _generate_dfd_json(app_name: str, generated_description: str, context_bundle: dict) -> dict:
        feedback_memory = LlmFeedbackService.build_prompt_memory(
            section_types=["dfd"],
        )
        prompt = (
            f"{DFD_SYSTEM_PROMPT}\n\n"
            f"Nom de l application :\n{app_name}\n\n"
            f"Description consolidee :\n{generated_description}\n\n"
            f"{context_bundle['context_text']}\n\n"
            f"{feedback_memory}\n"
        )
        return extract_json_object(call_mistral(prompt))

    @staticmethod
    def _build_cve_context_text(context_bundle: dict) -> str:
        sections: list[str] = []

        detected_terms = context_bundle.get("cve_detected_terms") or []
        if detected_terms:
            sections.append(
                "Technologies detectees pour le contexte CVE : "
                + ", ".join(str(term) for term in detected_terms[:8])
                + "."
            )

        summary = str(context_bundle.get("cve_summary") or "").strip()
        if summary:
            sections.append(f"Resume CVE : {summary}")

        risk_signals = context_bundle.get("cve_risk_signals") or []
        if risk_signals:
            sections.append("Signaux de risque a prendre en compte :")
            sections.extend(f"- {signal}" for signal in risk_signals[:5])

        graph_relation_summary = str(context_bundle.get("cve_graph_relation_summary") or "").strip()
        if graph_relation_summary:
            sections.append(graph_relation_summary)

        cve_context = str(context_bundle.get("cve_context_text") or "").strip()
        if cve_context:
            sections.append(cve_context)

        prompt_text = "\n".join(section for section in sections if section).strip()
        return f"\n\n{prompt_text}\n" if prompt_text else ""

    @staticmethod
    def _build_catalog_selection_payload(catalog_threats: list[dict]) -> list[dict]:
        lightweight_catalog: list[dict] = []
        for threat in catalog_threats:
            name = str(threat.get("nom_menace") or threat.get("name") or "").strip()
            if not name:
                continue

            lightweight_catalog.append(
                {
                    "name": name,
                    "description": str(threat.get("description") or "").strip(),
                }
            )
        return lightweight_catalog

    @staticmethod
    def _tokenize_for_matching(*values: str) -> set[str]:
        tokens: set[str] = set()
        for value in values:
            for token in re.findall(r"[a-zA-Z0-9][a-zA-Z0-9.+#_-]{1,}", str(value or "").lower()):
                if token in AnalysisService._MATCHING_STOPWORDS:
                    continue
                if len(token) <= 2 and not any(char.isdigit() for char in token):
                    continue
                tokens.add(token)
        return tokens

    @staticmethod
    def _load_internal_security_solutions() -> list[dict]:
        try:
            raw_solutions = CatalogRepository.list_internal_solutions()
        except Exception:
            logger.warning("Impossible de charger les solutions internes pour les mitigations.", exc_info=True)
            return []

        normalized_solutions: list[dict] = []
        for row in raw_solutions or []:
            if row.get("actif") is False:
                continue

            name = str(row.get("nom_solution") or "").strip()
            solution_type = str(row.get("type_solution") or "").strip()
            usage = str(row.get("usage_securite") or "").strip()
            description = str(row.get("description_solution") or "").strip()
            vendor = str(row.get("editeur_solution") or "").strip()
            if not name:
                continue

            normalized_solutions.append(
                {
                    "name": name,
                    "type": solution_type,
                    "vendor": vendor,
                    "security_usage": usage,
                    "description": description,
                    "match_tokens": AnalysisService._tokenize_for_matching(
                        name,
                        solution_type,
                        vendor,
                        usage,
                        description,
                    ),
                }
            )

        return normalized_solutions

    @staticmethod
    def _select_internal_solution_candidates(
        threat_name: str,
        threat_description: str,
        attack_scenarios: list[str],
        app_name: str,
        generated_description: str,
        context_bundle: dict,
        internal_solutions: list[dict],
        limit: int = 5,
    ) -> list[dict]:
        if not internal_solutions:
            return []

        context_text = " ".join(
            [
                app_name,
                generated_description,
                context_bundle.get("context_text") or "",
                threat_name,
                threat_description,
                " ".join(str(item) for item in (attack_scenarios or [])),
            ]
        )
        context_tokens = AnalysisService._tokenize_for_matching(context_text)
        ranked_candidates: list[tuple[int, str, dict]] = []

        for solution in internal_solutions:
            solution_tokens = solution.get("match_tokens") or set()
            if not solution_tokens:
                continue

            overlap = context_tokens & solution_tokens
            if not overlap:
                continue

            score = len(overlap) * 2
            solution_name = str(solution.get("name") or "")
            usage = str(solution.get("security_usage") or "")
            solution_type = str(solution.get("type") or "")

            lowered_context = context_text.lower()
            if solution_name and solution_name.lower() in lowered_context:
                score += 4
            if usage and any(token in lowered_context for token in AnalysisService._tokenize_for_matching(usage)):
                score += 2
            if solution_type and any(token in lowered_context for token in AnalysisService._tokenize_for_matching(solution_type)):
                score += 1

            ranked_candidates.append(
                (
                    score,
                    solution_name.casefold(),
                    {
                        "name": solution_name,
                        "type": solution_type,
                        "vendor": str(solution.get("vendor") or ""),
                        "security_usage": usage,
                        "description": str(solution.get("description") or ""),
                    },
                )
            )

        ranked_candidates.sort(key=lambda item: (-item[0], item[1]))
        return [candidate for _, _, candidate in ranked_candidates[:limit]]

    @staticmethod
    def _build_mitigation_payload(
        selected_threats: list[dict],
        catalog_threats: list[dict],
        app_name: str,
        generated_description: str,
        context_bundle: dict,
        internal_solutions: list[dict],
    ) -> list[dict]:
        catalog_by_name = {
            str(threat.get("nom_menace") or threat.get("name") or "").strip().casefold(): threat
            for threat in catalog_threats
            if str(threat.get("nom_menace") or threat.get("name") or "").strip()
        }

        payload: list[dict] = []
        for selected_threat in selected_threats:
            threat_name = str(selected_threat.get("name") or "").strip()
            if not threat_name:
                continue

            catalog_match = catalog_by_name.get(threat_name.casefold(), {})
            db_mitigations = []
            for mitigation in catalog_match.get("mitigations", []) or []:
                mitigation_text = str(mitigation.get("description_mitigation") or "").strip()
                if mitigation_text:
                    db_mitigations.append(mitigation_text)
            internal_solution_candidates = AnalysisService._select_internal_solution_candidates(
                threat_name=threat_name,
                threat_description=str(
                    selected_threat.get("description")
                    or catalog_match.get("description")
                    or ""
                ).strip(),
                attack_scenarios=selected_threat.get("attack_scenarios") or [],
                app_name=app_name,
                generated_description=generated_description,
                context_bundle=context_bundle,
                internal_solutions=internal_solutions,
            )

            payload.append(
                {
                    "name": threat_name,
                    "description": str(
                        selected_threat.get("description")
                        or catalog_match.get("description")
                        or ""
                    ).strip(),
                    "attack_scenarios": selected_threat.get("attack_scenarios") or [],
                    "existing_mitigations": db_mitigations,
                    "internal_solution_candidates": internal_solution_candidates,
                }
            )

        return payload

    @staticmethod
    def _build_scenario_enrichment_payload(
        selected_threats: list[dict],
        catalog_threats: list[dict],
    ) -> list[dict]:
        catalog_by_name = {
            str(threat.get("nom_menace") or threat.get("name") or "").strip().casefold(): threat
            for threat in catalog_threats
            if str(threat.get("nom_menace") or threat.get("name") or "").strip()
        }

        payload: list[dict] = []
        for selected_threat in selected_threats:
            threat_name = str(selected_threat.get("name") or "").strip()
            if not threat_name:
                continue

            catalog_match = catalog_by_name.get(threat_name.casefold(), {})
            db_scenarios = []
            for scenario in catalog_match.get("scenarios", []) or []:
                scenario_text = str(scenario.get("description_scenario") or "").strip()
                if scenario_text:
                    db_scenarios.append(scenario_text)

            payload.append(
                {
                    "name": threat_name,
                    "description": str(
                        selected_threat.get("description")
                        or catalog_match.get("description")
                        or ""
                    ).strip(),
                    "existing_attack_scenarios": db_scenarios,
                    "current_attack_scenarios": selected_threat.get("attack_scenarios") or [],
                }
            )

        return payload

    @staticmethod
    def _select_catalog_threats(
        app_name: str,
        generated_description: str,
        context_bundle: dict,
        lightweight_catalog: list[dict],
    ) -> dict:
        feedback_memory = LlmFeedbackService.build_prompt_memory(
            section_types=["threat", "attack_scenario"],
        )
        prompt = (
            f"{THREAT_SELECTION_PROMPT}\n\n"
            f"Nom de l application :\n{app_name}\n\n"
            f"Description consolidee :\n{generated_description}\n\n"
            f"{context_bundle['context_text']}\n\n"
            f"{feedback_memory}\n\n"
            f"Catalogue de menaces disponible :\n"
            f"{json.dumps(lightweight_catalog, ensure_ascii=False, indent=2)}\n"
        )
        return extract_json_object(call_gemini(prompt))

    @staticmethod
    def _enrich_attack_scenarios(
        app_name: str,
        generated_description: str,
        context_bundle: dict,
        selected_threats_payload: list[dict],
    ) -> dict:
        threat_names = [
            str(item.get("name") or "").strip()
            for item in selected_threats_payload
            if str(item.get("name") or "").strip()
        ]
        feedback_memory = LlmFeedbackService.build_prompt_memory(
            section_types=["threat", "attack_scenario"],
            threat_names=threat_names,
        )
        prompt = (
            f"{SCENARIO_ENRICHMENT_PROMPT}\n\n"
            f"Nom de l application :\n{app_name}\n\n"
            f"Description consolidee :\n{generated_description}\n\n"
            f"{context_bundle['context_text']}\n\n"
            f"{AnalysisService._build_cve_context_text(context_bundle)}"
            f"{feedback_memory}\n\n"
            f"Menaces retenues et scenarios existants :\n"
            f"{json.dumps(selected_threats_payload, ensure_ascii=False, indent=2)}\n"
        )
        return extract_json_object(call_gemini(prompt))

    @staticmethod
    def _enrich_threat_mitigations(
        app_name: str,
        generated_description: str,
        context_bundle: dict,
        selected_threats_payload: list[dict],
    ) -> dict:
        threat_names = [
            str(item.get("name") or "").strip()
            for item in selected_threats_payload
            if str(item.get("name") or "").strip()
        ]
        feedback_memory = LlmFeedbackService.build_prompt_memory(
            section_types=["threat", "attack_scenario", "mitigation"],
            threat_names=threat_names,
        )
        prompt = (
            f"{THREAT_MITIGATION_PROMPT}\n\n"
            f"Nom de l application :\n{app_name}\n\n"
            f"Description consolidee :\n{generated_description}\n\n"
            f"{context_bundle['context_text']}\n\n"
            f"{feedback_memory}\n\n"
            f"Menaces retenues et mitigations existantes :\n"
            f"{json.dumps(selected_threats_payload, ensure_ascii=False, indent=2)}\n"
        )
        return extract_json_object(call_gemini(prompt))

    @staticmethod
    def _normalize_selected_threats(analysis_result: dict) -> list[dict]:
        normalized = []

        for raw_threat in analysis_result.get("threats", []):
            name = str(raw_threat.get("name", "")).strip()
            if not name:
                continue

            attack_scenarios = raw_threat.get("attack_scenarios", [])
            if isinstance(attack_scenarios, str):
                attack_scenarios = [attack_scenarios]

            mitigations = raw_threat.get("mitigations", [])
            if isinstance(mitigations, str):
                mitigations = [mitigations]

            references = raw_threat.get("references", [])
            normalized_references = []
            if isinstance(references, list):
                for reference in references:
                    if not isinstance(reference, dict):
                        continue

                    reference_code = str(reference.get("reference_menace") or "").strip()
                    reference_name = str(reference.get("nom_reference") or "").strip()
                    reference_link = str(reference.get("lien") or "").strip()

                    if not any((reference_code, reference_name, reference_link)):
                        continue

                    normalized_references.append(
                        {
                            "reference_menace": reference_code,
                            "nom_reference": reference_name,
                            "lien": reference_link,
                        }
                    )

            normalized.append(
                {
                    "name": name,
                    "description": str(raw_threat.get("description", "")).strip(),
                    "attack_scenarios": [
                        str(item).strip()
                        for item in attack_scenarios
                        if str(item).strip()
                    ],
                    "mitigations": [
                        str(item).strip()
                        for item in mitigations
                        if str(item).strip()
                    ],
                    "references": normalized_references,
                }
            )

        return normalized

    @staticmethod
    def create_analysis(
        app_name: str,
        app_description: str,
        questionnaire_code: str,
        answers: dict,
        generated_by: AuthenticatedUser,
        dev_name: str = "",
    ):
        logger.info(
            "Debut analyse: app_name=%s questionnaire_code=%s generated_by=%s",
            app_name,
            questionnaire_code,
            generated_by.username,
        )

        try:
            questionnaire_meta = AnalysisRepository.get_questionnaire_meta_by_code(questionnaire_code)
        except Exception as exc:
            logger.exception("Echec lecture meta questionnaire")
            raise AnalysisStepError(
                "questionnaire_lookup",
                "Impossible de charger les metadonnees du questionnaire.",
                cause=exc,
            ) from exc
        if not questionnaire_meta:
            raise ValueError("Questionnaire actif introuvable")

        try:
            questionnaire_data = QuestionnaireRepository.get_active_questionnaire_by_code(questionnaire_code)
        except Exception as exc:
            logger.exception("Echec lecture questionnaire actif")
            raise AnalysisStepError(
                "questionnaire_load",
                "Impossible de charger la configuration du questionnaire.",
                cause=exc,
            ) from exc
        if not questionnaire_data:
            raise ValueError("Configuration questionnaire introuvable")

        try:
            analysis_id = AnalysisRepository.create_analysis_request(
                app_name=app_name,
                app_description=app_description,
                questionnaire_id=questionnaire_meta["id"],
                questionnaire_version=questionnaire_meta["version"],
            )
            AuditService.log_action(
                actor=generated_by,
                action_type="CREATE_ANALYSIS",
                entity_type="analysis",
                entity_id=str(analysis_id),
                entity_label=app_name,
                new_values={
                    "app_name": app_name,
                    "app_description": app_description,
                    "questionnaire_code": questionnaire_code,
                    "questionnaire_id": questionnaire_meta["id"],
                    "questionnaire_version": questionnaire_meta["version"],
                },
                metadata={"dev_name": dev_name},
            )
        except Exception as exc:
            logger.exception("Echec creation analysis_request")
            raise AnalysisStepError(
                "analysis_request_create",
                "Impossible de creer la demande d'analyse en base.",
                cause=exc,
            ) from exc

        try:
            try:
                AnalysisRepository.insert_answers(analysis_id, answers)
                logger.info("Reponses questionnaire enregistrees: analysis_id=%s", analysis_id)
            except Exception as exc:
                logger.exception("Echec insertion reponses analyse")
                raise AnalysisStepError(
                    "analysis_answers_save",
                    "Impossible d'enregistrer les reponses du questionnaire.",
                    cause=exc,
                ) from exc

            try:
                AnalysisRepository.update_analysis_status(analysis_id, "processing")
                AuditService.log_action(
                    actor=generated_by,
                    action_type="UPDATE_ANALYSIS_STATUS",
                    entity_type="analysis",
                    entity_id=str(analysis_id),
                    entity_label=app_name,
                    old_values={"status": "submitted"},
                    new_values={"status": "processing"},
                )
            except Exception as exc:
                logger.exception("Echec maj statut analyse -> processing")
                raise AnalysisStepError(
                    "analysis_status_processing",
                    "Impossible de passer l'analyse au statut processing.",
                    cause=exc,
                ) from exc

            try:
                context_bundle = AnalysisService._build_context_bundle(
                    analysis_id=analysis_id,
                    questionnaire_code=questionnaire_code,
                    questionnaire_data=questionnaire_data,
                )
                cve_enrichment = CveEnrichmentService.build_enrichment(
                    app_name=app_name,
                    answers=answers,
                    app_description=app_description,
                )
                context_bundle["cve_context_text"] = cve_enrichment.get("context_text", "")
                context_bundle["cve_matches"] = cve_enrichment.get("matches", [])
                context_bundle["cve_detected_terms"] = cve_enrichment.get("detected_terms", [])
                context_bundle["cve_risk_signals"] = cve_enrichment.get("risk_signals", [])
                context_bundle["cve_summary"] = cve_enrichment.get("summary", "")
                context_bundle["cve_graph_relation_summary"] = cve_enrichment.get("graph_relation_summary", "")
            except Exception as exc:
                logger.exception("Echec construction contexte analyse")
                raise AnalysisStepError(
                    "context_build",
                    "Impossible de construire le contexte d'analyse.",
                    cause=exc,
                ) from exc

            try:
                generated_description = AnalysisService._generate_application_description(
                    app_name=app_name,
                    app_description=app_description,
                    context_bundle=context_bundle,
                )
                logger.info("Description applicative generee: analysis_id=%s", analysis_id)
                # Exemple d activation LLM-as-a-Judge via modele local Ollama/Prometheus.
                # judge_description = validate_model_output_with_judge(
                #     task_name="Validation description applicative",
                #     context_text=context_bundle["context_text"],
                #     candidate_output=generated_description,
                #     evaluation_focus=(
                #         "Verifier que la description est fidele au contexte questionnaire, "
                #         "sans hallucination ni ajout de composants absents."
                #     ),
                # )
                # logger.info(
                #     "LLM Judge description: analysis_id=%s valid=%s score=%s decision=%s",
                #     analysis_id,
                #     judge_description["is_valid"],
                #     judge_description["score"],
                #     judge_description["decision"],
                # )
            except Exception as exc:
                logger.exception("Echec generation description applicative")
                raise AnalysisStepError(
                    "application_description_generation",
                    "La generation de la description applicative a echoue.",
                    cause=exc,
                ) from exc

            try:
                dfd_json = AnalysisService._generate_dfd_json(
                    app_name=app_name,
                    generated_description=generated_description,
                    context_bundle=context_bundle,
                )
            except Exception as exc:
                logger.exception("Echec generation JSON DFD")
                raise AnalysisStepError(
                    "dfd_json_generation",
                    "La generation du JSON DFD a echoue.",
                    cause=exc,
                ) from exc

            try:
                dfd_output_dir = Path(__file__).resolve().parents[2] / "resources" / "out" / "diagrams"
                dfd_image_path = generate_dfd_with_pytm(dfd_json, str(dfd_output_dir))
                AnalysisService._latest_dfd_path = dfd_image_path
                AnalysisService._latest_dfd_owner_id = generated_by.user_id
                logger.info("DFD genere: analysis_id=%s path=%s", analysis_id, dfd_image_path)
            except Exception as exc:
                logger.exception("Echec rendu DFD")
                raise AnalysisStepError(
                    "dfd_render",
                    "La generation du diagramme DFD a echoue.",
                    cause=exc,
                ) from exc

            try:
                catalog_threats = CatalogRepository.list_threats_for_analysis()
                lightweight_catalog = AnalysisService._build_catalog_selection_payload(
                    catalog_threats
                )
                selected_threats_result = AnalysisService._select_catalog_threats(
                    app_name=app_name,
                    generated_description=generated_description,
                    context_bundle=context_bundle,
                    lightweight_catalog=lightweight_catalog,
                )
                selected_threats = AnalysisService._normalize_selected_threats(
                    selected_threats_result
                )
                scenario_enrichment_payload = AnalysisService._build_scenario_enrichment_payload(
                    selected_threats=selected_threats,
                    catalog_threats=catalog_threats,
                )
                scenario_enrichment_result = AnalysisService._enrich_attack_scenarios(
                    app_name=app_name,
                    generated_description=generated_description,
                    context_bundle=context_bundle,
                    selected_threats_payload=scenario_enrichment_payload,
                )
                selected_threats = AnalysisService._normalize_selected_threats(
                    scenario_enrichment_result
                )
                internal_solutions = AnalysisService._load_internal_security_solutions()
                mitigation_payload = AnalysisService._build_mitigation_payload(
                    selected_threats=selected_threats,
                    catalog_threats=catalog_threats,
                    app_name=app_name,
                    generated_description=generated_description,
                    context_bundle=context_bundle,
                    internal_solutions=internal_solutions,
                )
                mitigated_result = AnalysisService._enrich_threat_mitigations(
                    app_name=app_name,
                    generated_description=generated_description,
                    context_bundle=context_bundle,
                    selected_threats_payload=mitigation_payload,
                )
                # Exemple d activation LLM-as-a-Judge sur la sortie threat modeling.
                # judge_threats = validate_model_output_with_judge(
                #     task_name="Validation des menaces retenues",
                #     context_text=(
                #         f"{context_bundle['context_text']}\n\n"
                #         f"Description consolidee :\n{generated_description}"
                #     ),
                #     candidate_output=gemini_result,
                #     evaluation_focus=(
                #         "Verifier que les menaces, scenarios et mitigations sont cohérents "
                #         "avec le contexte applicatif et qu il n y a pas d hallucination."
                #     ),
                # )
                # logger.info(
                #     "LLM Judge threats: analysis_id=%s valid=%s score=%s decision=%s",
                #     analysis_id,
                #     judge_threats["is_valid"],
                #     judge_threats["score"],
                #     judge_threats["decision"],
                # )
                selected_threats = AnalysisService._normalize_selected_threats(mitigated_result)
                logger.info(
                    "Analyse menaces terminee: analysis_id=%s threat_count=%s",
                    analysis_id,
                    len(selected_threats),
                )
            except Exception as exc:
                logger.exception("Echec analyse des menaces")
                raise AnalysisStepError(
                    "threat_analysis",
                    "L'analyse des menaces via le catalogue a echoue.",
                    cause=exc,
                ) from exc

            analyst_name = generated_by.display_name.strip() or generated_by.username
            report_file_name = (
                f"rapport-{build_safe_slug(analyst_name)}-"
                f"{build_safe_slug(app_name)}-"
                f"{Path(dfd_image_path).stem.split('_')[-1]}.pdf"
            )

            try:
                report_path = generate_report_pdf(
                    app_name=app_name,
                    developer_name=analyst_name or dev_name,
                    generated_description=generated_description,
                    selected_threats=selected_threats,
                    dfd_image_path=dfd_image_path,
                    dfd_reference="DFD-01",
                    application_version="v1",
                    report_file_name=report_file_name,
                )
                logger.info("PDF rapport genere: analysis_id=%s path=%s", analysis_id, report_path)
            except Exception as exc:
                logger.exception("Echec generation PDF rapport")
                raise AnalysisStepError(
                    "report_pdf_generation",
                    "La generation du PDF rapport a echoue.",
                    cause=exc,
                ) from exc

            AnalysisService._latest_report_path = report_path
            AnalysisService._latest_report_owner_id = generated_by.user_id
            report = ReportManagementService.create_report_record(
                app_name=app_name,
                description=generated_description,
                pdf_path=report_path,
                file_name=report_file_name,
                generated_by=generated_by,
            )
            logger.info("Rapport persiste: analysis_id=%s report_id=%s", analysis_id, report.id)

            ReportManagementService.create_report_results_record(
                report_id=report.id,
                app_name=app_name,
                developer_name=analyst_name,
                application_description=generated_description,
                selected_threats=selected_threats,
                dfd_image_path=dfd_image_path,
                dfd_reference="DFD-01",
                file_name=report.file_name,
                file_type=report.file_type,
                file_size=report.file_size,
                minio_bucket=report.minio_bucket,
                minio_object_key=report.minio_object_key,
                generated_by=generated_by,
            )
            logger.info(
                "Resultats rapport persistes: analysis_id=%s report_id=%s",
                analysis_id,
                report.id,
            )

            try:
                AnalysisRepository.update_analysis_status(analysis_id, "completed")
                AuditService.log_action(
                    actor=generated_by,
                    action_type="UPDATE_ANALYSIS_STATUS",
                    entity_type="analysis",
                    entity_id=str(analysis_id),
                    entity_label=app_name,
                    old_values={"status": "processing"},
                    new_values={"status": "completed"},
                )
            except Exception as exc:
                logger.exception("Echec maj statut analyse -> completed")
                raise AnalysisStepError(
                    "analysis_status_completed",
                    "Le rapport est genere mais le statut final de l'analyse n'a pas pu etre mis a jour.",
                    cause=exc,
                ) from exc

            return {
                "analysis_id": analysis_id,
                "status": "success",
                "report_id": report.id,
                "report_url": report.report_url,
                "dfd_image_url": "/download-dfd",
                "application_description": generated_description,
                "threat_count": len(selected_threats),
            }
        except Exception as exc:
            try:
                failed_step = exc.step if isinstance(exc, AnalysisStepError) else "unknown"
                failed_message = (
                    exc.message
                    if isinstance(exc, AnalysisStepError)
                    else "Une erreur inattendue est survenue pendant le pipeline d'analyse."
                )
                AnalysisRepository.update_analysis_status(analysis_id, "failed")
                AuditService.log_action(
                    actor=generated_by,
                    action_type="UPDATE_ANALYSIS_STATUS",
                    entity_type="analysis",
                    entity_id=str(analysis_id),
                    entity_label=app_name,
                    old_values={"status": "processing"},
                    new_values={"status": "failed"},
                    metadata={"error_step": failed_step},
                    comment=failed_message,
                )
            except Exception:
                logger.exception("Echec maj statut analyse -> failed")
            logger.exception("Pipeline analyse en echec: analysis_id=%s", analysis_id)
            if isinstance(exc, AnalysisStepError):
                raise
            raise AnalysisStepError(
                "unknown",
                "Une erreur inattendue est survenue pendant le pipeline d'analyse.",
                cause=exc,
            ) from exc

    @staticmethod
    def get_latest_report_path() -> str | None:
        return AnalysisService._latest_report_path

    @staticmethod
    def get_latest_dfd_path() -> str | None:
        return AnalysisService._latest_dfd_path

    @staticmethod
    def get_latest_report_owner_id() -> uuid.UUID | None:
        return AnalysisService._latest_report_owner_id

    @staticmethod
    def get_latest_dfd_owner_id() -> uuid.UUID | None:
        return AnalysisService._latest_dfd_owner_id

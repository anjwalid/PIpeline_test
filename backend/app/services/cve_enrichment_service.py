from __future__ import annotations

from datetime import datetime
import re
from typing import Any

from app.services.cve_graph_service import CveGraphService, TECH_TERM_MAP


class CveEnrichmentService:
    DESCRIPTION_TOKEN_PATTERN = re.compile(r"[a-zA-Z0-9.+#-]{3,}")

    @staticmethod
    def _extract_description_terms(app_description: str) -> list[str]:
        known_terms = {
            item
            for mapped_terms in TECH_TERM_MAP.values()
            for item in mapped_terms
        }
        ordered_terms: list[str] = []
        seen: set[str] = set()

        for token in CveEnrichmentService.DESCRIPTION_TOKEN_PATTERN.findall(
            (app_description or "").lower()
        ):
            cleaned = token.strip().lower()
            if (
                not cleaned
                or cleaned in seen
                or cleaned not in known_terms
                or cleaned in {"application", "interne", "externe", "systeme", "service"}
            ):
                continue
            seen.add(cleaned)
            ordered_terms.append(cleaned)

        return ordered_terms[:8]

    @staticmethod
    def _build_terms(
        answers: dict[str, Any] | None,
        app_description: str,
    ) -> list[str]:
        answer_terms = CveGraphService.extract_search_terms(
            answers=answers,
            app_description=app_description,
        )
        description_terms = CveEnrichmentService._extract_description_terms(app_description)

        merged_terms: list[str] = []
        seen: set[str] = set()
        for term in [*answer_terms, *description_terms]:
            normalized = str(term or "").strip().lower()
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            merged_terms.append(normalized)

        return merged_terms[:12]

    @staticmethod
    def _match_score(match: dict[str, Any], detected_terms: list[str]) -> tuple[float, float, str]:
        severity = str(match.get("severity") or "").strip().upper()
        severity_weight = {
            "CRITICAL": 5.0,
            "CRITIQUE": 5.0,
            "HIGH": 4.0,
            "MEDIUM": 2.5,
            "MODERATE": 2.5,
            "LOW": 1.0,
        }.get(severity, 0.5)

        try:
            base_score = float(match.get("base_score") or 0.0)
        except (TypeError, ValueError):
            base_score = 0.0

        product_blob = " ".join(
            [
                str(match.get("vendor") or ""),
                str(match.get("product") or ""),
                str(match.get("product_version") or ""),
                str(match.get("description") or ""),
                " ".join(str(item or "") for item in (match.get("matched_terms") or [])),
            ]
        ).lower()
        term_overlap = sum(1 for term in detected_terms if term in product_blob)
        network_bonus = 1.5 if any(
            str(vector or "").strip().upper() == "NETWORK"
            for vector in (match.get("attack_vectors") or [])
        ) else 0.0
        identity_bonus = 1.0 if any(
            keyword in product_blob
            for keyword in ("keycloak", "okta", "openid", "oauth", "sso", "auth")
        ) else 0.0

        published = str(match.get("published") or "")
        try:
            published_dt = datetime.fromisoformat(published.replace("Z", "+00:00"))
            recency_score = published_dt.timestamp()
        except ValueError:
            recency_score = 0.0

        composite_score = (
            severity_weight
            + min(base_score / 2, 5)
            + (term_overlap * 1.5)
            + network_bonus
            + identity_bonus
        )
        return (composite_score, recency_score, str(match.get("cve_id") or ""))

    @staticmethod
    def _rank_matches(
        matches: list[dict[str, Any]],
        detected_terms: list[str],
    ) -> list[dict[str, Any]]:
        ranked = sorted(
            matches,
            key=lambda match: CveEnrichmentService._match_score(match, detected_terms),
            reverse=True,
        )

        unique_matches: list[dict[str, Any]] = []
        seen_cves: set[str] = set()
        for match in ranked:
            cve_id = str(match.get("cve_id") or "").strip()
            if cve_id and cve_id in seen_cves:
                continue
            if cve_id:
                seen_cves.add(cve_id)
            unique_matches.append(match)

        return unique_matches[:10]

    @staticmethod
    def _merge_graph_neighbors(matches: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not matches:
            return []

        neighbors_by_cve = CveGraphService.get_cve_graph_neighbors(
            [str(match.get("cve_id") or "") for match in matches]
        )

        enriched_matches: list[dict[str, Any]] = []
        for match in matches:
            cve_id = str(match.get("cve_id") or "").strip().upper()
            graph_neighbors = neighbors_by_cve.get(
                cve_id,
                {
                    "cwe_ids": [],
                    "capec_ids": [],
                    "mitre_techniques": [],
                    "mitre_frameworks": [],
                    "kev_known_exploited": False,
                },
            )
            enriched_match = dict(match)
            enriched_match["graph_neighbors"] = graph_neighbors
            enriched_matches.append(enriched_match)

        return enriched_matches

    @staticmethod
    def _build_risk_signals(matches: list[dict[str, Any]]) -> list[str]:
        if not matches:
            return []

        signals: list[str] = []

        critical_matches = [
            match for match in matches
            if str(match.get("severity") or "").strip().upper() in {"CRITICAL", "CRITIQUE"}
        ]
        high_matches = [
            match for match in matches
            if str(match.get("severity") or "").strip().upper() == "HIGH"
        ]
        network_matches = [
            match
            for match in matches
            if any(
                str(vector or "").strip().upper() == "NETWORK"
                for vector in (match.get("attack_vectors") or [])
            )
        ]
        identity_matches = [
            match
            for match in matches
            if any(
                keyword in str(match.get("product") or "").strip().lower()
                for keyword in ("keycloak", "okta", "adfs", "entra", "azure ad")
            )
        ]

        if critical_matches:
            signals.append(
                f"{len(critical_matches)} CVE critique(s) proche(s) de la stack detectee."
            )
        if high_matches:
            signals.append(
                f"{len(high_matches)} CVE de severite elevee ont ete retrouvees sur des composants comparables."
            )
        if network_matches:
            signals.append(
                "Des vecteurs d'attaque reseau sont presents sur plusieurs CVE rapprochees."
            )
        if identity_matches:
            signals.append(
                "Le perimetre identite / authentification ressort comme une zone de vigilance."
            )

        kev_matches = [
            match
            for match in matches
            if bool((match.get("graph_neighbors") or {}).get("kev_known_exploited"))
        ]
        if kev_matches:
            signals.append(
                "Au moins une CVE rapprochee est marquee comme connue pour etre exploitee activement."
            )

        mitre_matches = [
            match
            for match in matches
            if (match.get("graph_neighbors") or {}).get("mitre_techniques")
        ]
        if mitre_matches:
            signals.append(
                "Le graphe relie plusieurs CVE a des techniques MITRE, ce qui renforce la plausibilite des chaines d attaque."
            )

        return signals[:4]

    @staticmethod
    def _build_graph_relation_summary(matches: list[dict[str, Any]]) -> str:
        if not matches:
            return ""

        cwe_ids: set[str] = set()
        capec_ids: set[str] = set()
        mitre_ids: set[str] = set()
        kev_count = 0

        for match in matches:
            graph_neighbors = match.get("graph_neighbors") or {}
            cwe_ids.update(str(item).strip() for item in graph_neighbors.get("cwe_ids") or [] if str(item).strip())
            capec_ids.update(str(item).strip() for item in graph_neighbors.get("capec_ids") or [] if str(item).strip())
            mitre_ids.update(
                str(item).strip() for item in graph_neighbors.get("mitre_techniques") or [] if str(item).strip()
            )
            if graph_neighbors.get("kev_known_exploited"):
                kev_count += 1

        fragments: list[str] = []
        if cwe_ids:
            fragments.append(f"{len(cwe_ids)} faiblesse(s) CWE reliee(s)")
        if capec_ids:
            fragments.append(f"{len(capec_ids)} pattern(s) CAPEC associe(s)")
        if mitre_ids:
            fragments.append(f"{len(mitre_ids)} technique(s) MITRE ATT&CK rattachee(s)")
        if kev_count:
            fragments.append(f"{kev_count} CVE marquee(s) KEV")

        if not fragments:
            return ""
        return "Relations explicites du graphe : " + ", ".join(fragments) + "."

    @staticmethod
    def _build_summary(
        terms: list[str],
        matches: list[dict[str, Any]],
        risk_signals: list[str],
    ) -> str:
        if not terms and not matches:
            return "Aucun contexte CVE exploitable n a ete retrouve pour cette application."

        summary_parts: list[str] = []

        if terms:
            summary_parts.append(
                f"Technologies rapprochees identifiees: {', '.join(terms[:6])}."
            )

        if matches:
            top_match = matches[0]
            top_product = str(top_match.get("product") or "").strip()
            top_severity = str(top_match.get("severity") or "").strip()
            summary_parts.append(
                f"{len(matches)} CVE rapprochees ont ete retrouvees"
                + (f", dont une premiere liee a {top_product}" if top_product else "")
                + (f" avec une severite {top_severity}." if top_severity else ".")
            )

        if risk_signals:
            summary_parts.append(" ".join(risk_signals))

        relation_summary = CveEnrichmentService._build_graph_relation_summary(matches)
        if relation_summary:
            summary_parts.append(relation_summary)

        return " ".join(part for part in summary_parts if part).strip()

    @staticmethod
    def build_enrichment(
        *,
        app_name: str,
        app_description: str,
        answers: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        terms = CveEnrichmentService._build_terms(answers, app_description)
        matches = CveGraphService.search_cves_by_terms(terms, limit=16)
        ranked_matches = CveEnrichmentService._rank_matches(matches, terms)
        ranked_matches = CveEnrichmentService._merge_graph_neighbors(ranked_matches)
        base_context = CveGraphService.build_attack_intelligence_context(
            answers=answers,
            app_description=app_description,
        )
        risk_signals = CveEnrichmentService._build_risk_signals(ranked_matches)
        summary = CveEnrichmentService._build_summary(terms, ranked_matches, risk_signals)
        relation_summary = CveEnrichmentService._build_graph_relation_summary(ranked_matches)

        context_parts: list[str] = []
        if terms:
            context_parts.append(
                "Technologies detectees pour l enrichissement CVE : "
                + ", ".join(terms[:8])
                + "."
            )
        if base_context.get("context_text"):
            context_parts.append(str(base_context["context_text"]).strip())
        if risk_signals:
            context_parts.append("Signaux de risque observes :")
            context_parts.extend(f"- {signal}" for signal in risk_signals)
        if relation_summary:
            context_parts.append(relation_summary)
        if summary:
            context_parts.append("")
            context_parts.append(f"Resume enrichissement CVE : {summary}")

        return {
            "enabled": bool(base_context.get("enabled", CveGraphService.is_enabled())),
            "app_name": app_name,
            "detected_terms": terms,
            "matches": ranked_matches,
            "risk_signals": risk_signals,
            "summary": summary,
            "graph_relation_summary": relation_summary,
            "context_text": "\n".join(part for part in context_parts if part).strip(),
            "disabled_reason": base_context.get("disabled_reason"),
        }

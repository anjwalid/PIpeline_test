from __future__ import annotations

import logging
import os
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from string import Template
from typing import Any

import requests
from neo4j import GraphDatabase
from neo4j.exceptions import Neo4jError

from app.core.config import settings

logger = logging.getLogger(__name__)

NVD_API_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0"
DEFAULT_RESULTS_PER_PAGE = 2000
DEFAULT_BATCH_SIZE = 250
SYNC_STATE_QUERY = """
MATCH (c:CVE)
WHERE c.published IS NOT NULL
RETURN max(c.published) AS latest_published
"""

SCRIPT_DIR = Path(__file__).resolve().parents[3] / "neo4j-cve" / "code"
CONSTRAINTS_FILE = SCRIPT_DIR / "constraints.cypher"
INDEXES_FILE = SCRIPT_DIR / "indexes.cypher"
LOADER_FILE = SCRIPT_DIR / "loader-template.cypher"


class CveSyncService:
    _thread: threading.Thread | None = None
    _stop_event = threading.Event()
    _started = False

    @classmethod
    def start(cls) -> None:
        if cls._started or not settings.CVE_SYNC_ENABLED or not settings.NEO4J_ENABLED:
            return

        if not LOADER_FILE.exists():
            logger.warning("Synchronisation CVE desactivee: loader introuvable: %s", LOADER_FILE)
            return

        cls._stop_event.clear()
        cls._thread = threading.Thread(
            target=cls._run_loop,
            name="cve-sync-worker",
            daemon=True,
        )
        cls._thread.start()
        cls._started = True
        logger.info(
            "Synchronisation CVE activee: interval=%s min overlap=%s h",
            settings.CVE_SYNC_INTERVAL_MINUTES,
            settings.CVE_SYNC_OVERLAP_HOURS,
        )

    @classmethod
    def stop(cls) -> None:
        if not cls._started:
            return
        cls._stop_event.set()
        if cls._thread and cls._thread.is_alive():
            cls._thread.join(timeout=5)
        cls._thread = None
        cls._started = False

    @classmethod
    def _run_loop(cls) -> None:
        while not cls._stop_event.is_set():
            try:
                cls.run_sync_once()
            except Exception:
                logger.exception("Echec de la synchronisation CVE planifiee")

            if cls._stop_event.wait(settings.CVE_SYNC_INTERVAL_MINUTES * 60):
                break

    @classmethod
    def run_sync_once(cls) -> int:
        driver = cls._build_driver()
        if driver is None:
            return 0

        try:
            cls._execute_cypher_script(driver, cls._load_file(CONSTRAINTS_FILE))
            loaded_count = 0
            page_count = 0

            for page in cls._iter_recent_cve_pages(driver):
                page_count += 1
                normalized = [
                    cls._normalize_vulnerability(entry)
                    for entry in page
                    if str(entry.get("cve", {}).get("id", "")).strip()
                ]
                batches = cls._chunked(normalized, settings.CVE_SYNC_BATCH_SIZE)
                logger.info(
                    "Synchronisation CVE: page %s, %s CVE, %s batch(es)",
                    page_count,
                    len(normalized),
                    len(batches),
                )
                for batch in batches:
                    cls._execute_cypher_script(driver, cls._load_file(LOADER_FILE), {"batch": batch})
                    loaded_count += len(batch)

            cls._execute_cypher_script(driver, cls._load_file(INDEXES_FILE))
            if loaded_count > 0:
                logger.info("Synchronisation CVE terminee: %s enregistrement(s) traite(s)", loaded_count)
            else:
                logger.info("Synchronisation CVE terminee: aucune nouvelle CVE a charger")
            return loaded_count
        finally:
            driver.close()

    @staticmethod
    def _build_driver():
        uri = settings.NEO4J_URI.strip()
        if not uri:
            return None

        auth = None
        if settings.NEO4J_USER.strip():
            auth = (settings.NEO4J_USER, settings.NEO4J_PASSWORD)
        return GraphDatabase.driver(uri, auth=auth)

    @staticmethod
    def _load_file(path: Path) -> str:
        return Template(path.read_text(encoding="utf-8")).safe_substitute()

    @staticmethod
    def _split_cypher_statements(query: str) -> list[str]:
        return [statement.strip() for statement in query.split(";") if statement.strip()]

    @classmethod
    def _execute_cypher_script(
        cls,
        driver,
        query: str,
        parameters: dict[str, Any] | None = None,
    ) -> None:
        with driver.session(database=settings.NEO4J_DATABASE or None) as session:
            for statement in cls._split_cypher_statements(query):
                session.run(statement, parameters or {}).consume()

    @classmethod
    def _iter_recent_cve_pages(cls, driver):
        pub_start_date = cls._compute_pub_start_date(driver)
        pub_end_date = datetime.now(timezone.utc)
        total_results: int | None = None
        start_index = 0
        headers: dict[str, str] = {}

        if settings.NVD_API_KEY.strip():
            headers["apiKey"] = settings.NVD_API_KEY

        while total_results is None or start_index < total_results:
            params = {
                "startIndex": start_index,
                "resultsPerPage": settings.CVE_SYNC_RESULTS_PER_PAGE,
                "pubStartDate": cls._format_nvd_datetime(pub_start_date),
                "pubEndDate": cls._format_nvd_datetime(pub_end_date),
            }
            logger.info(
                "Verification CVE NVD: start=%s end=%s index=%s pageSize=%s",
                params["pubStartDate"],
                params["pubEndDate"],
                start_index,
                settings.CVE_SYNC_RESULTS_PER_PAGE,
            )
            response = requests.get(NVD_API_URL, params=params, headers=headers, timeout=120)
            response.raise_for_status()
            payload = response.json()
            total_results = int(payload.get("totalResults", 0))
            vulnerabilities = payload.get("vulnerabilities", [])
            logger.info(
                "NVD a retourne %s CVE sur cette page (%s/%s)",
                len(vulnerabilities),
                min(start_index + len(vulnerabilities), total_results),
                total_results,
            )
            yield vulnerabilities

            if not vulnerabilities:
                break

            start_index += len(vulnerabilities)
            if start_index < total_results and settings.NVD_API_DELAY_SECONDS > 0:
                cls._stop_event.wait(settings.NVD_API_DELAY_SECONDS)
                if cls._stop_event.is_set():
                    break

    @classmethod
    def _compute_pub_start_date(cls, driver) -> datetime:
        fallback = datetime.now(timezone.utc) - timedelta(days=settings.CVE_SYNC_INITIAL_LOOKBACK_DAYS)
        try:
            with driver.session(database=settings.NEO4J_DATABASE or None) as session:
                row = session.run(SYNC_STATE_QUERY).single()
                latest_published = row["latest_published"] if row else None
        except Neo4jError:
            logger.exception("Impossible de calculer la derniere date CVE; fallback utilise")
            return fallback

        if latest_published is None:
            return fallback

        if hasattr(latest_published, "to_native"):
            native = latest_published.to_native()
        elif hasattr(latest_published, "isoformat"):
            native = latest_published
        else:
            return fallback

        if isinstance(native, datetime):
            latest_dt = native if native.tzinfo else native.replace(tzinfo=timezone.utc)
            return latest_dt - timedelta(hours=settings.CVE_SYNC_OVERLAP_HOURS)

        return fallback

    @staticmethod
    def _format_nvd_datetime(value: datetime) -> str:
        utc_value = value.astimezone(timezone.utc)
        return utc_value.strftime("%Y-%m-%dT%H:%M:%S.000Z")

    @staticmethod
    def _first_english_description(items: list[dict[str, Any]] | None) -> str:
        for item in items or []:
            if str(item.get("lang", "")).lower() == "en":
                return str(item.get("value", "")).strip()
        return ""

    @staticmethod
    def _collect_attack_vectors(metrics: dict[str, Any]) -> list[dict[str, Any]]:
        vectors: list[dict[str, Any]] = []

        for metric in metrics.get("cvssMetricV31", []) or []:
            cvss = metric.get("cvssData", {})
            attack_vector = str(cvss.get("attackVector", "")).strip()
            if attack_vector:
                vectors.append({"name": attack_vector, "cvss_version": 3.1})

        for metric in metrics.get("cvssMetricV30", []) or []:
            cvss = metric.get("cvssData", {})
            attack_vector = str(cvss.get("attackVector", "")).strip()
            if attack_vector:
                vectors.append({"name": attack_vector, "cvss_version": 3.0})

        for metric in metrics.get("cvssMetricV2", []) or []:
            cvss = metric.get("cvssData", {})
            access_vector = str(cvss.get("accessVector", "")).strip()
            if access_vector:
                vectors.append({"name": access_vector, "cvss_version": 2.0})

        unique_vectors: dict[tuple[str, float], dict[str, Any]] = {}
        for vector in vectors:
            unique_vectors[(vector["name"], vector["cvss_version"])] = vector
        return list(unique_vectors.values())

    @staticmethod
    def _collect_weaknesses(weaknesses: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()

        for weakness in weaknesses or []:
            for description in weakness.get("description", []) or []:
                if str(description.get("lang", "")).lower() != "en":
                    continue
                cwe_id = str(description.get("value", "")).strip()
                if not cwe_id:
                    continue
                source = str(weakness.get("source", "")).strip()
                key = (cwe_id, source)
                if key in seen:
                    continue
                seen.add(key)
                results.append(
                    {
                        "cwe_id": cwe_id,
                        "source": source,
                        "type": str(weakness.get("type", "")).strip(),
                    }
                )
        return results

    @staticmethod
    def _normalize_version(cpe_match: dict[str, Any], cpe_parts: list[str]) -> str:
        raw_version = cpe_parts[5] if len(cpe_parts) > 5 else ""
        version = raw_version.strip() or "*"

        version_start_including = str(cpe_match.get("versionStartIncluding", "")).strip()
        version_start_excluding = str(cpe_match.get("versionStartExcluding", "")).strip()
        version_end_including = str(cpe_match.get("versionEndIncluding", "")).strip()
        version_end_excluding = str(cpe_match.get("versionEndExcluding", "")).strip()

        range_parts: list[str] = []
        if version_start_including:
            range_parts.append(f"from:{version_start_including}")
        if version_start_excluding:
            range_parts.append(f"after:{version_start_excluding}")
        if version_end_including:
            range_parts.append(f"to:{version_end_including}")
        if version_end_excluding:
            range_parts.append(f"before:{version_end_excluding}")

        if range_parts:
            return f"{version} [{' | '.join(range_parts)}]"
        return version

    @classmethod
    def _collect_affected_products(
        cls,
        configurations: list[dict[str, Any]] | None,
    ) -> list[dict[str, Any]]:
        affected: list[dict[str, Any]] = []
        seen_keys: set[str] = set()

        def visit_nodes(nodes: list[dict[str, Any]] | None) -> None:
            for node in nodes or []:
                for cpe_match in node.get("cpeMatch", []) or []:
                    if not cpe_match.get("vulnerable", False):
                        continue

                    criteria = str(cpe_match.get("criteria", "")).strip()
                    parts = criteria.split(":")
                    if len(parts) < 6:
                        continue

                    vendor = parts[3].strip()
                    product = parts[4].strip()
                    version = cls._normalize_version(cpe_match, parts)

                    if not vendor or not product:
                        continue

                    product_version_key = f"{vendor}|{product}|{version}|{criteria}"
                    if product_version_key in seen_keys:
                        continue
                    seen_keys.add(product_version_key)

                    affected.append(
                        {
                            "vendor": vendor,
                            "product": product,
                            "version": version,
                            "criteria": criteria,
                            "match_criteria_id": str(cpe_match.get("matchCriteriaId", "")).strip(),
                        }
                    )

                visit_nodes(node.get("children", []))

        for configuration in configurations or []:
            visit_nodes(configuration.get("nodes", []))

        return affected

    @staticmethod
    def _flatten_metric_fields(metrics: dict[str, Any]) -> dict[str, Any]:
        payload: dict[str, Any] = {}

        v2 = (metrics.get("cvssMetricV2") or [None])[0] or {}
        v2_cvss = v2.get("cvssData", {}) or {}
        payload["v2_access_complexity"] = v2_cvss.get("accessComplexity")
        payload["v2_access_vector"] = v2_cvss.get("accessVector")
        payload["v2_authentication"] = v2_cvss.get("authentication")
        payload["v2_availability_impact"] = v2_cvss.get("availabilityImpact")
        payload["v2_base_score"] = v2_cvss.get("baseScore")
        payload["v2_confidentiality_impact"] = v2_cvss.get("confidentialityImpact")
        payload["v2_integrity_impact"] = v2_cvss.get("integrityImpact")
        payload["v2_vector_string"] = v2_cvss.get("vectorString")
        payload["v2_base_severity"] = v2.get("baseSeverity")
        payload["v2_exploitability_score"] = v2.get("exploitabilityScore")
        payload["v2_impact_score"] = v2.get("impactScore")
        payload["v2_obtain_all_privilege"] = v2.get("obtainAllPrivilege")
        payload["v2_obtain_other_privilege"] = v2.get("obtainOtherPrivilege")
        payload["v2_obtain_user_privilege"] = v2.get("obtainUserPrivilege")
        payload["v2_user_interaction_required"] = v2.get("userInteractionRequired")

        v31 = (metrics.get("cvssMetricV31") or [None])[0] or {}
        v31_cvss = v31.get("cvssData", {}) or {}
        payload["v31_attack_complexity"] = v31_cvss.get("attackComplexity")
        payload["v31_attack_vector"] = v31_cvss.get("attackVector")
        payload["v31_availability_impact"] = v31_cvss.get("availabilityImpact")
        payload["v31_base_score"] = v31_cvss.get("baseScore")
        payload["v31_base_severity"] = v31_cvss.get("baseSeverity")
        payload["v31_confidentiality_impact"] = v31_cvss.get("confidentialityImpact")
        payload["v31_integrity_impact"] = v31_cvss.get("integrityImpact")
        payload["v31_privileges_required"] = v31_cvss.get("privilegesRequired")
        payload["v31_scope"] = v31_cvss.get("scope")
        payload["v31_user_interaction"] = v31_cvss.get("userInteraction")
        payload["v31_vector_string"] = v31_cvss.get("vectorString")
        payload["v31_exploitability_score"] = v31.get("exploitabilityScore")
        payload["v31_impact_score"] = v31.get("impactScore")

        v30 = (metrics.get("cvssMetricV30") or [None])[0] or {}
        v30_cvss = v30.get("cvssData", {}) or {}
        payload["v30_attack_complexity"] = v30_cvss.get("attackComplexity")
        payload["v30_attack_vector"] = v30_cvss.get("attackVector")
        payload["v30_availability_impact"] = v30_cvss.get("availabilityImpact")
        payload["v30_base_score"] = v30_cvss.get("baseScore")
        payload["v30_base_severity"] = v30_cvss.get("baseSeverity")
        payload["v30_confidentiality_impact"] = v30_cvss.get("confidentialityImpact")
        payload["v30_integrity_impact"] = v30_cvss.get("integrityImpact")
        payload["v30_privileges_required"] = v30_cvss.get("privilegesRequired")
        payload["v30_scope"] = v30_cvss.get("scope")
        payload["v30_user_interaction"] = v30_cvss.get("userInteraction")
        payload["v30_vector_string"] = v30_cvss.get("vectorString")
        payload["v30_exploitability_score"] = v30.get("exploitabilityScore")
        payload["v30_impact_score"] = v30.get("impactScore")

        return payload

    @classmethod
    def _normalize_vulnerability(cls, entry: dict[str, Any]) -> dict[str, Any]:
        cve = entry.get("cve", {})
        metrics = cve.get("metrics", {}) or {}
        descriptions = cve.get("descriptions", []) or []
        weaknesses = cve.get("weaknesses", []) or []
        configurations = cve.get("configurations", []) or []

        normalized: dict[str, Any] = {
            "cve_id": str(cve.get("id", "")).strip(),
            "description": cls._first_english_description(descriptions),
            "descriptions": [
                item.get("value")
                for item in descriptions
                if str(item.get("lang", "")).lower() == "en"
            ],
            "published": cve.get("published"),
            "last_modified": cve.get("lastModified"),
            "attack_vectors": cls._collect_attack_vectors(metrics),
            "weaknesses": cls._collect_weaknesses(weaknesses),
            "affected_products": cls._collect_affected_products(configurations),
        }
        normalized.update(cls._flatten_metric_fields(metrics))
        return normalized

    @staticmethod
    def _chunked(items: list[dict[str, Any]], size: int) -> list[list[dict[str, Any]]]:
        return [items[index:index + size] for index in range(0, len(items), size)]

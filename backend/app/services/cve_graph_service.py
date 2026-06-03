from __future__ import annotations

import logging
import re
from collections import OrderedDict
from typing import Any

from neo4j import GraphDatabase
from neo4j.exceptions import Neo4jError, TransientError

try:
    from neo4j.exceptions import BoltHandshakeError
except ImportError:
    try:
        from neo4j._exceptions import BoltHandshakeError  # type: ignore
    except ImportError:
        class BoltHandshakeError(Exception):
            pass

from app.core.config import settings

logger = logging.getLogger(__name__)


TECH_TERM_MAP: dict[str, list[str]] = {
    "REACT": ["react"],
    "ANGULAR": ["angular"],
    "VUE": ["vue"],
    "NEXTJS": ["next.js", "nextjs"],
    "DJANGO": ["django"],
    "FASTAPI": ["fastapi"],
    "SPRING_BOOT": ["spring", "spring boot"],
    "EXPRESS": ["express", "node.js"],
    "NESTJS": ["nestjs", "nest"],
    "POSTGRESQL": ["postgresql", "postgres"],
    "MYSQL": ["mysql"],
    "MARIADB": ["mariadb"],
    "MONGODB": ["mongodb"],
    "REDIS": ["redis"],
    "ELASTICSEARCH": ["elasticsearch"],
    "OPENSEARCH": ["opensearch"],
    "KAFKA": ["kafka"],
    "RABBITMQ": ["rabbitmq"],
    "IBM_MQ": ["ibm mq"],
    "KEYCLOAK": ["keycloak"],
    "OKTA": ["okta"],
    "AZURE_AD": ["azure ad", "entra id"],
    "ADFS": ["adfs"],
    "AWS_RDS_POSTGRES": ["postgresql", "postgres"],
    "AWS_RDS_MYSQL": ["mysql"],
    "AWS_AURORA": ["aurora"],
    "AWS_DYNAMODB": ["dynamodb"],
    "AZURE_SQL": ["azure sql"],
    "AZURE_POSTGRES": ["postgresql", "postgres"],
    "AZURE_MYSQL": ["mysql"],
    "AZURE_COSMOS": ["cosmos db"],
    "GCP_CLOUDSQL_POSTGRES": ["postgresql", "postgres"],
    "GCP_CLOUDSQL_MYSQL": ["mysql"],
    "GCP_ALLOYDB": ["alloydb"],
    "GCP_FIRESTORE": ["firestore"],
    "GCP_BIGTABLE": ["bigtable"],
    "APACHE": ["apache"],
    "AIRFLOW": ["airflow"],
    "QUARTZ": ["quartz"],
    "PGVECTOR": ["postgresql", "postgres", "pgvector"],
    "WEAVIATE": ["weaviate"],
    "QDRANT": ["qdrant"],
    "MILVUS": ["milvus"],
    "FAISS": ["faiss"],
    "MISTRAL": ["mistral"],
    "GEMINI": ["gemini"],
    "OPENAI": ["openai"],
    "AZURE_OPENAI": ["azure openai", "openai"],
}

QUESTION_CODES_FOR_STACK = {
    "FRONTEND_TECH",
    "FRAMEWORK_BACKEND",
    "MOBILE_PLATEFORM",
    "API_STANDARD",
    "AUTH_PROTOCOL",
    "MICRO_PROTOCOL",
    "DB_LOCAL_REL",
    "DB_LOCAL_NOSQL",
    "DB_AWS_REL",
    "DB_AWS_NOSQL",
    "DB_AZURE_REL",
    "DB_AZURE_NOSQL",
    "DB_GCP_REL",
    "DB_GCP_NOSQL",
    "BROKER_TECH",
    "BROKER_PROTOCOL",
    "TASK_EXECUTOR_TECH",
    "FILE_STORAGE",
    "EXTERNAL_API_PROTOCOL",
    "UPLOAD_PROTOCOL",
    "EMAIL_PROTOCOL",
    "IDP_PROVIDER",
    "LLM_TECHNOLOGY",
    "LLM_EXTERNAL_PROVIDER",
    "RAG_VECTOR_DB",
}


class CveGraphService:
    _driver = None
    _disabled_reason: str | None = None

    @classmethod
    def _disabled_payload(cls) -> dict[str, Any]:
        return {
            "enabled": False,
            "disabled_reason": cls._disabled_reason
            or "Le module Neo4j CVE n'est pas disponible.",
        }

    @staticmethod
    def is_enabled() -> bool:
        return (
            settings.NEO4J_ENABLED
            and bool(settings.NEO4J_URI.strip())
            and CveGraphService._disabled_reason is None
        )

    @classmethod
    def _disable(cls, reason: str):
        if cls._disabled_reason is None:
            logger.error("Module CVE Neo4j desactive: %s", reason)
        cls._disabled_reason = reason
        cls._driver = None

    @classmethod
    def _get_driver(cls):
        if not cls.is_enabled():
            return None

        if cls._driver is None:
            auth = None
            if settings.NEO4J_USER.strip():
                auth = (settings.NEO4J_USER, settings.NEO4J_PASSWORD)
            try:
                cls._driver = GraphDatabase.driver(settings.NEO4J_URI, auth=auth)
            except Exception as exc:
                cls._disable(f"initialisation driver impossible: {exc}")
                return None
        return cls._driver

    @staticmethod
    def _normalize_neo4j_value(value: Any) -> Any:
        if value is None:
            return None
        if isinstance(value, list):
            return [CveGraphService._normalize_neo4j_value(item) for item in value]
        if isinstance(value, dict):
            return {
                key: CveGraphService._normalize_neo4j_value(item)
                for key, item in value.items()
            }
        if hasattr(value, "iso_format"):
            return value.iso_format()
        if hasattr(value, "isoformat"):
            return value.isoformat()
        return value

    @staticmethod
    def _run_query(query: str, parameters: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        driver = CveGraphService._get_driver()
        if driver is None:
            return []

        try:
            with driver.session(database=settings.NEO4J_DATABASE or None) as session:
                result = session.run(query, parameters or {})
                return [
                    {
                        key: CveGraphService._normalize_neo4j_value(value)
                        for key, value in record.data().items()
                    }
                    for record in result
                ]
        except BoltHandshakeError as exc:
            CveGraphService._disable(
                "serveur Neo4j incompatible avec le driver Bolt configure. "
                "Verifier la version du serveur ou l'URI utilisee."
            )
            logger.exception("Handshake Bolt Neo4j incompatible")
            return []
        except TransientError:
            logger.exception("Neo4j a refuse la requete par manque de memoire transactionnelle")
            return []
        except Neo4jError:
            logger.exception("Echec requete Neo4j")
            return []
        except Exception:
            logger.exception("Erreur inattendue Neo4j")
            return []

    @staticmethod
    def extract_search_terms(*, answers: dict[str, Any] | None = None, app_description: str = "") -> list[str]:
        ordered_terms: OrderedDict[str, None] = OrderedDict()
        known_terms = {
            item
            for mapped_terms in TECH_TERM_MAP.values()
            for item in mapped_terms
        }

        for question_code, answer in (answers or {}).items():
            if question_code in QUESTION_CODES_FOR_STACK:
                if isinstance(answer, list):
                    values = [str(item).strip().upper() for item in answer if str(item).strip()]
                else:
                    values = [str(answer).strip().upper()] if str(answer).strip() else []

                for value in values:
                    for mapped_term in TECH_TERM_MAP.get(value, [value.replace("_", " ").lower()]):
                        cleaned = mapped_term.strip().lower()
                        if cleaned:
                            ordered_terms[cleaned] = None
                continue

            if not question_code.endswith("_VERSION"):
                continue

            version_value = str(answer or "").strip().lower()
            if not version_value:
                continue

            ordered_terms[version_value] = None
            for token in re.findall(r"[a-zA-Z0-9][a-zA-Z0-9.+#-]*", version_value):
                cleaned = token.strip().lower()
                if cleaned:
                    ordered_terms[cleaned] = None

        description_tokens = re.findall(r"[a-zA-Z0-9.+#-]{3,}", app_description.lower())
        for token in description_tokens:
            if token in {
                "application", "interne", "externe", "utilise", "utilisee", "chatbot",
                "llm", "rag", "base", "donnees", "systeme", "service", "client",
            }:
                continue
            if token in known_terms:
                ordered_terms[token] = None

        return list(ordered_terms.keys())[:20]

    @staticmethod
    def search_cves_by_terms(terms: list[str], limit: int = 12) -> list[dict[str, Any]]:
        normalized_terms = [term.strip().lower() for term in terms if term.strip()]
        if not normalized_terms:
            return []

        query = """
        UNWIND $terms AS term
        CALL (term) {
            MATCH (cve:CVE)
            WHERE toLower(cve.name) CONTAINS term
            RETURN DISTINCT cve

            UNION

            MATCH (v:Vendor)<-[:MADE_BY]-(p:Product)<-[:VERSION_OF]-(pv:ProductVersion)<-[:AFFECTS]-(cve:CVE)
            WHERE toLower(v.name) CONTAINS term
            RETURN DISTINCT cve

            UNION

            MATCH (p:Product)<-[:VERSION_OF]-(pv:ProductVersion)<-[:AFFECTS]-(cve:CVE)
            WHERE toLower(p.name) CONTAINS term
            RETURN DISTINCT cve

            UNION

            MATCH (pv:ProductVersion)<-[:AFFECTS]-(cve:CVE)
            WHERE toLower(coalesce(pv.version_value, pv.name, "")) CONTAINS term
            RETURN DISTINCT cve
        }
        WITH
            cve,
            collect(DISTINCT term) AS matched_terms,
            coalesce(cve.`v31.base_score`, cve.`v30.base_score`, cve.`v2.base_score`, 0) AS score,
            cve.published AS published
        ORDER BY score DESC, published DESC
        LIMIT $limit
        OPTIONAL MATCH (cve)-[:AFFECTS]->(pv:ProductVersion)-[:VERSION_OF]->(p:Product)-[:MADE_BY]->(v:Vendor)
        OPTIONAL MATCH (cve)-[:ATTACKABLE_THROUGH]->(av:AttackVector)
        RETURN
            cve.name AS cve_id,
            coalesce(head(cve.description), cve.summary, "") AS description,
            head(collect(DISTINCT v.name)) AS vendor,
            head(collect(DISTINCT p.name)) AS product,
            head(collect(DISTINCT coalesce(pv.version_value, pv.name))) AS product_version,
            collect(DISTINCT av.name) AS attack_vectors,
            coalesce(cve.`v31.base_severity`, cve.`v30.base_severity`, cve.`v2.base_severity`) AS severity,
            score AS base_score,
            published AS published,
            matched_terms
        ORDER BY score DESC, published DESC
        """
        rows = CveGraphService._run_query(query, {"terms": normalized_terms, "limit": limit})

        unique_rows: OrderedDict[str, dict[str, Any]] = OrderedDict()
        for row in rows:
            cve_id = str(row.get("cve_id") or "").strip()
            if cve_id and cve_id not in unique_rows:
                unique_rows[cve_id] = row
        return list(unique_rows.values())

    @staticmethod
    def get_cve_graph_neighbors(cve_ids: list[str]) -> dict[str, dict[str, Any]]:
        normalized_ids = [str(cve_id or "").strip().upper() for cve_id in cve_ids if str(cve_id or "").strip()]
        if not normalized_ids:
            return {}

        query = """
        UNWIND $cve_ids AS cve_id
        MATCH (cve:CVE {name: cve_id})
        OPTIONAL MATCH (cve)-[:HAS_WEAKNESS]->(weakness:Weakness)
        OPTIONAL MATCH (weakness)-[:RELATED_ATTACK_PATTERN]->(capec:CAPEC)
        OPTIONAL MATCH (weakness)-[rel:RELATED_TECHNIQUE]->(technique:MitreTechnique)
        OPTIONAL MATCH (cve)-[:KNOWN_EXPLOITED]->(kev:KEVEntry)
        RETURN
            cve.name AS cve_id,
            [item IN collect(DISTINCT weakness.cwe_id) WHERE item IS NOT NULL] AS cwe_ids,
            [item IN collect(DISTINCT capec.capec_id) WHERE item IS NOT NULL] AS capec_ids,
            [item IN collect(DISTINCT technique.technique_id) WHERE item IS NOT NULL] AS mitre_techniques,
            [item IN collect(DISTINCT rel.framework) WHERE item IS NOT NULL] AS mitre_frameworks,
            count(DISTINCT kev) > 0 AS kev_known_exploited
        """
        rows = CveGraphService._run_query(query, {"cve_ids": normalized_ids})

        payload: dict[str, dict[str, Any]] = {}
        for row in rows:
            cve_id = str(row.get("cve_id") or "").strip().upper()
            if not cve_id:
                continue
            payload[cve_id] = {
                "cwe_ids": row.get("cwe_ids") or [],
                "capec_ids": row.get("capec_ids") or [],
                "mitre_techniques": row.get("mitre_techniques") or [],
                "mitre_frameworks": row.get("mitre_frameworks") or [],
                "kev_known_exploited": bool(row.get("kev_known_exploited")),
            }
        return payload

    @staticmethod
    def _fetch_latest_cves(limit: int = 30) -> list[dict[str, Any]]:
        query = """
        MATCH (cve:CVE)
        WHERE cve.published IS NOT NULL
        WITH cve
        ORDER BY cve.published DESC
        LIMIT $limit
        OPTIONAL MATCH (cve)-[:AFFECTS]->(pv:ProductVersion)-[:VERSION_OF]->(p:Product)-[:MADE_BY]->(v:Vendor)
        OPTIONAL MATCH (cve)-[:ATTACKABLE_THROUGH]->(av:AttackVector)
        RETURN
            cve.name AS cve_id,
            coalesce(head(cve.description), cve.summary, "") AS description,
            head(collect(DISTINCT v.name)) AS vendor,
            head(collect(DISTINCT p.name)) AS product,
            head(collect(DISTINCT coalesce(pv.version_value, pv.name))) AS product_version,
            collect(DISTINCT av.name) AS attack_vectors,
            coalesce(cve.`v31.base_severity`, cve.`v30.base_severity`, cve.`v2.base_severity`) AS severity,
            coalesce(cve.`v31.base_score`, cve.`v30.base_score`, cve.`v2.base_score`) AS base_score,
            cve.published AS published
        ORDER BY cve.published DESC
        """
        return CveGraphService._run_query(query, {"limit": limit})

    @staticmethod
    def build_attack_intelligence_context(*, answers: dict[str, Any] | None = None, app_description: str = "") -> dict[str, Any]:
        terms = CveGraphService.extract_search_terms(answers=answers, app_description=app_description)
        matches = CveGraphService.search_cves_by_terms(terms)

        if not matches:
            return {
                "enabled": CveGraphService.is_enabled(),
                "terms": terms,
                "matches": [],
                "context_text": "Aucune CVE specifique n a ete recuperee depuis le graphe pour le contexte applicatif.",
            }

        lines = [
            "Contexte CVE issu du knowledge graph Neo4j :",
        ]
        for match in matches[:8]:
            description = str(match.get("description") or "").replace("\n", " ").strip()
            short_description = description[:260] + ("..." if len(description) > 260 else "")
            attack_vectors = ", ".join(str(item).strip() for item in (match.get("attack_vectors") or []) if str(item).strip())
            lines.append(
                "- "
                f"{match.get('cve_id')} | produit={match.get('product') or '?'} | "
                f"editeur={match.get('vendor') or '?'} | score={match.get('base_score') or '?'} | "
                f"severite={match.get('severity') or '?'} | vecteurs={attack_vectors or 'non_precise'} | "
                f"description={short_description}"
            )

        lines.append("Utiliser ces CVE comme inspiration technique pour rendre les scenarios plausibles, specifiques et coherents.")

        return {
            "enabled": True,
            "terms": terms,
            "matches": matches,
            "context_text": "\n".join(lines),
        }

    @staticmethod
    def get_graph_stats() -> dict[str, Any]:
        if not CveGraphService.is_enabled():
            return {
                **CveGraphService._disabled_payload(),
                "vendor_count": 0,
                "product_count": 0,
                "version_count": 0,
                "cve_count": 0,
                "attack_vector_count": 0,
                "critical_cve_count": 0,
                "latest_cves": [],
            }

        stats_query = """
        CALL () {
            MATCH (n:Vendor)
            RETURN count(n) AS vendor_count
        }
        CALL () {
            MATCH (n:Product)
            RETURN count(n) AS product_count
        }
        CALL () {
            MATCH (n:ProductVersion)
            RETURN count(n) AS version_count
        }
        CALL () {
            MATCH (n:CVE)
            RETURN count(n) AS cve_count
        }
        CALL () {
            MATCH (n:AttackVector)
            RETURN count(n) AS attack_vector_count
        }
        CALL () {
            MATCH (c:CVE)
            WHERE coalesce(c.`v31.base_score`, c.`v30.base_score`, c.`v2.base_score`, 0) >= 9
            RETURN count(c) AS critical_cve_count
        }
        RETURN vendor_count, product_count, version_count, cve_count, attack_vector_count, critical_cve_count
        """
        stats_rows = CveGraphService._run_query(stats_query)
        latest_rows = CveGraphService._fetch_latest_cves(30)
        payload = stats_rows[0] if stats_rows else {}
        payload["enabled"] = True
        payload["disabled_reason"] = None
        payload["latest_cves"] = latest_rows
        return payload

    @staticmethod
    def search_graph(query_text: str, limit: int = 20) -> dict[str, Any]:
        query_text = (query_text or "").strip()
        if not CveGraphService.is_enabled():
            return {
                **CveGraphService._disabled_payload(),
                "query": query_text,
                "extracted_terms": [],
                "nodes": [],
                "edges": [],
                "matches": [],
            }

        extracted_terms = [query_text.lower()] if query_text else []
        if extracted_terms:
            rows = CveGraphService.search_cves_by_terms(extracted_terms, limit=limit)
        else:
            rows = CveGraphService._fetch_latest_cves(limit=min(limit, 30))

        nodes: OrderedDict[str, dict[str, Any]] = OrderedDict()
        edges: OrderedDict[str, dict[str, Any]] = OrderedDict()

        for row in rows:
            vendor_name = str(row.get("vendor") or "").strip()
            product_name = str(row.get("product") or "").strip()
            version_name = str(row.get("product_version") or "").strip()
            cve_id = str(row.get("cve_id") or "").strip()

            vendor_id = f"vendor::{vendor_name}" if vendor_name else ""
            product_id = f"product::{vendor_name}::{product_name}" if product_name else ""
            version_id = f"version::{vendor_name}::{product_name}::{version_name}" if version_name else ""
            cve_node_id = f"cve::{cve_id}" if cve_id else ""

            if vendor_id:
                nodes[vendor_id] = {
                    "id": vendor_id,
                    "label": vendor_name,
                    "node_type": "Vendor",
                    "name": vendor_name,
                    "metadata": {},
                }
            if product_id:
                nodes[product_id] = {
                    "id": product_id,
                    "label": product_name,
                    "node_type": "Product",
                    "name": product_name,
                    "metadata": {"vendor": vendor_name},
                }
            if version_id:
                nodes[version_id] = {
                    "id": version_id,
                    "label": version_name,
                    "node_type": "ProductVersion",
                    "name": version_name,
                    "metadata": {"product": product_name},
                }
            if cve_node_id:
                nodes[cve_node_id] = {
                    "id": cve_node_id,
                    "label": cve_id,
                    "node_type": "CVE",
                    "name": cve_id,
                    "score": row.get("base_score"),
                    "metadata": {
                        "severity": row.get("severity"),
                        "description": row.get("description"),
                    },
                }

            if vendor_id and product_id:
                edges[f"{product_id}->{vendor_id}"] = {"source": product_id, "target": vendor_id, "label": "MADE_BY"}
            if product_id and version_id:
                edges[f"{version_id}->{product_id}"] = {"source": version_id, "target": product_id, "label": "VERSION_OF"}
            if cve_node_id and version_id:
                edges[f"{cve_node_id}->{version_id}"] = {"source": cve_node_id, "target": version_id, "label": "AFFECTS"}

            for attack_vector in row.get("attack_vectors") or []:
                vector_name = str(attack_vector or "").strip()
                if not vector_name:
                    continue
                vector_id = f"vector::{vector_name}"
                nodes[vector_id] = {
                    "id": vector_id,
                    "label": vector_name,
                    "node_type": "AttackVector",
                    "name": vector_name,
                    "metadata": {},
                }
                if cve_node_id:
                    edges[f"{cve_node_id}->{vector_id}"] = {
                        "source": cve_node_id,
                        "target": vector_id,
                        "label": "ATTACKABLE_THROUGH",
                    }

        return {
            "enabled": True,
            "disabled_reason": None,
            "query": query_text,
            "extracted_terms": extracted_terms,
            "nodes": list(nodes.values()),
            "edges": list(edges.values()),
            "matches": rows,
        }

from datetime import datetime
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape
from weasyprint import HTML

from app.services.minio_service import MinioService

REPORT_TEMPLATE_NAME = "new_one copy.html"


def _extract_text_entries(values, *, preferred_keys: tuple[str, ...] = ()) -> list[str]:
    entries = values if isinstance(values, list) else [values]
    normalized: list[str] = []

    for entry in entries:
        if isinstance(entry, dict):
            text_value = ""
            for key in preferred_keys:
                candidate = str(entry.get(key) or "").strip()
                if candidate:
                    text_value = candidate
                    break
        else:
            text_value = str(entry or "").strip()

        if text_value:
            normalized.append(text_value)

    return normalized


def _flatten_attack_scenarios(selected_threats: list[dict]) -> list[dict]:
    scenarios = []
    for threat in selected_threats:
        raw_scenarios = (
            threat.get("attack_scenarios")
            or threat.get("scenarios")
            or threat.get("attack_scenario")
            or []
        )
        for scenario_text in _extract_text_entries(
            raw_scenarios,
            preferred_keys=("description", "attack_scenario", "scenario", "name", "title"),
        ):
            if not scenario_text:
                continue
            scenarios.append(
                {
                    "threat_name": threat.get("name", ""),
                    "description": scenario_text,
                }
            )
    return scenarios


def _flatten_mitigations(selected_threats: list[dict]) -> list[dict]:
    seen = set()
    mitigations = []

    for threat in selected_threats:
        raw_mitigations = threat.get("mitigations") or threat.get("requirements") or []
        for mitigation_text in _extract_text_entries(
            raw_mitigations,
            preferred_keys=("description", "exigence", "requirement", "title", "name"),
        ):
            if not mitigation_text:
                continue

            dedupe_key = mitigation_text.lower()
            if dedupe_key in seen:
                continue

            seen.add(dedupe_key)
            mitigations.append({"description": mitigation_text})

    return mitigations


def _build_requirements(mitigations: list[dict]) -> list[dict]:
    requirements = []
    for index, mitigation in enumerate(mitigations, start=1):
        requirements.append(
            {
                "id": f"TM-{index:02d}",
                "exigence": mitigation.get("description", ""),
                "status": "A implémenter",
            }
        )
    return requirements


def _build_template_threats(selected_threats: list[dict]) -> list[dict]:
    template_threats = []

    for threat in selected_threats:
        threat_name = str(threat.get("name") or "").strip()
        description = str(threat.get("description") or "").strip()
        raw_scenarios = (
            threat.get("attack_scenarios")
            or threat.get("scenarios")
            or threat.get("attack_scenario")
            or []
        )

        scenarios = []
        for scenario_text in _extract_text_entries(
            raw_scenarios,
            preferred_keys=("description", "attack_scenario", "scenario", "name", "title"),
        ):
            scenarios.append({"description": scenario_text})

        template_threats.append(
            {
                "name": threat_name,
                "description": description,
                "scenarios": scenarios,
            }
        )

    return template_threats


def _build_requirements_from_threats(selected_threats: list[dict]) -> list[dict]:
    fallback_requirements = []

    for index, threat in enumerate(selected_threats, start=1):
        threat_name = str(threat.get("name") or "").strip() or f"Menace {index}"
        fallback_requirements.append(
            {
                "id": f"TM-{index:02d}",
                "exigence": (
                    f"Definir et mettre en oeuvre des mesures de reduction du risque pour la menace "
                    f"'{threat_name}'."
                ),
                "status": "A analyser",
            }
        )

    return fallback_requirements


def build_safe_slug(value: str) -> str:
    cleaned = "".join(ch.lower() if ch.isalnum() else "-" for ch in (value or "").strip())
    compact = "-".join(part for part in cleaned.split("-") if part)
    return compact or "rapport"


def generate_report_pdf(
    app_name: str,
    developer_name: str,
    generated_description: str,
    selected_threats: list[dict],
    dfd_image_path: str | None = None,
    dfd_reference: str | None = None,
    application_version: str = "v1",
    report_file_name: str | None = None,
) -> str:
    base_dir = Path(__file__).resolve().parents[2]
    template_dir = base_dir / "resources" / "templates"
    out_dir = base_dir / "resources" / "out"
    pdf_dir = base_dir / "resources" / "pdf"
    assets_dir = base_dir / "resources" / "assets"

    out_dir.mkdir(parents=True, exist_ok=True)
    pdf_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    file_name = report_file_name or f"threat_modeling_report_{timestamp}.pdf"
    html_path = out_dir / f"{Path(file_name).stem}.html"
    pdf_path = pdf_dir / file_name

    logo_file = assets_dir / "AWB_LOGO.png"
    logo_path = logo_file.resolve().as_uri() if logo_file.exists() else None
    cover_bg_file = assets_dir / "logo-awb-x2.png"
    cover_bg_path = cover_bg_file.resolve().as_uri() if cover_bg_file.exists() else None

    dfd_uri = None
    if dfd_image_path:
        minio_location = MinioService.parse_minio_uri(dfd_image_path)
        if minio_location:
            bucket_name, object_key = minio_location
            temp_dfd_path = MinioService.download_object_to_temp_file(
                bucket_name=bucket_name,
                object_key=object_key,
                suffix=Path(object_key).suffix,
            )
            dfd_uri = Path(temp_dfd_path).resolve().as_uri()
        else:
            dfd_file = Path(dfd_image_path)
            if dfd_file.exists():
                dfd_uri = dfd_file.resolve().as_uri()

    threats_table = []
    for threat in selected_threats:
        threats_table.append(
            {
                "menace": threat.get("name", ""),
                "description": threat.get("description", "") or "—",
            }
        )

    attack_scenarios = _flatten_attack_scenarios(selected_threats)
    mitigations = _flatten_mitigations(selected_threats)
    template_threats = _build_template_threats(selected_threats)

    report_date = datetime.now()
    report_date_display = report_date.strftime("%d/%m/%Y")
    version_label = application_version.upper() if application_version else "V1"

    env = Environment(
        loader=FileSystemLoader(str(template_dir)),
        autoescape=select_autoescape(["html", "xml"]),
    )
    template = env.get_template(REPORT_TEMPLATE_NAME)

    requirements = _build_requirements(mitigations)
    if not requirements:
        requirements = _build_requirements_from_threats(selected_threats)
    report_data = {
        "company_name": "Attijariwafa Bank",
        "document_title": "DOCUMENT DE SECURITE TECHNIQUE",
        "application_name": app_name or "Application",
        "application_version": application_version,
        "application_env": "Production",
        "author": developer_name.strip() or "Non renseigne",
        "classification": "GENERAL INTERNE GROUPE",
        "report_ref": f"TM-{timestamp}",
        "version": version_label,
        "report_date": report_date_display,
        "tech_stack": "FastAPI / Mistral / Gemini / pytm / WeasyPrint",
        "application_description": generated_description.strip() or "Description indisponible.",
        "dfd_image": dfd_uri,
        "dfd_level": "Niveau 0",
        "dfd_caption": "Figure 1 - Diagramme de flux de donnees et frontieres de confiance.",
        "dfd_reference": dfd_reference or "DFD-01",
        "threats_table": threats_table,
        "threats": template_threats,
        "attack_scenarios": attack_scenarios,
        "mitigations": mitigations,
        "requirements": requirements,
        "total_threats": len(threats_table),
        "logo_path": logo_path,
        "cover_bg_path": cover_bg_path,
        "versions": [
            {
                "version": version_label,
                "date": report_date_display,
                "object": "Version initiale du rapport de modelisation des menaces",
                "author": developer_name.strip() or "Securite Operationnelle",
            }
        ],
        "annexes": [
            "Diagramme de flux de donnees (DFD)",
            "Catalogue des menaces retenues",
            "Scenarios d attaque analyses",
            "Synthese des exigences techniques",
        ],
    }

    rendered_html = template.render(**report_data)
    html_path.write_text(rendered_html, encoding="utf-8")

    HTML(string=rendered_html, base_url=str(base_dir.resolve())).write_pdf(str(pdf_path))
    return str(pdf_path)

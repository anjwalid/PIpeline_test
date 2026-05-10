from __future__ import annotations

import argparse
import sys
from pathlib import Path


CURRENT_FILE = Path(__file__).resolve()
BACKEND_DIR = CURRENT_FILE.parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.services.report_service import generate_report_pdf  # noqa: E402


def build_sample_threats() -> list[dict]:
    return [
        {
            "name": "Spoofing",
            "description": "Usurpation d'identite d'un utilisateur ou d'un service interne.",
            "attack_scenarios": [
                "Un attaquant reutilise un token non expire pour acceder a des donnees sensibles.",
                "Un service malveillant se fait passer pour une API interne sans verification mutuelle.",
            ],
            "mitigations": [
                "Mettre en place une authentification forte et une rotation reguliere des secrets.",
                "Activer la validation stricte des JWT et limiter leur duree de vie.",
            ],
        },
        {
            "name": "Information Disclosure",
            "description": "Exposition non autorisee de donnees metier ou techniques.",
            "attack_scenarios": [
                "Des journaux applicatifs exposent des identifiants techniques et des informations personnelles.",
                "Une mauvaise configuration d'autorisation permet l'acces a des rapports d'autres utilisateurs.",
            ],
            "mitigations": [
                "Masquer les donnees sensibles dans les logs et activer une politique de retention adaptee.",
                "Appliquer un controle d'acces strict sur les ressources et les endpoints de telechargement.",
            ],
        },
        {
            "name": "Denial of Service",
            "description": "Saturation des ressources applicatives ou des services dependants.",
            "attack_scenarios": [
                "Un grand volume de requetes simultanees surcharge le moteur de generation des rapports PDF.",
            ],
            "mitigations": [
                "Mettre en place du rate limiting sur les endpoints de generation de rapport.",
                "Isoler les traitements lourds et appliquer des timeouts sur les appels externes.",
            ],
        },
    ]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Genere un PDF de test pour verifier le template new_one.html."
    )
    parser.add_argument(
        "--dfd-path",
        dest="dfd_path",
        default=None,
        help="Chemin optionnel vers une image DFD locale a injecter dans le template.",
    )
    parser.add_argument(
        "--app-name",
        dest="app_name",
        default="Plateforme AWB Test",
        help="Nom de l'application a afficher dans le rapport.",
    )
    parser.add_argument(
        "--developer",
        dest="developer_name",
        default="Equipe Securite",
        help="Nom de l'auteur du rapport.",
    )
    parser.add_argument(
        "--version",
        dest="application_version",
        default="v1",
        help="Version applicative a afficher dans le rapport.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    dfd_path = args.dfd_path
    if dfd_path:
        resolved_dfd = Path(dfd_path).resolve()
        if not resolved_dfd.exists():
            print(f"DFD introuvable: {resolved_dfd}", file=sys.stderr)
            return 1
        dfd_path = str(resolved_dfd)

    pdf_path = generate_report_pdf(
        app_name=args.app_name,
        developer_name=args.developer_name,
        generated_description=(
            "Cette application de test permet de verifier le rendu complet du template "
            "new_one.html avec des menaces, des scenarios d'attaque, un DFD et une "
            "synthese des exigences techniques."
        ),
        selected_threats=build_sample_threats(),
        dfd_image_path=dfd_path,
        dfd_reference="DFD-TEST-01",
        application_version=args.application_version,
        report_file_name="test-new-one-report.pdf",
    )

    print(f"PDF genere: {pdf_path}")
    html_path = BACKEND_DIR / "resources" / "out" / "test-new-one-report.html"
    if html_path.exists():
        print(f"HTML genere: {html_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

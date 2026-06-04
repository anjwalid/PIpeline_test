from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from app.services.dfd_render_service import DfdRenderService


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Render a DFD JSON file through the studio headless renderer."
    )
    parser.add_argument("input_json", help="Path to the DFD JSON file.")
    parser.add_argument(
        "--output-dir",
        default=str(CURRENT_DIR / "resources" / "out" / "test_dfd"),
        help="Directory where the rendered image will be written.",
    )
    parser.add_argument(
        "--format",
        choices=("png", "jpeg"),
        default="png",
        help="Output image format.",
    )
    parser.add_argument(
        "--allow-fallback",
        action="store_true",
        help="Allow fallback to pytm if studio headless rendering fails.",
    )
    args = parser.parse_args()

    input_path = Path(args.input_json).expanduser().resolve()
    if not input_path.exists():
        raise FileNotFoundError(f"DFD JSON file not found: {input_path}")

    dfd_json = json.loads(input_path.read_text(encoding="utf-8"))
    if args.allow_fallback:
        rendered_path = DfdRenderService.render_with_fallback(
            dfd_json=dfd_json,
            output_dir=args.output_dir,
            image_format=args.format,
        )
    else:
        rendered_path = DfdRenderService.render_with_studio(
            dfd_json=dfd_json,
            output_dir=args.output_dir,
            image_format=args.format,
        )
    print(rendered_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

from __future__ import annotations

import base64
import logging
import time
from pathlib import Path

from app.core.config import settings
from app.services.dfd_generator import generate_dfd_with_pytm

logger = logging.getLogger(__name__)

try:
    from playwright.sync_api import sync_playwright
except Exception:  # pragma: no cover - optional runtime dependency
    sync_playwright = None


class DfdRenderService:
    _BROWSER_CANDIDATES = (
        Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        Path(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
        Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
        Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        Path("/usr/bin/google-chrome"),
        Path("/usr/bin/chromium"),
        Path("/usr/bin/chromium-browser"),
        Path("/snap/bin/chromium"),
    )

    @staticmethod
    def _resolve_browser_path() -> str | None:
        configured_path = settings.DFD_STUDIO_BROWSER_PATH.strip()
        if configured_path:
            browser_path = Path(configured_path)
            if browser_path.exists():
                return str(browser_path)
            logger.warning("DFD studio browser path configured but not found: %s", configured_path)

        for candidate in DfdRenderService._BROWSER_CANDIDATES:
            if candidate.exists():
                return str(candidate)
        return None

    @staticmethod
    def _normalize_output_path(output_dir: str, image_format: str) -> Path:
        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)
        suffix = ".jpg" if image_format.lower() in {"jpeg", "jpg"} else ".png"
        return output_path / f"dfd_studio_{int(time.time())}{suffix}"

    @staticmethod
    def render_with_studio(
        dfd_json: dict,
        output_dir: str,
        image_format: str = "png",
    ) -> str:
        if not settings.DFD_STUDIO_RENDER_ENABLED:
            raise RuntimeError("DFD studio renderer disabled by configuration.")
        if sync_playwright is None:
            raise RuntimeError("Playwright is not available in the backend runtime.")

        browser_path = DfdRenderService._resolve_browser_path()
        if not browser_path:
            raise RuntimeError("No Chrome/Edge browser executable available for DFD studio rendering.")

        output_path = DfdRenderService._normalize_output_path(output_dir, image_format)
        timeout_ms = settings.DFD_STUDIO_RENDER_TIMEOUT_MS
        renderer_url = settings.DFD_STUDIO_RENDER_URL

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                executable_path=browser_path,
                headless=True,
                args=["--disable-gpu", "--no-sandbox"],
            )
            try:
                page = browser.new_page(viewport={"width": 1800, "height": 1200}, device_scale_factor=2)
                page.goto(renderer_url, wait_until="domcontentloaded", timeout=timeout_ms)
                page.wait_for_function(
                    "() => Boolean(window.__DFD_TEST_API__ && window.__DFD_TEST_API__.ready)",
                    timeout=timeout_ms,
                )

                data_url = page.evaluate(
                    """async ({ diagram, format }) => {
                        return await window.__DFD_TEST_API__.renderFromJson(diagram, format);
                    }""",
                    {"diagram": dfd_json, "format": image_format},
                )

                if not isinstance(data_url, str) or "," not in data_url:
                    raise RuntimeError("Invalid data URL returned by studio renderer.")

                payload = data_url.split(",", 1)[1]
                output_path.write_bytes(base64.b64decode(payload))
                return str(output_path.resolve())
            finally:
                browser.close()

    @staticmethod
    def render_with_fallback(
        dfd_json: dict,
        output_dir: str,
        image_format: str = "png",
    ) -> str:
        try:
            studio_path = DfdRenderService.render_with_studio(
                dfd_json=dfd_json,
                output_dir=output_dir,
                image_format=image_format,
            )
            logger.info("DFD rendered with studio headless: %s", studio_path)
            return studio_path
        except Exception:
            logger.warning("DFD studio headless render failed, falling back to pytm.", exc_info=True)
            if image_format.lower() not in {"png"}:
                raise
            return generate_dfd_with_pytm(dfd_json, output_dir)

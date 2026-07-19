"""HTML→PDF rendering behind an interface.

Production uses Playwright (Chromium) so the PDF matches the hosted web
proposal pixel-for-pixel. Playwright + its browser are a heavy dependency and
are not installed in CI, so the real renderer imports lazily and the worker
falls back to storing the HTML snapshot when unavailable. Tests use FakePdf.
"""

import logging
from typing import Protocol

logger = logging.getLogger(__name__)


class PdfError(Exception):
    pass


class PdfRenderer(Protocol):
    def render(self, html: str) -> bytes: ...


class PlaywrightPdf:
    def __init__(self, concurrency: int = 2) -> None:
        self._concurrency = concurrency

    def render(self, html: str) -> bytes:
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as exc:  # pragma: no cover - depends on optional dep
            raise PdfError("Playwright is not installed.") from exc
        with sync_playwright() as playwright:  # pragma: no cover - needs browser
            browser = playwright.chromium.launch()
            try:
                page = browser.new_page()
                page.set_content(html, wait_until="networkidle")
                pdf_bytes: bytes = page.pdf(format="Letter", print_background=True)
                return pdf_bytes
            finally:
                browser.close()


class FakePdf:
    """Deterministic stand-in — returns a tiny valid-ish PDF header + the html
    length so tests can assert a render happened."""

    def __init__(self) -> None:
        self.rendered: list[str] = []

    def render(self, html: str) -> bytes:
        self.rendered.append(html)
        return b"%PDF-1.4\n% FieldQuote fake render\n" + str(len(html)).encode()


def get_pdf_renderer() -> PdfRenderer:
    from fieldquote.core.config import get_settings

    return PlaywrightPdf(get_settings().pdf_render_concurrency)

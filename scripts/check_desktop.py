#!/usr/bin/env python3
"""Smoke-test the native window: open it, load a paper, report, close.

The window's contents can't be inspected from outside the process, so this
drives it from the inside and prints what actually rendered.

Run from the repo root:  .venv/bin/python scripts/check_desktop.py
"""

from __future__ import annotations

import json
import sys
import time

import webview

sys.path.insert(0, ".")
from server.desktop import create_window, start_server  # noqa: E402

PAPER = "1706.03762"  # Attention Is All You Need
PAGES = 15


def probe(window) -> None:
    out: dict[str, object] = {}

    def js(expr):
        try:
            return window.evaluate_js(expr)
        except Exception as exc:  # noqa: BLE001
            return f"ERROR: {exc}"

    def wait_for(expr: str, seconds: float = 45) -> bool:
        deadline = time.time() + seconds
        while time.time() < deadline:
            if js(expr) is True:
                return True
            time.sleep(0.5)
        return False

    out["booted"] = wait_for("typeof window.__view === 'object'", 20)
    out["katex"] = js("typeof katex")
    out["marked"] = js("typeof marked")

    js(
        f"document.getElementById('url-input').value='{PAPER}';"
        "document.getElementById('url-form').dispatchEvent("
        "new Event('submit',{cancelable:true}))"
    )

    # Settle on a definite end state instead of sampling a moving target: every
    # page laid out, page 1 painted with its text layer, and the title resolved.
    out["loaded"] = wait_for(
        f"""window.__view.pages.length === {PAGES} &&
            window.__view.pages[0].textLayer.children.length > 0 &&
            document.title.includes('Attention')"""
    )

    out["pages"] = js("window.__view.pages.length")
    out["text_layer_spans"] = js(
        "document.querySelectorAll('.page[data-page=\"1\"] .text-layer span').length"
    )
    out["canvas_rendered"] = js("window.__view.pages[0].canvas.width > 300")
    out["paper_title"] = js("document.title")
    out["clipboard_api"] = js("typeof navigator.clipboard?.writeText")
    out["secure_context"] = js("window.isSecureContext")

    # Text selection must survive the webview's own styling, and the extraction
    # path has to work on WebKit ranges, not just Chromium ones.
    out["user_select"] = js(
        "getComputedStyle(document.body).webkitUserSelect || "
        "getComputedStyle(document.body).userSelect"
    )
    out["selection_extracts"] = js(
        """(() => {
             const spans = [...document.querySelectorAll(
               '.page[data-page="1"] .text-layer span')];
             const i = spans.findIndex(s => s.textContent.includes('dominant'));
             if (i < 0) return 'phrase not found';
             const r = document.createRange();
             r.setStart(spans[i].firstChild, 0);
             r.setEnd(spans[i + 1].firstChild, 12);
             const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
             const got = window.__view.getSelection();
             sel.removeAllRanges();
             return got ? got.text.slice(0, 70) : 'no selection returned';
           })()"""
    )

    print(json.dumps(out, indent=2))
    window.destroy()


if __name__ == "__main__":
    server, port = start_server()
    webview.start(probe, create_window(port, "paper-dive selftest"))
    server.should_exit = True

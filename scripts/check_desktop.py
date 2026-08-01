#!/usr/bin/env python3
"""Smoke-test the native window: open it, load a paper, report, close.

Run from the repo root:  .venv/bin/python scripts/check_desktop.py
"""

from __future__ import annotations

import json
import sys
import time

import webview

sys.path.insert(0, ".")
from server.desktop import start_server  # noqa: E402


def probe(window) -> None:
    out: dict[str, object] = {}
    time.sleep(4)  # first paint plus the CDN modules

    def js(expr):
        try:
            return window.evaluate_js(expr)
        except Exception as exc:  # noqa: BLE001
            return f"ERROR: {exc}"

    out["title"] = js("document.title")
    out["viewer_present"] = js("!!document.getElementById('viewer')")
    out["app_module_ran"] = js("typeof window.__view")
    out["katex"] = js("typeof katex")
    out["marked"] = js("typeof marked")

    # Exercise the real path: proxy fetch -> PDF.js render -> text layer.
    js(
        "document.getElementById('url-input').value='1706.03762';"
        "document.getElementById('url-form').dispatchEvent("
        "new Event('submit',{cancelable:true}))"
    )
    for _ in range(40):
        time.sleep(0.5)
        if js("document.querySelectorAll('.page[data-page=\"1\"] .text-layer span').length"):
            break

    out["pages"] = js("document.querySelectorAll('.page').length")
    out["text_layer_spans"] = js(
        "document.querySelectorAll('.page[data-page=\"1\"] .text-layer span').length"
    )
    out["paper_title"] = js("document.title")
    out["canvas_rendered"] = js(
        "(document.querySelector('.page[data-page=\"1\"] canvas')||{}).width > 300"
    )
    out["clipboard_api"] = js("typeof navigator.clipboard?.writeText")
    out["secure_context"] = js("window.isSecureContext")

    print(json.dumps(out, indent=2))
    window.destroy()


if __name__ == "__main__":
    server, port = start_server()
    win = webview.create_window("paper-dive selftest", f"http://127.0.0.1:{port}/", width=1200, height=800)
    webview.start(probe, win)
    server.should_exit = True

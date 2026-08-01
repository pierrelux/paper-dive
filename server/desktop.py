"""Desktop entry point: the server plus a native window, in one process.

Running this instead of `server.app` gives a real macOS window (WKWebView) that
belongs to the .app bundle, so the Dock shows paper-dive's own icon rather than
a browser's. Closing the window ends the process, which ends the server.
"""

from __future__ import annotations

import os
import threading
import time

import uvicorn

from .app import app, load_dotenv

TITLE = "paper-dive"


def start_server() -> tuple[uvicorn.Server, int]:
    """Run uvicorn on a background thread; return it and the port it took."""
    # Port 0 lets the OS pick a free one, so a server already running on the
    # default port (or a second window) can never collide.
    port = int(os.environ.get("PAPER_DIVE_PORT", "0"))
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    server = uvicorn.Server(config)

    threading.Thread(target=server.run, daemon=True).start()

    for _ in range(200):
        if server.started and server.servers:
            break
        time.sleep(0.05)
    else:
        raise RuntimeError("The server did not start within 10s.")

    return server, server.servers[0].sockets[0].getsockname()[1]


def create_window(port: int, title: str = TITLE):
    """The window the app opens. Tests use this too, so options can't drift."""
    import webview

    return webview.create_window(
        title,
        f"http://127.0.0.1:{port}/",
        width=1500,
        height=950,
        min_size=(900, 600),
        # pywebview injects `body { user-select: none }` unless asked not to,
        # which leaves the PDF text layer unselectable by mouse.
        text_select=True,
    )


def main() -> None:
    import webview

    load_dotenv()
    server, port = start_server()
    create_window(port)
    webview.start()  # blocks until the window closes
    server.should_exit = True


if __name__ == "__main__":
    main()

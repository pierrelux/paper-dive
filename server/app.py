"""paper-dive — a local reader that explains whatever you select in a paper.

Serves the static viewer and proxies explanation requests to the Claude API,
streaming the answer back over SSE.
"""

from __future__ import annotations

import ipaddress
import json
import os
import socket
from pathlib import Path
from typing import AsyncIterator, Literal
from urllib.parse import urlparse

import anthropic
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .prompts import build_messages, compose_dive, system_blocks

MODEL = "claude-opus-5"
MAX_TOKENS = 8192
FALLBACK_BETA = "server-side-fallback-2026-07-01"

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

app = FastAPI(title="paper-dive")

_client: anthropic.AsyncAnthropic | None = None


def get_client() -> anthropic.AsyncAnthropic:
    global _client
    if _client is None:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            raise HTTPException(
                status_code=503,
                detail=(
                    "ANTHROPIC_API_KEY is not set. Export it in the shell that starts "
                    "the server, or put it in a .env file next to pyproject.toml."
                ),
            )
        _client = anthropic.AsyncAnthropic()
    return _client


# ---------------------------------------------------------------- request models


class Target(BaseModel):
    kind: Literal["text", "region"]
    page: int = 1
    text: str | None = None
    image: str | None = None  # bare base64 PNG, no data: prefix


class Context(BaseModel):
    before: str = ""
    current: str = ""
    after: str = ""


class Doc(BaseModel):
    title: str = ""
    frontmatter: str = ""


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    text: str = ""


class ExplainRequest(BaseModel):
    doc: Doc = Field(default_factory=Doc)
    target: Target
    context: Context = Field(default_factory=Context)
    level: Literal["simple", "standard", "deep"] = "standard"
    turns: list[Turn] = Field(default_factory=list)
    question: str | None = None
    # A phrase selected inside the previous answer — a dive one level deeper.
    dive: str | None = None


# ------------------------------------------------------------------- streaming


def sse(event: dict) -> str:
    return f"data: {json.dumps(event)}\n\n"


async def _drain(stream, emitted: list[bool], echo: str | None) -> AsyncIterator[str]:
    async for text in stream.text_stream:
        if text:
            emitted[0] = True
            yield sse({"type": "delta", "text": text})
    final = await stream.get_final_message()
    if final.stop_reason == "refusal":
        detail = getattr(final, "stop_details", None)
        category = getattr(detail, "category", None) if detail else None
        yield sse(
            {
                "type": "error",
                "message": "The model declined this request"
                + (f" ({category})." if category else "."),
            }
        )
        return
    if final.stop_reason == "max_tokens":
        yield sse({"type": "notice", "message": "Answer hit the length cap."})
    usage = final.usage
    yield sse(
        {
            "type": "done",
            # The user turn we appended, so the client can keep an exact history.
            "echo": echo,
            "usage": {
                "input": usage.input_tokens,
                "output": usage.output_tokens,
                "cache_read": getattr(usage, "cache_read_input_tokens", 0) or 0,
            },
        }
    )


async def explain_stream(
    req: ExplainRequest, client: anthropic.AsyncAnthropic
) -> AsyncIterator[str]:
    echo = compose_dive(req.dive) if req.dive else req.question
    params = {
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "system": system_blocks(req.level, req.doc.title, req.doc.frontmatter),
        "messages": build_messages(
            req.target.model_dump(),
            req.context.model_dump(),
            [t.model_dump() for t in req.turns],
            echo,
        ),
        "thinking": {"type": "adaptive"},
        "output_config": {"effort": "medium"},
    }

    emitted = [False]
    try:
        # Server-side fallbacks: if a safety classifier declines, the API re-runs the
        # request on Anthropic's recommended fallback model inside the same call.
        async with client.beta.messages.stream(
            **params, betas=[FALLBACK_BETA], fallbacks="default"
        ) as stream:
            async for chunk in _drain(stream, emitted, echo):
                yield chunk
        return
    except anthropic.BadRequestError:
        if emitted[0]:
            raise
        # This account/SDK does not have the fallback beta; run without it.
    except Exception as exc:  # noqa: BLE001 - surface anything as a stream event
        yield sse({"type": "error", "message": f"{type(exc).__name__}: {exc}"})
        return

    try:
        async with client.messages.stream(**params) as stream:
            async for chunk in _drain(stream, emitted, echo):
                yield chunk
    except Exception as exc:  # noqa: BLE001
        yield sse({"type": "error", "message": f"{type(exc).__name__}: {exc}"})


@app.post("/api/explain")
async def explain(req: ExplainRequest) -> StreamingResponse:
    if req.target.kind == "text" and not (req.target.text or "").strip():
        raise HTTPException(status_code=400, detail="Empty text selection.")
    if req.target.kind == "region" and not req.target.image:
        raise HTTPException(status_code=400, detail="Region selection has no image.")
    # Resolve credentials before the response starts; raising mid-stream is too late.
    client = get_client()
    return StreamingResponse(
        explain_stream(req, client),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ------------------------------------------------------------------ pdf fetching


def _is_public_host(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    for info in infos:
        addr = ipaddress.ip_address(info[4][0])
        if addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved:
            return False
    return True


@app.get("/api/fetch")
async def fetch_pdf(url: str) -> Response:
    """Fetch a PDF server-side so the browser is not blocked by CORS."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(status_code=400, detail="Only http(s) URLs are supported.")
    if not _is_public_host(parsed.hostname):
        raise HTTPException(status_code=400, detail="Refusing to fetch a non-public host.")

    async with httpx.AsyncClient(follow_redirects=True, timeout=60) as http:
        try:
            resp = await http.get(url, headers={"User-Agent": "paper-dive/0.1"})
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=502, detail=f"Fetch failed: {exc}") from exc
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Upstream returned {resp.status_code}.")

    body = resp.content
    if not body.startswith(b"%PDF"):
        raise HTTPException(status_code=415, detail="That URL did not return a PDF.")
    return Response(content=body, media_type="application/pdf")


# ----------------------------------------------------------------------- static


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


def load_dotenv() -> None:
    env_file = Path(__file__).resolve().parent.parent / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip("'\""))


def main() -> None:
    import uvicorn

    load_dotenv()
    port = int(os.environ.get("PORT", "8765"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()

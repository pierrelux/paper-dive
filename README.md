# paper·dive

Read a paper. Select a sentence, an equation, or drag a box around a figure, and get
that one thing explained — with the surrounding pages as context.

It runs locally: a PDF.js viewer in the browser, a small FastAPI server that streams
explanations from Claude.

## Setup

```bash
uv venv && uv pip install -e .
```

Set your key (either works):

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

or `cp .env.example .env` and edit it.

## Run

```bash
.venv/bin/python -m server.app
```

Then open http://localhost:8765.

### As a Dock app (macOS)

```bash
./scripts/make_app.sh
open ~/Applications/paper-dive.app
```

Right-click its Dock icon → *Options* → *Keep in Dock*, and from then on it is one
click. Launching starts the server and opens a plain window with no tab strip or
address bar. Quitting the window (⌘Q), or quitting the app from its own Dock icon,
shuts the server down; clicking the icon again while it runs just brings the window
forward.

It uses Chrome with a throwaway profile under
`~/Library/Application Support/paper-dive/`, so it never touches your everyday
browser session; without Chrome it falls back to your default browser. Server output
goes to `~/Library/Logs/paper-dive.log`. Rebuild with `make_app.sh` if you move the
checkout — the launcher has its path baked in.

## Using it

- **Open a paper** — drag a PDF onto the window, click *Open PDF*, or paste an arXiv id
  (`1706.03762`), an arXiv URL, or any direct PDF link into the box.
- **Explain text** — select it and press <kbd>⌘E</kbd>, or click the *Explain* button
  that appears under the selection.
- **Explain a figure or display equation** — click **⬚ Region** (or just hold
  <kbd>Alt</kbd>) and drag a box. The region is re-rendered at up to 3× and sent as an
  image, so small subscripts stay legible.
- **Go deeper, recursively** — select a phrase *inside an explanation* and the same
  Explain button reads **Go deeper**. The new explanation nests directly under the
  paragraph it came from, and the phrase gets underlined so you can see what you've
  already opened. Dives nest to any depth; click a header to collapse one.
- **Follow up** — every explanation, at any depth, has its own *Ask a follow-up…* box.
- **Navigate** — *Outline* shows the whole dive tree; click any entry to jump to it.
  Clicking an underlined phrase jumps to its dive, and a dive's header jumps back to the
  phrase.
- **Depth** — the *Simple / Standard / Deep* selector changes who the answer is pitched
  at: new to the subfield, knows the area, or expert.
- **Export** — copies the whole tree to the clipboard as nested Markdown.

## How it works

Each request sends Claude three things: the paper's front matter (title and abstract,
cached across requests so repeat selections are cheap), the text of the previous,
current, and next page, and the selection itself — as text, or as a cropped PNG for a
region. The system prompt asks for the specific thing explained rather than a summary:
lead with the answer, define every symbol in the paper's own notation, give the
intuition, and flag what a careful reader would trip on.

A dive is a **continuation of the same conversation**, not a new one: the paper context
and the original figure stay at the head of the thread, and each level appends one turn.
So a third-level dive can still point at the figure, the whole chain hits the prompt
cache, and each answer is told to assume everything above it is already understood.

Model: `claude-opus-5`, adaptive thinking, `effort: medium`, streamed over SSE.

## Layout

```
server/app.py       FastAPI app: /api/explain (SSE), /api/fetch (PDF proxy), static files
server/prompts.py   system prompt, reader levels, dive prompt, message construction
web/pdfview.js      rendering, text layer, selection extraction, region capture
web/app.js          UI wiring and the explanation tree
web/markdown.js     Markdown + KaTeX rendering
scripts/make_app.sh builds the macOS .app wrapper
scripts/make_icon.py draws the app icon (stdlib only, no image deps)
```

`window.__view` exposes the viewer in the console if a PDF renders oddly.

## Notes

- The viewer pulls PDF.js, KaTeX, and marked from jsDelivr, so first load needs network.
- Selections that span a page break aren't picked up — select within one page.
- `/api/fetch` refuses non-public hosts, but it is still an open fetcher; it is meant for
  a server bound to localhost, which is what `python -m server.app` does.

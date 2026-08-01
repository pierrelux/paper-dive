// Wiring: document loading, selection capture, and the explanation tree.

import { PdfView } from "./pdfview.js";
import { renderMarkdown } from "./markdown.js";

const $ = (id) => document.getElementById(id);

const viewerEl = $("viewer");
const pagesEl = $("pages");
const cardsEl = $("cards");
const outlineEl = $("outline");
const fab = $("explain-fab");
const regionBox = $("region-box");

const view = new PdfView(viewerEl, pagesEl);
window.__view = view; // handy from the console when something looks wrong

const doc = { title: "", frontmatter: "" };
let regionMode = false;
let pending = null; // what the Explain button would act on
const roots = [];

// ------------------------------------------------------------------- loading

async function loadSource(source, title) {
  $("drop-hint").hidden = true;
  const count = await view.load(source);
  $("page-count").textContent = `/ ${count}`;
  $("page-num").value = "1";
  doc.frontmatter = await view.frontmatter();
  doc.title =
    title ||
    (await view.metadataTitle()) ||
    (await view.titleByLayout()) ||
    guessTitle(doc.frontmatter);
  document.title = doc.title ? `${doc.title} — paper·dive` : "paper·dive";
}

/** Fallback when the PDF carries no title: the first line that reads like one. */
function guessTitle(frontmatter) {
  for (const line of frontmatter.split("\n").slice(0, 20)) {
    const trimmed = line.trim();
    if (trimmed.length < 12 || trimmed.length > 200) continue;
    if (/[@]|https?:/.test(trimmed)) continue; // author block
    if (/\.\s*$/.test(trimmed)) continue; // prose, not a title
    if (/^(arxiv|preprint|under review|published|provided|copyright)/i.test(trimmed)) continue;
    return trimmed;
  }
  return "";
}

async function loadFile(file) {
  const buffer = await file.arrayBuffer();
  await loadSource({ data: buffer }, file.name.replace(/\.pdf$/i, ""));
}

function resolveUrl(raw) {
  const value = raw.trim();
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(value)) return `https://arxiv.org/pdf/${value}`;
  if (/^arxiv:/i.test(value)) return `https://arxiv.org/pdf/${value.slice(6)}`;
  if (/arxiv\.org\/abs\//.test(value)) return value.replace("/abs/", "/pdf/");
  return value;
}

$("open-file").onclick = () => $("file-input").click();
$("file-input").onchange = (e) => e.target.files[0] && loadFile(e.target.files[0]);

$("url-form").onsubmit = async (e) => {
  e.preventDefault();
  const url = resolveUrl($("url-input").value);
  if (!url) return;
  try {
    await loadSource(`/api/fetch?url=${encodeURIComponent(url)}`, "");
  } catch (err) {
    alert(`Could not load that PDF: ${err.message}`);
  }
};

viewerEl.addEventListener("dragover", (e) => {
  e.preventDefault();
  viewerEl.classList.add("dragover");
});
viewerEl.addEventListener("dragleave", () => viewerEl.classList.remove("dragover"));
viewerEl.addEventListener("drop", (e) => {
  e.preventDefault();
  viewerEl.classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (file && file.type === "application/pdf") loadFile(file);
});

// ------------------------------------------------------------ navigation UI

view.onPageChange = (n) => ($("page-num").value = String(n));
$("prev-page").onclick = () => view.scrollToPage(Math.max(1, view.currentPage - 1));
$("next-page").onclick = () => view.scrollToPage(Math.min(view.pageCount, view.currentPage + 1));
$("page-num").onchange = (e) => {
  const n = Number(e.target.value);
  if (n >= 1 && n <= view.pageCount) view.scrollToPage(n);
};

const DEFAULT_ZOOM = 1.35; // shown as 100%

function setZoom(z) {
  view.setZoom(z);
  $("zoom-level").textContent = `${Math.round((view.zoom / DEFAULT_ZOOM) * 100)}%`;
}
$("zoom-in").onclick = () => setZoom(view.zoom * 1.15);
$("zoom-out").onclick = () => setZoom(view.zoom / 1.15);

$("region-toggle").onclick = () => {
  regionMode = !regionMode;
  $("region-toggle").classList.toggle("on", regionMode);
  viewerEl.classList.toggle("region-mode", regionMode);
  hideFab();
};

// -------------------------------------------------------------- selections
//
// Two kinds: text (or a region) in the PDF, and a phrase inside an answer,
// which dives one level deeper into the explanation that contains it.

/** A selection inside an answer, if that's where the caret is. */
function answerSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const host =
    range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  const answerEl = host?.closest(".answer");
  if (!answerEl || !answerEl.__exchange) return null;
  const phrase = sel.toString().replace(/\s+/g, " ").trim();
  if (phrase.length < 2) return null;
  return {
    kind: "dive",
    phrase,
    exchange: answerEl.__exchange,
    range: range.cloneRange(),
    rect: range.getBoundingClientRect(),
  };
}

function currentSelection() {
  const dive = answerSelection();
  if (dive) return dive;
  const text = view.getSelection();
  if (text) return { kind: "paper", page: text.page, text: text.text, rect: text.rect };
  return null;
}

function showFab(rect, label) {
  fab.textContent = label;
  fab.style.left = `${Math.max(8, rect.left)}px`;
  fab.style.top = `${rect.bottom + 6}px`;
  fab.hidden = false;
}

function hideFab() {
  fab.hidden = true;
  pending = null;
}

function offerSelection() {
  const selection = currentSelection();
  if (!selection) return hideFab();
  pending = selection;
  showFab(selection.rect, selection.kind === "dive" ? "Go deeper" : "Explain");
}

document.addEventListener("mouseup", (e) => {
  if (regionMode && viewerEl.contains(e.target)) return;
  if (e.target === fab) return;
  setTimeout(offerSelection, 0);
});

document.addEventListener("mousedown", (e) => {
  if (e.target !== fab) hideFab();
});

// The button is anchored to the viewport, so a scroll would leave it stranded.
for (const el of [viewerEl, $("panel"), $("cards")]) {
  el.addEventListener("scroll", () => !fab.hidden && hideFab(), { passive: true });
}

function actOnSelection() {
  if (!pending) return;
  const selection = pending;
  hideFab();
  window.getSelection()?.removeAllRanges();
  if (selection.kind === "dive") dive(selection);
  else explain({ kind: "text", page: selection.page, text: selection.text });
}

fab.onclick = actOnSelection;

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e") {
    e.preventDefault();
    if (!pending) pending = currentSelection();
    actOnSelection();
  }
  if (e.key === "Escape") hideFab();
});

// ---------------------------------------------------------- region selection

let drag = null;

viewerEl.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || (!regionMode && !e.altKey)) return;
  const pageDiv = e.target.closest(".page");
  if (!pageDiv) return;
  e.preventDefault();
  hideFab();

  const rect = pageDiv.getBoundingClientRect();
  drag = {
    page: Number(pageDiv.dataset.page),
    originX: pageDiv.offsetLeft,
    originY: pageDiv.offsetTop,
    startX: e.clientX - rect.left,
    startY: e.clientY - rect.top,
    rect,
    x: 0,
    y: 0,
    w: 0,
    h: 0,
  };
});

window.addEventListener("mousemove", (e) => {
  if (!drag) return;
  const curX = Math.max(0, Math.min(drag.rect.width, e.clientX - drag.rect.left));
  const curY = Math.max(0, Math.min(drag.rect.height, e.clientY - drag.rect.top));
  drag.x = Math.min(drag.startX, curX);
  drag.y = Math.min(drag.startY, curY);
  drag.w = Math.abs(curX - drag.startX);
  drag.h = Math.abs(curY - drag.startY);

  regionBox.hidden = false;
  regionBox.style.left = `${drag.originX + drag.x}px`;
  regionBox.style.top = `${drag.originY + drag.y}px`;
  regionBox.style.width = `${drag.w}px`;
  regionBox.style.height = `${drag.h}px`;
});

window.addEventListener("mouseup", async () => {
  if (!drag) return;
  const finished = drag;
  drag = null;
  regionBox.hidden = true;
  if (finished.w < 8 || finished.h < 8) return;

  const image = await view.captureRegion(finished.page, {
    x: finished.x,
    y: finished.y,
    width: finished.w,
    height: finished.h,
  });
  if (image) explain({ kind: "region", page: finished.page, image });
});

// --------------------------------------------------------------- the tree
//
// A node is one explanation. Roots explain something in the PDF; children
// explain a phrase from their parent's answer. A node inherits its parent's
// conversation, so a dive is a continuation, not a fresh question.

let nodeSeq = 0;

function makeNode({ parent, target, context, phrase }) {
  return {
    id: ++nodeSeq,
    parent: parent ?? null,
    phrase: phrase ?? null,
    target: target ?? parent.target,
    context: context ?? parent.context,
    turns: [],
    // A dive inherits the parent's conversation, snapshotted when it actually
    // runs — the parent may still have been streaming when it was created.
    seeded: !parent,
    children: [],
    markdown: [],
  };
}

async function contextFor(page) {
  return {
    before: page > 1 ? await view.textOf(page - 1) : "",
    current: await view.textOf(page),
    after: page < view.pageCount ? await view.textOf(page + 1) : "",
  };
}

async function explain(target) {
  if (!view.doc) return;
  const node = makeNode({ target, context: await contextFor(target.page) });
  roots.unshift(node);
  renderRoot(node);
  refreshOutline();
  await run(node, {});
}

async function dive(selection) {
  const { exchange, phrase, range } = selection;
  const node = makeNode({ parent: exchange.node, phrase });
  exchange.node.children.push(node);

  const mark = markPhrase(range, node.id);
  node.mark = mark;
  renderDive(node, exchange.kids);
  refreshOutline();
  await run(node, { dive: phrase });
}

/** Underline the phrase in the parent answer so the dive is traceable. */
function markPhrase(range, nodeId) {
  const mark = document.createElement("mark");
  mark.className = "dived";
  mark.dataset.node = String(nodeId);
  try {
    range.surroundContents(mark);
  } catch {
    try {
      mark.append(range.extractContents());
      range.insertNode(mark);
    } catch {
      return null; // selection crossed block boundaries; skip the marker
    }
  }
  mark.onclick = () => flashTo(nodeId);
  return mark;
}

function flash(el) {
  el.classList.add("flash");
  el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  setTimeout(() => el.classList.remove("flash"), 900);
}

function flashTo(nodeId) {
  const node = findNode(nodeId);
  if (!node?.el) return;
  // Make sure every collapsed ancestor is open first.
  for (let a = node; a; a = a.parent) a.el?.classList.remove("collapsed");
  flash(node.el);
}

function findNode(id, list = roots) {
  for (const node of list) {
    if (node.id === id) return node;
    const found = findNode(id, node.children);
    if (found) return found;
  }
  return null;
}

// -------------------------------------------------------------- rendering

/** The shared part of every node: answers, their dives, and a follow-up box. */
function nodeBody(node) {
  const body = document.createElement("div");
  body.className = "node-body";

  const foot = document.createElement("form");
  foot.className = "card-foot";
  const input = document.createElement("input");
  input.placeholder = "Ask a follow-up…";
  const send = document.createElement("button");
  send.className = "btn small";
  send.textContent = "Ask";
  foot.append(input, send);
  foot.onsubmit = (e) => {
    e.preventDefault();
    const question = input.value.trim();
    if (!question) return;
    input.value = "";
    run(node, { question });
  };

  body.append(foot);
  node.body = body;
  node.foot = foot;
  return body;
}

function renderRoot(node) {
  cardsEl.querySelector(".empty")?.remove();

  const el = document.createElement("article");
  el.className = "card";

  const head = document.createElement("div");
  head.className = "card-head";
  const ref = document.createElement("span");
  ref.className = "page-ref";
  ref.textContent = `page ${node.target.page}`;
  ref.onclick = () => view.scrollToPage(node.target.page);
  head.append(ref, document.createTextNode(node.target.kind === "region" ? " · region" : " · text"));

  const targetEl = document.createElement("div");
  targetEl.className = "card-target";
  if (node.target.kind === "region") {
    targetEl.classList.add("image");
    const img = document.createElement("img");
    img.src = node.target.image;
    targetEl.append(img);
  } else {
    targetEl.textContent = node.target.text;
  }

  el.append(head, targetEl, nodeBody(node));
  cardsEl.prepend(el);
  node.el = el;
}

function renderDive(node, host) {
  const el = document.createElement("section");
  el.className = "dive";

  const head = document.createElement("button");
  head.className = "dive-head";
  head.type = "button";
  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.textContent = "▾";
  const label = document.createElement("span");
  label.textContent = `“${node.phrase}”`;
  head.append(chevron, label);
  head.onclick = () => {
    el.classList.toggle("collapsed");
    if (node.mark) flash(node.mark);
  };

  el.append(head, nodeBody(node));
  host.append(el);
  node.el = el;
}

/** One question-and-answer inside a node, with a slot for its own dives. */
function addExchange(node, questionText) {
  const exchange = { node };

  if (questionText) {
    const q = document.createElement("div");
    q.className = "turn-q";
    q.textContent = questionText;
    node.body.insertBefore(q, node.foot);
  }

  const answer = document.createElement("div");
  answer.className = "answer";
  answer.__exchange = exchange;

  const status = document.createElement("div");
  status.className = "status dots";
  status.textContent = "Reading";

  const kids = document.createElement("div");
  kids.className = "kids";

  node.body.insertBefore(answer, node.foot);
  node.body.insertBefore(status, node.foot);
  node.body.insertBefore(kids, node.foot);

  Object.assign(exchange, { answer, status, kids });
  return exchange;
}

// --------------------------------------------------------------- streaming

async function run(node, { question, dive: divePhrase }) {
  if (!node.seeded) {
    node.turns = [...node.parent.turns];
    node.seeded = true;
  }
  const exchange = addExchange(node, question);
  const { answer, status } = exchange;
  node.el.scrollIntoView({ block: "nearest", behavior: "smooth" });

  const payload = {
    doc,
    target: {
      kind: node.target.kind,
      page: node.target.page,
      text: node.target.text ?? null,
      image: node.target.image ? node.target.image.split(",")[1] : null,
    },
    context: node.context,
    level: $("level").value,
    turns: node.turns,
    question: question ?? null,
    dive: divePhrase ?? null,
  };

  let text = "";
  let echo = question ?? null;
  let frame = null;
  const paint = () => {
    frame = null;
    renderMarkdown(answer, text);
  };

  try {
    await streamExplain(payload, {
      onDelta(delta) {
        text += delta;
        status.classList.remove("dots");
        status.textContent = "";
        if (!frame) frame = requestAnimationFrame(paint);
      },
      onNotice(message) {
        status.textContent = message;
      },
      onError(message) {
        status.classList.remove("dots");
        status.classList.add("error");
        status.textContent = message;
      },
      onDone(event) {
        echo = event.echo ?? echo;
        if (!status.classList.contains("error")) {
          status.classList.remove("dots");
          status.textContent = event.usage
            ? `${event.usage.output} tokens${event.usage.cache_read ? " · cache hit" : ""}`
            : "";
        }
      },
    });
  } catch (err) {
    status.classList.remove("dots");
    status.classList.add("error");
    status.textContent = String(err.message || err);
  }

  if (frame) cancelAnimationFrame(frame);
  paint();

  if (text) {
    if (echo) node.turns.push({ role: "user", text: echo });
    node.turns.push({ role: "assistant", text });
    node.markdown.push(question ? `**Q:** ${question}\n\n${text}` : text);
    refreshOutline();
  }
}

async function streamExplain(payload, handlers) {
  const resp = await fetch("/api/explain", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      detail = (await resp.json()).detail || detail;
    } catch {
      /* non-JSON error body */
    }
    if (resp.status === 503) {
      // Key went missing or was never set — ask for it rather than just failing.
      $("setup").hidden = false;
      $("setup-key").focus();
    }
    throw new Error(detail);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6));
      if (event.type === "delta") handlers.onDelta(event.text);
      else if (event.type === "notice") handlers.onNotice(event.message);
      else if (event.type === "error") handlers.onError(event.message);
      else if (event.type === "done") handlers.onDone(event);
    }
  }
}

// ---------------------------------------------------------------- outline

function nodeLabel(node) {
  if (node.phrase) return node.phrase;
  if (node.target.kind === "region") return `region · page ${node.target.page}`;
  return node.target.text.replace(/\s+/g, " ");
}

function outlineList(nodes, isRoot) {
  const ul = document.createElement("ul");
  for (const node of nodes) {
    const li = document.createElement("li");
    if (isRoot) li.className = "root";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = nodeLabel(node);
    button.title = nodeLabel(node);
    button.onclick = () => flashTo(node.id);
    li.append(button);
    if (node.children.length) li.append(outlineList(node.children, false));
    ul.append(li);
  }
  return ul;
}

function refreshOutline() {
  if (outlineEl.hidden) return;
  outlineEl.replaceChildren(
    roots.length ? outlineList(roots, true) : document.createTextNode("Nothing yet."),
  );
}

$("outline-toggle").onclick = () => {
  outlineEl.hidden = !outlineEl.hidden;
  $("outline-toggle").classList.toggle("on", !outlineEl.hidden);
  refreshOutline();
};

// ----------------------------------------------------------------- export

function nodeMarkdown(node, depth) {
  const indent = "  ".repeat(depth);
  const heading = node.phrase
    ? `${indent}- **“${node.phrase}”**`
    : node.target.kind === "region"
      ? `### page ${node.target.page} · region`
      : `### page ${node.target.page}\n\n${node.target.text
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n")}`;

  const body = node.markdown
    .join("\n\n")
    .split("\n")
    .map((l) => (depth ? indent + "  " + l : l))
    .join("\n");

  return [heading, body, ...node.children.map((child) => nodeMarkdown(child, depth + 1))].join(
    "\n\n",
  );
}

$("export").onclick = async () => {
  const parts = [`# ${doc.title || "Paper"} — notes`];
  for (const node of [...roots].reverse()) parts.push(nodeMarkdown(node, 0));
  await navigator.clipboard.writeText(parts.join("\n\n"));
  $("export").textContent = "Copied";
  setTimeout(() => ($("export").textContent = "Export"), 1200);
};

$("clear").onclick = () => {
  roots.length = 0;
  cardsEl.innerHTML = '<p class="empty">Nothing explained yet.</p>';
  refreshOutline();
};

// ----------------------------------------------------------------- first run

async function checkKey() {
  try {
    const { has_key: hasKey } = await (await fetch("/api/status")).json();
    $("setup").hidden = hasKey;
    if (!hasKey) $("setup-key").focus();
  } catch {
    /* server not up yet; the explain call will surface anything real */
  }
}

$("setup-form").onsubmit = async (e) => {
  e.preventDefault();
  const button = e.target.querySelector("button");
  const error = $("setup-error");
  const key = $("setup-key").value.trim();
  if (!key) return;

  button.disabled = true;
  button.textContent = "Checking…";
  error.hidden = true;
  try {
    const resp = await fetch("/api/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (!resp.ok) throw new Error((await resp.json()).detail || `HTTP ${resp.status}`);
    $("setup").hidden = true;
    $("setup-key").value = "";
  } catch (err) {
    error.textContent = String(err.message || err);
    error.hidden = false;
  } finally {
    button.disabled = false;
    button.textContent = "Save and start";
  }
};

checkKey();

// ------------------------------------------------------------------ splitter

$("splitter").addEventListener("mousedown", (e) => {
  e.preventDefault();
  const panel = $("panel");
  const move = (ev) => {
    const width = window.innerWidth - ev.clientX;
    panel.style.flexBasis = `${Math.max(280, Math.min(900, width))}px`;
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
});

setZoom(view.zoom);

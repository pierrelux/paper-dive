// PDF rendering, text layer, selection extraction, and region capture.

import * as pdfjsLib from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";

const MAX_CAPTURE_EDGE = 2000; // Opus 5 reads up to 2576px on the long edge.

/** Join text items the way a reader would, restoring spaces PDFs omit. */
function joinItems(items) {
  let out = "";
  let prev = null;
  for (const item of items) {
    if (prev) {
      if (prev.hasEOL) out += "\n";
      else if (!/\s$/.test(prev.str) && !/^\s/.test(item.str) && item.str) out += " ";
    }
    out += item.str;
    prev = item;
  }
  return out;
}

export class PdfView {
  constructor(viewerEl, pagesEl) {
    this.viewerEl = viewerEl;
    this.pagesEl = pagesEl;
    this.doc = null;
    this.pages = [];
    this.zoom = 1.35;
    this.currentPage = 1;
    this.onPageChange = () => {};

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) this.renderPage(Number(entry.target.dataset.page));
        }
      },
      { root: viewerEl, rootMargin: "200% 0px" },
    );

    viewerEl.addEventListener("scroll", () => this.updateCurrentPage(), { passive: true });
  }

  get pageCount() {
    return this.doc ? this.doc.numPages : 0;
  }

  async load(source) {
    if (this.doc) {
      this.observer.disconnect();
      await this.doc.destroy();
    }
    this.pagesEl.innerHTML = "";
    this.pages = [];

    this.doc = await pdfjsLib.getDocument(source).promise;

    for (let n = 1; n <= this.doc.numPages; n++) {
      const proxy = await this.doc.getPage(n);
      const div = document.createElement("div");
      div.className = "page";
      div.dataset.page = String(n);

      const canvas = document.createElement("canvas");
      const textLayer = document.createElement("div");
      textLayer.className = "text-layer";
      const overlay = document.createElement("div");
      overlay.className = "page-overlay";
      div.append(canvas, textLayer, overlay);
      this.pagesEl.append(div);

      const state = { n, proxy, div, canvas, textLayer, items: null, text: null, rendered: false };
      this.pages.push(state);
      this.sizePage(state);
      this.observer.observe(div);
    }

    this.currentPage = 1;
    this.onPageChange(1);
    // Don't wait on IntersectionObserver for the first screenful — it doesn't
    // fire dependably while the window is unfocused, which would leave the
    // reader staring at blank pages until they scroll.
    await this.renderVisible();
    return this.doc.numPages;
  }

  sizePage(state) {
    const viewport = state.proxy.getViewport({ scale: this.zoom });
    state.viewport = viewport;
    state.div.style.width = `${Math.floor(viewport.width)}px`;
    state.div.style.height = `${Math.floor(viewport.height)}px`;
  }

  /**
   * Text items for a page, fetched at most once. The front-matter scan and the
   * text layer both want them, and asking pdf.js twice concurrently for the
   * same page loses one of the answers.
   */
  ensureText(state) {
    if (!state.textPromise) {
      state.textPromise = state.proxy.getTextContent().then((content) => {
        state.items = content.items.filter((it) => "str" in it);
        state.text = joinItems(state.items);
        return state;
      });
    }
    return state.textPromise;
  }

  async renderPage(n) {
    const state = this.pages[n - 1];
    if (!state || state.rendered) return;
    state.rendered = true;
    try {
      await this.paint(state);
    } catch (err) {
      state.rendered = false; // let it be retried rather than left blank
      throw err;
    }
  }

  async paint(state) {
    const viewport = state.viewport;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = state.canvas;
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    const ctx = canvas.getContext("2d", { alpha: false });
    await state.proxy.render({
      canvasContext: ctx,
      viewport,
      transform: dpr === 1 ? null : [dpr, 0, 0, dpr, 0, 0],
    }).promise;

    await this.ensureText(state);
    this.buildTextLayer(state);
  }

  buildTextLayer(state) {
    const layer = state.textLayer;
    layer.innerHTML = "";
    const frag = document.createDocumentFragment();

    state.items.forEach((item, i) => {
      if (!item.str) return;
      const tx = pdfjsLib.Util.transform(state.viewport.transform, item.transform);
      const height = Math.hypot(tx[2], tx[3]);
      if (!height) return;
      const angle = Math.atan2(tx[1], tx[0]);

      const span = document.createElement("span");
      span.textContent = item.str;
      span.dataset.i = String(i);
      span.style.left = `${tx[4]}px`;
      span.style.top = `${tx[5] - height}px`;
      span.style.fontSize = `${height}px`;
      span.style.fontFamily = "sans-serif";
      if (angle) span.style.transform = `rotate(${angle}rad)`;
      span._targetWidth = item.width * state.viewport.scale;
      frag.append(span);
    });

    layer.append(frag);

    // Squeeze each span to the width the PDF says it occupies, so selection
    // highlights line up with the glyphs on the canvas.
    for (const span of layer.children) {
      const target = span._targetWidth;
      const actual = span.getBoundingClientRect().width;
      if (target > 0 && actual > 0) {
        const scale = target / actual;
        span.style.transform = `${span.style.transform} scaleX(${scale})`.trim();
      }
    }
  }

  async setZoom(zoom) {
    this.zoom = Math.max(0.5, Math.min(4, zoom));
    const anchor = this.currentPage;
    for (const state of this.pages) {
      state.rendered = false;
      state.textLayer.innerHTML = "";
      this.sizePage(state);
    }
    this.scrollToPage(anchor);
    await this.renderPage(anchor);
    this.renderVisible();
  }

  async renderVisible() {
    const top = this.viewerEl.scrollTop;
    const bottom = top + this.viewerEl.clientHeight;
    const pending = [];
    for (const state of this.pages) {
      const y = state.div.offsetTop;
      if (y + state.div.offsetHeight > top - 400 && y < bottom + 400) {
        pending.push(this.renderPage(state.n));
      }
    }
    await Promise.all(pending);
  }

  scrollToPage(n) {
    const state = this.pages[n - 1];
    if (state) this.viewerEl.scrollTo({ top: state.div.offsetTop - 12 });
  }

  updateCurrentPage() {
    const mid = this.viewerEl.scrollTop + this.viewerEl.clientHeight * 0.35;
    let current = 1;
    for (const state of this.pages) {
      if (state.div.offsetTop <= mid) current = state.n;
      else break;
    }
    if (current !== this.currentPage) {
      this.currentPage = current;
      this.onPageChange(current);
    }
  }

  /** Text of a page, extracting it on demand. */
  async textOf(n) {
    const state = this.pages[n - 1];
    if (!state) return "";
    await this.ensureText(state);
    return state.text;
  }

  /** The title is nearly always the largest horizontal type on page 1. */
  async titleByLayout() {
    await this.textOf(1);
    // Rotated text is a margin stamp (arXiv id, journal rail), never the title.
    const items = (this.pages[0]?.items ?? []).filter((item) => {
      const [a, b] = item.transform;
      return item.str.trim() && Math.abs(b) < 0.05 * Math.hypot(a, b);
    });

    let max = 0;
    for (const item of items) max = Math.max(max, Math.hypot(item.transform[2], item.transform[3]));
    if (!max) return "";

    const biggest = items.filter(
      (item) => Math.hypot(item.transform[2], item.transform[3]) >= max * 0.92,
    );
    return joinItems(biggest).replace(/\s+/g, " ").trim().slice(0, 200);
  }

  async metadataTitle() {
    try {
      const { info } = await this.doc.getMetadata();
      const title = (info?.Title || "").trim();
      // Plenty of PDFs carry a filename or LaTeX artifact here; ignore those.
      return /\.(pdf|tex|dvi)$/i.test(title) || title.length < 8 ? "" : title;
    } catch {
      return "";
    }
  }

  async frontmatter(limit = 6000) {
    let text = "";
    for (let n = 1; n <= Math.min(2, this.pageCount); n++) {
      text += (await this.textOf(n)) + "\n\n";
      if (text.length > limit) break;
    }
    return text.slice(0, limit);
  }

  /**
   * Current selection, rebuilt from the underlying text items rather than from
   * the DOM, so word spacing survives.
   */
  getSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);

    const pageDiv = (range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement
    )?.closest(".page");
    if (!pageDiv) return null;

    const state = this.pages[Number(pageDiv.dataset.page) - 1];
    if (!state || !state.items) return null;

    const spans = [...state.textLayer.children].filter((span) => range.intersectsNode(span));
    if (spans.length === 0) return null;

    const startSpan = spans[0];
    const endSpan = spans[spans.length - 1];
    let text = "";
    let prev = null;

    for (const span of spans) {
      const item = state.items[Number(span.dataset.i)];
      let str = item.str;
      if (span === endSpan && range.endContainer.parentElement === span) {
        str = str.slice(0, range.endOffset);
      }
      if (span === startSpan && range.startContainer.parentElement === span) {
        str = str.slice(range.startOffset);
      }
      if (prev) {
        if (prev.hasEOL) text += "\n";
        else if (!/\s$/.test(text) && !/^\s/.test(str) && str) text += " ";
      }
      text += str;
      prev = item;
    }

    text = text.trim();
    if (!text) return null;
    return { text, page: state.n, rect: range.getBoundingClientRect() };
  }

  /** Render a rectangle of a page (CSS pixels, page-relative) to a PNG data URL. */
  async captureRegion(n, rect, pad = 6) {
    const state = this.pages[n - 1];
    if (!state) return null;

    const x = Math.max(0, rect.x - pad);
    const y = Math.max(0, rect.y - pad);
    const w = Math.min(state.viewport.width - x, rect.width + pad * 2);
    const h = Math.min(state.viewport.height - y, rect.height + pad * 2);
    if (w < 4 || h < 4) return null;

    // Re-render at higher resolution than the screen so small type stays legible.
    const boost = Math.min(3, MAX_CAPTURE_EDGE / Math.max(w, h));
    const scale = this.zoom * Math.max(1, boost);
    const viewport = state.proxy.getViewport({ scale });
    const ratio = scale / this.zoom;

    const full = document.createElement("canvas");
    full.width = Math.ceil(viewport.width);
    full.height = Math.ceil(viewport.height);
    const ctx = full.getContext("2d", { alpha: false });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, full.width, full.height);
    await state.proxy.render({ canvasContext: ctx, viewport }).promise;

    const crop = document.createElement("canvas");
    crop.width = Math.round(w * ratio);
    crop.height = Math.round(h * ratio);
    crop
      .getContext("2d")
      .drawImage(
        full,
        Math.round(x * ratio),
        Math.round(y * ratio),
        crop.width,
        crop.height,
        0,
        0,
        crop.width,
        crop.height,
      );
    return crop.toDataURL("image/png");
  }
}

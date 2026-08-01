// Markdown + LaTeX rendering.
//
// Math is pulled out before the markdown pass so that markdown never mangles it
// (`x_i` becoming italics, `\\` becoming a line break), then rendered with KaTeX
// and spliced back in.

const MATH_RULES = [
  { re: /\$\$([\s\S]+?)\$\$/g, display: true },
  { re: /\\\[([\s\S]+?)\\\]/g, display: true },
  { re: /\\\(([\s\S]+?)\\\)/g, display: false },
  { re: /(?<![\\$])\$(?!\s)((?:[^$\n]|\\\$)+?)(?<!\s)\$(?!\$)/g, display: false },
];

const FENCE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g;

function extractMath(src) {
  const math = [];
  // Only touch segments outside code fences and inline code spans.
  const out = src.split(FENCE).map((segment, i) => {
    if (i % 2 === 1) return segment; // captured code
    let text = segment;
    for (const { re, display } of MATH_RULES) {
      text = text.replace(re, (raw, tex) => {
        math.push({ tex, display, raw });
        return `@@M${math.length - 1}@@`;
      });
    }
    return text;
  });
  return { text: out.join(""), math };
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

let configured = false;

function configure() {
  if (configured) return;
  const renderer = new marked.Renderer();
  // Never emit model-authored raw HTML; show it as text instead.
  renderer.html = (token) => escapeHtml(typeof token === "string" ? token : token.raw ?? "");
  marked.use({ renderer, gfm: true, breaks: false });
  configured = true;
}

/**
 * While streaming, an expression whose closing delimiter hasn't arrived yet
 * would flash as raw LaTeX. Hold it back until it is complete.
 */
function dropTrailingPartialMath(src) {
  if ((src.split("$$").length - 1) % 2 === 1) return src.slice(0, src.lastIndexOf("$$"));
  if (((src.match(/(?<!\$)\$(?!\$)/g) || []).length % 2) === 1) {
    return src.slice(0, src.lastIndexOf("$"));
  }
  return src;
}

export function renderMarkdown(el, source, { streaming = false } = {}) {
  configure();
  const { text, math } = extractMath(streaming ? dropTrailingPartialMath(source) : source);
  let html = marked.parse(text);
  html = html.replace(/@@M(\d+)@@/g, (_, i) => {
    const item = math[Number(i)];
    if (!item) return "";
    try {
      return katex.renderToString(item.tex, {
        displayMode: item.display,
        throwOnError: false,
        strict: "ignore",
      });
    } catch {
      return escapeHtml(item.raw);
    }
  });
  el.innerHTML = html;
}

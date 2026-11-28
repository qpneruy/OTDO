const KATEX_CSS_URL = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css';
const MAX_CACHE = 2000;
const MAX_PLACEHOLDER_CACHE = 200;

const RE_HTML_SPECIAL = /[&<>"']/;
const RE_DISPLAY_MATH = /\$\$([\s\S]+?)\$\$/g;
const RE_INLINE_MATH = /\$([^$\n]+?)\$/g;
const RE_UNDERLINE = /(<code\b[^>]*>[\s\S]*?<\/code>)|\+\+([^+\n]+)\+\+/g;
const RE_TABLE_OPEN = /<table>/g;
const RE_TABLE_CLOSE = /<\/table>/g;
const RE_CODE_OPEN = /(<pre[^>]*>)?<code>/g;
const RE_SINGLE_P = /^<p>[\s\S]*<\/p>$/;
const RE_P_OPEN = /<p>/g;
const RE_MATH_TOKEN = /KATEXMATHTOKEN(\d+)END/g;
const RE_NEWLINE = /\r?\n/g;
const RE_RICH_SYNTAX = /[$*_`[\]~|#\\<>&@\r\n]|^\s*(?:[-+]|\d+[.)])\s|\+\+|--|==|http:\/\/|https:\/\/|www\./;

let markedLib = null;
let domPurifyLib = null;
let katexLib = null;
let loadPromise = null;

const renderCache = new Map();
const placeholderCache = new Map();
let cacheHits = 0;
let cacheMisses = 0;

/**
 * Escape HTML special characters for safe plain-text rendering.
 */
export function escapeHtml(str) {
  const s = String(str ?? '');
  if (!RE_HTML_SPECIAL.test(s)) return s;
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Return true once Markdown, DOMPurify, and KaTeX are loaded.
 */
export function isRichTextReady() {
  return Boolean(markedLib && domPurifyLib && katexLib);
}

/**
 * Lazy-load KaTeX CSS, marked, dompurify, and katex once on demand.
 * Deduplicates concurrent calls and resets on failure so retries succeed.
 */
export function ensureRichTextReady() {
  if (isRichTextReady()) return Promise.resolve(true);
  if (loadPromise) return loadPromise;

  if (typeof document !== 'undefined' && !document.querySelector(`link[data-katex-css], link[href="${KATEX_CSS_URL}"]`)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = KATEX_CSS_URL;
    link.setAttribute('data-katex-css', '');
    document.head.appendChild(link);
  }

  loadPromise = Promise.all([
    import('marked'),
    import('dompurify'),
    import('katex')
  ]).then(([markedMod, purifyMod, katexMod]) => {
    const m = markedMod?.marked || markedMod?.default || markedMod;
    const rawD = purifyMod?.default || purifyMod;
    const d = rawD && typeof rawD.sanitize === 'function'
      ? rawD
      : (typeof rawD === 'function' && typeof window !== 'undefined' ? rawD(window) : rawD);
    const k = katexMod?.default || katexMod;

    if (!m || typeof m.parse !== 'function' || !d || typeof d.sanitize !== 'function' || !k || typeof k.renderToString !== 'function') {
      throw new Error('Rich-text libraries failed to initialize');
    }

    markedLib = m;
    domPurifyLib = d;
    katexLib = k;
    renderCache.clear();
    return true;
  }).catch((err) => {
    console.warn('Không thể tải thư viện rich-text:', err);
    markedLib = null;
    domPurifyLib = null;
    katexLib = null;
    loadPromise = null;
    return false;
  });

  return loadPromise;
}

/**
 * Render Markdown + LaTeX + underline safely, with bounded LRU caching once libs are ready.
 */
export function renderRichText(str) {
  const input = String(str ?? '');
  if (!isRichTextReady()) {
    return escapeHtml(input).replace(RE_NEWLINE, '<br>');
  }

  if (renderCache.has(input)) {
    cacheHits++;
    const cached = renderCache.get(input);
    if (renderCache.size >= MAX_CACHE * 0.8) {
      renderCache.delete(input);
      renderCache.set(input, cached);
    }
    return cached;
  }

  cacheMisses++;
  if (!RE_RICH_SYNTAX.test(input)) {
    const plain = escapeHtml(input);
    if (renderCache.size >= MAX_CACHE) {
      renderCache.delete(renderCache.keys().next().value);
    }
    renderCache.set(input, plain);
    return plain;
  }
  let mathTokens = null;
  let text = input;
  if (input.includes('$')) {
    mathTokens = [];
    const stashMath = (expr, displayMode) => {
      const idx = mathTokens.length;
      mathTokens.push(katexLib.renderToString(expr.trim(), { displayMode, throwOnError: false }));
      return `KATEXMATHTOKEN${idx}END`;
    };
    text = input
      .replace(RE_DISPLAY_MATH, (_, expr) => stashMath(expr, true))
      .replace(RE_INLINE_MATH, (_, expr) => stashMath(expr, false));
  }

  let html = markedLib.parse(text, { gfm: true, breaks: true });
  if (html.includes('++')) {
    html = html.replace(RE_UNDERLINE, (m, code, inner) => code || `<u>${inner}</u>`);
  }
  if (html.includes('<table>')) {
    html = html
      .replace(RE_TABLE_OPEN, '<div class="md-table-wrap"><table class="md-table">')
      .replace(RE_TABLE_CLOSE, '</table></div>');
  }
  if (html.includes('<code>')) {
    html = html.replace(RE_CODE_OPEN, (m, pre) => (pre ? m : '<code class="md-code">'));
  }

  const trimmed = html.trim();
  if (RE_SINGLE_P.test(trimmed) && (trimmed.match(RE_P_OPEN) || []).length === 1) {
    html = trimmed.slice(3, -4);
  }

  html = domPurifyLib.sanitize(html, { USE_PROFILES: { html: true } });
  const result = mathTokens && mathTokens.length > 0
    ? html.replace(RE_MATH_TOKEN, (_, i) => mathTokens[Number(i)])
    : html;

  if (renderCache.size >= MAX_CACHE) {
    const oldestKey = renderCache.keys().next().value;
    renderCache.delete(oldestKey);
  }
  renderCache.set(input, result);
  return result;
}

/**
 * Render rich preview HTML or an escaped placeholder span when empty.
 */
export function renderRichPreviewHtml(str, placeholder) {
  if (!String(str ?? '').trim()) {
    const key = String(placeholder || 'Nhấn để nhập...');
    if (placeholderCache.has(key)) {
      const cached = placeholderCache.get(key);
      placeholderCache.delete(key);
      placeholderCache.set(key, cached);
      return cached;
    }
    const html = `<span class="gf-rich-placeholder">${escapeHtml(key)}</span>`;
    if (placeholderCache.size >= MAX_PLACEHOLDER_CACHE) {
      placeholderCache.delete(placeholderCache.keys().next().value);
    }
    placeholderCache.set(key, html);
    return html;
  }
  return renderRichText(str);
}

/**
 * Return rich-text cache diagnostics.
 */
export function getRichTextCacheStats() {
  return {
    size: renderCache.size,
    hits: cacheHits,
    misses: cacheMisses
  };
}

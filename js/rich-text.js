// Rich-text editing for blog posts: Quill 2 (the editor) and DOMPurify (HTML sanitizer), both
// self-hosted under assets/vendor/ and loaded only when an editor is first opened, plus the
// helpers that turn the editor's HTML into what's stored:
//   body_html — sanitized HTML limited to the tags below (what the public site renders)
//   body      — a plain-text copy (paragraphs separated by blank lines) for older renderers

const QUILL_JS = './assets/vendor/quill-2.0.3/quill.js';
const QUILL_CSS = './assets/vendor/quill-2.0.3/quill.snow.css';
const PURIFY_JS = './assets/vendor/dompurify-3.2.7/purify.min.js';

// The only markup a post may contain. Anything else (inline styles, fonts, colours, scripts,
// iframes, classes other than alignment) is stripped on save.
const ALLOWED_TAGS = ['h2', 'h3', 'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'a', 'ul', 'ol', 'li', 'blockquote', 'img', 'hr'];
const ALLOWED_ATTR = ['href', 'target', 'rel', 'src', 'alt', 'class', 'data-list'];
const ALLOWED_CLASSES = /^ql-align-(center|right|justify)$/;

let loading = null;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${src}`));
    document.head.appendChild(s);
  });
}
export function loadEditor() {
  if (window.Quill && window.DOMPurify) return Promise.resolve();
  if (!loading) {
    const build = document.querySelector('meta[name="build"]')?.content;
    const v = src => (build ? `${src}?v=${encodeURIComponent(build)}` : src);
    if (!document.querySelector(`link[data-quill-css]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = v(QUILL_CSS);
      link.dataset.quillCss = '1';
      document.head.appendChild(link);
    }
    loading = Promise.all([loadScript(v(QUILL_JS)), loadScript(v(PURIFY_JS))]).catch(e => { loading = null; throw e; });
  }
  return loading;
}

// Creates a Quill editor inside `el`. onImage() is called when the toolbar's image button is
// used; it should resolve to { url, alt } (or null to cancel) — the caller handles picking,
// compressing and uploading the file.
export function createEditor(el, { placeholder = '', onImage, onChange } = {}) {
  const Quill = window.Quill;
  const quill = new Quill(el, {
    theme: 'snow',
    placeholder,
    modules: {
      toolbar: {
        container: [
          [{ header: [2, 3, false] }],
          ['bold', 'italic', 'underline', 'strike'],
          [{ list: 'ordered' }, { list: 'bullet' }, 'blockquote'],
          [{ align: [] }],
          ['link', 'image'],
          ['clean']
        ],
        handlers: {
          image: async () => {
            if (!onImage) return;
            const range = quill.getSelection(true);
            const img = await onImage();
            if (!img?.url) return;
            const at = range ? range.index : quill.getLength();
            quill.insertEmbed(at, 'image', img.url, 'user');
            if (img.alt) {
              // Quill's image blot keeps the alt attribute when it's set on the element.
              const [leaf] = quill.getLeaf(at + 1);
              leaf?.domNode?.setAttribute?.('alt', img.alt);
            }
            quill.setSelection(at + 1, 0, 'silent');
          }
        }
      },
      clipboard: { matchVisual: false },
      history: { delay: 800, maxStack: 200, userOnly: true }
    },
    // Only the formats the toolbar offers — pasted fonts, colours and sizes are dropped.
    formats: ['header', 'bold', 'italic', 'underline', 'strike', 'list', 'blockquote', 'align', 'link', 'image']
  });
  // Toolbar tooltips (Quill ships none).
  const titles = {
    '.ql-bold': 'Bold (Ctrl+B)', '.ql-italic': 'Italic (Ctrl+I)', '.ql-underline': 'Underline (Ctrl+U)', '.ql-strike': 'Strikethrough',
    '.ql-list[value="ordered"]': 'Numbered list', '.ql-list[value="bullet"]': 'Bulleted list', '.ql-blockquote': 'Quote',
    '.ql-link': 'Link', '.ql-image': 'Insert image (compressed to 100 KB)', '.ql-clean': 'Clear formatting', '.ql-header': 'Heading', '.ql-align': 'Alignment'
  };
  const toolbar = quill.getModule('toolbar').container;
  Object.entries(titles).forEach(([sel, t]) => toolbar.querySelectorAll(sel).forEach(b => b.setAttribute('title', t)));
  // Pasted <script>/<style> contents would otherwise land in the post as plain text.
  const Delta = Quill.import('delta');
  ['script', 'style', 'noscript', 'template'].forEach(tag => quill.clipboard.addMatcher(tag.toUpperCase(), () => new Delta()));
  if (onChange) quill.on('text-change', () => onChange(quill));
  return quill;
}

// Editor HTML → clean, storable HTML. Empty paragraphs from extra Enter presses are trimmed
// at the start and end; links open safely in a new tab when they point off-site.
export function sanitizeHtml(html) {
  const clean = window.DOMPurify.sanitize(html || '', { ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false });
  const doc = new DOMParser().parseFromString(`<div>${clean}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  root.querySelectorAll('[class]').forEach(el => {
    const keep = [...el.classList].filter(c => ALLOWED_CLASSES.test(c));
    if (keep.length) el.className = keep.join(' '); else el.removeAttribute('class');
  });
  root.querySelectorAll('a:not([href])').forEach(a => a.replaceWith(...a.childNodes));
  root.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href');
    if (!/^(https?:|mailto:|tel:|\/|#)/i.test(href)) { a.replaceWith(...a.childNodes); return; }
    if (/^https?:/i.test(href) && !/^https?:\/\/([a-z0-9-]+\.)*keys99\.com(\/|$)/i.test(href)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    } else {
      a.removeAttribute('target');
      a.removeAttribute('rel');
    }
  });
  root.querySelectorAll('img').forEach(img => { if (!/^https?:/i.test(img.getAttribute('src') || '')) img.remove(); });
  // Quill 2 writes every run of list items as one <ol>, marking each <li> data-list="bullet"
  // or "ordered" — so a bulleted list followed by a numbered one share a single <ol>. Split
  // each run into proper <ul>/<ol> lists so the stored HTML is ordinary, portable markup.
  root.querySelectorAll('ol').forEach(ol => {
    const groups = [];
    [...ol.children].forEach(li => {
      const type = li.getAttribute('data-list') === 'bullet' ? 'ul' : 'ol';
      if (!groups.length || groups[groups.length - 1].type !== type) groups.push({ type, items: [] });
      groups[groups.length - 1].items.push(li);
    });
    const lists = groups.map(g => { const el = doc.createElement(g.type); g.items.forEach(li => el.appendChild(li)); return el; });
    ol.replaceWith(...lists);
  });
  root.querySelectorAll('li[data-list]').forEach(li => li.removeAttribute('data-list'));
  const isBlank = el => el && el.tagName === 'P' && !el.textContent.trim() && !el.querySelector('img');
  while (isBlank(root.firstElementChild)) root.firstElementChild.remove();
  while (isBlank(root.lastElementChild)) root.lastElementChild.remove();
  return root.innerHTML.trim();
}

// Stored HTML → the editor. Lists saved as <ul> go back to Quill's own format.
export function htmlForEditor(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  root.querySelectorAll('ul').forEach(ul => {
    const ol = doc.createElement('ol');
    [...ul.children].forEach(li => { li.setAttribute('data-list', 'bullet'); ol.appendChild(li); });
    ul.replaceWith(ol);
  });
  root.querySelectorAll('ol > li:not([data-list])').forEach(li => li.setAttribute('data-list', 'ordered'));
  return root.innerHTML;
}

const escapeText = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// A post written before the editor existed (plain text) → paragraphs: blank lines separate
// paragraphs, single line breaks are kept inside them.
export function textToHtml(text) {
  return String(text || '').replace(/\r\n?/g, '\n').split(/\n{2,}/)
    .map(p => p.trim()).filter(Boolean)
    .map(p => `<p>${escapeText(p).replace(/\n/g, '<br>')}</p>`).join('');
}

// Stored HTML → plain text for the `body` column.
export function htmlToPlainText(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  const blocks = [];
  const walk = (el) => {
    for (const node of el.children) {
      const tag = node.tagName;
      if (tag === 'UL' || tag === 'OL') {
        const lines = [...node.children].map((li, i) => `${tag === 'OL' ? `${i + 1}.` : '•'} ${li.textContent.trim()}`);
        blocks.push(lines.join('\n'));
      } else if (tag === 'HR') {
        blocks.push('———');
      } else if (tag === 'IMG') {
        if (node.alt) blocks.push(`[Image: ${node.alt}]`);
      } else {
        node.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
        const t = node.textContent.trim();
        if (t) blocks.push(t);
      }
    }
  };
  walk(root);
  return blocks.join('\n\n');
}

export function wordCount(text) {
  return (String(text || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
}
// ~200 words a minute, rounded up, at least 1 for any non-empty post.
export function readingTime(text) {
  const w = wordCount(text);
  return w ? Math.max(1, Math.ceil(w / 200)) : 0;
}

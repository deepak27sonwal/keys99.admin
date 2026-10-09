// Builds the HTML of a Keys99 newsletter email from the composer's rich-text body.
//
// Email clients (Gmail, Outlook, Apple Mail) ignore most CSS, so the output is the classic
// email layout: a centred 600px table, every style inline, web-safe fonts. The body HTML from
// the editor (h2, h3, p, lists, quotes, links, images — see rich-text.js) gets inline styles
// tag by tag. Merge tags ({{first_name}}, {{name}}, {{email}}, {{unsubscribe_url}}) are left
// in place; the send-newsletter function fills them in per recipient.

const BRAND = '#046b5e';
const INK = '#0a2f2c';
const TEXT = '#33413f';
const MUTED = '#6b7f85';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export const MERGE_TAGS = [
  { tag: '{{first_name}}', label: 'First name' },
  { tag: '{{name}}', label: 'Full name' },
  { tag: '{{email}}', label: 'Email' }
];

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const STYLES = {
  h2: `margin:28px 0 12px;font-family:${FONT};font-size:22px;line-height:1.3;font-weight:700;color:${INK}`,
  h3: `margin:22px 0 10px;font-family:${FONT};font-size:18px;line-height:1.35;font-weight:700;color:${INK}`,
  p: `margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:1.65;color:${TEXT}`,
  ul: `margin:0 0 16px;padding-left:22px;font-family:${FONT};font-size:16px;line-height:1.65;color:${TEXT}`,
  ol: `margin:0 0 16px;padding-left:22px;font-family:${FONT};font-size:16px;line-height:1.65;color:${TEXT}`,
  li: 'margin:0 0 6px',
  blockquote: `margin:20px 0;padding:14px 18px;border-left:4px solid ${BRAND};background:#e8f4f2;font-family:${FONT};font-size:16px;line-height:1.6;color:${INK}`,
  a: `color:${BRAND};text-decoration:underline`,
  img: 'display:block;max-width:100%;height:auto;border:0;border-radius:10px;margin:8px 0',
  hr: 'border:0;border-top:1px solid #e6edec;margin:24px 0'
};
const ALIGN = { 'ql-align-center': 'center', 'ql-align-right': 'right', 'ql-align-justify': 'justify' };

// Editor HTML → email-safe HTML with inline styles.
export function inlineEmailStyles(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  root.querySelectorAll('*').forEach(el => {
    const tag = el.tagName.toLowerCase();
    let style = STYLES[tag] || '';
    const align = [...el.classList].map(c => ALIGN[c]).find(Boolean);
    if (align) style += `;text-align:${align}`;
    if (tag === 'img') {
      el.setAttribute('width', '536');   // Outlook needs an explicit width; max-width keeps it responsive
      if (align === 'center') style += ';margin-left:auto;margin-right:auto';
    }
    if (tag === 'a') el.setAttribute('target', '_blank');
    el.removeAttribute('class');
    if (style) el.setAttribute('style', style);
  });
  // Blockquotes may hold bare text; give paragraphs inside them no extra bottom gap.
  root.querySelectorAll('blockquote p').forEach(p => p.setAttribute('style', `${STYLES.p};margin:0`));
  return root.innerHTML;
}

// subject, preheader: plain text; bodyHtml: editor HTML; opts: { logoUrl, contact: { email, phone }, siteUrl }
export function buildEmailHtml({ subject, preheader, bodyHtml }, opts = {}) {
  const site = opts.siteUrl || 'https://keys99.com';
  const contactBits = [
    opts.contact?.phone ? `<a href="tel:${esc(String(opts.contact.phone).replace(/\s+/g, ''))}" style="color:${MUTED};text-decoration:none">${esc(opts.contact.phone)}</a>` : '',
    opts.contact?.email ? `<a href="mailto:${esc(opts.contact.email)}" style="color:${MUTED};text-decoration:none">${esc(opts.contact.email)}</a>` : '',
    `<a href="${esc(site)}" style="color:${MUTED};text-decoration:none">keys99.com</a>`
  ].filter(Boolean).join(' &nbsp;·&nbsp; ');
  const logo = opts.logoUrl
    ? `<img src="${esc(opts.logoUrl)}" width="150" alt="Keys99.com" style="display:block;border:0;width:150px;max-width:150px;height:auto">`
    : `<span style="font-family:${FONT};font-size:22px;font-weight:800;letter-spacing:.02em;color:${BRAND}">KEYS99.COM</span>`;

  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<title>${esc(subject)}</title>
<style>
  @media (max-width:620px){ .k99-card{padding:24px 20px !important} .k99-wrap{padding:12px !important} }
  a{color:${BRAND}}
</style>
</head>
<body style="margin:0;padding:0;background:#f2f6f5;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(preheader || '')}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f2f6f5">
  <tr><td align="center" class="k99-wrap" style="padding:28px 12px">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
      <tr><td style="padding:4px 4px 18px" align="left">
        <a href="${esc(site)}" style="text-decoration:none">${logo}</a>
      </td></tr>
      <tr><td class="k99-card" style="background:#ffffff;border-radius:14px;padding:34px 32px;border:1px solid #e6edec">
        ${inlineEmailStyles(bodyHtml)}
      </td></tr>
      <tr><td align="center" style="padding:22px 16px 8px;font-family:${FONT};font-size:12.5px;line-height:1.7;color:${MUTED}">
        <div style="font-weight:700;color:${INK}">Keys99.com — Your Key to a Better Tomorrow</div>
        <div>${contactBits}</div>
        <div style="margin-top:10px">You're receiving this because you subscribed to Keys99 updates or have an account on keys99.com.<br>
          <a href="{{unsubscribe_url}}" style="color:${MUTED};text-decoration:underline">Unsubscribe</a></div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// What the preview / test shows for merge tags.
export function fillSampleMergeTags(html, sample = { name: 'Rahul Sharma', email: 'rahul@example.com' }) {
  return html
    .replace(/\{\{\s*first_name\s*\}\}/g, esc(sample.name.split(' ')[0]))
    .replace(/\{\{\s*name\s*\}\}/g, esc(sample.name))
    .replace(/\{\{\s*email\s*\}\}/g, esc(sample.email))
    .replace(/\{\{\s*unsubscribe_url\s*\}\}/g, '#');
}

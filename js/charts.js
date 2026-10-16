import { sb } from './supabase-client.js';
import { escapeHtml } from './utils.js';

// Chart and number helpers shared by Analytics (js/analytics.js) and the Dashboard
// (js/dashboard.js): one categorical colour order (blue, orange, aqua), India-time day/hour
// buckets, SVG bars with a 4px rounded data-end, sparklines, signed change badges, a text-only
// hover tooltip, and paged reads past PostgREST's 1,000-row cap.

export const DAY = 86400000;
export const IST = 19800000;                // +05:30
export const C = { blue: '#2a78d6', orange: '#eb6834', aqua: '#1baf7a' };
export const MAX_ROWS = 60000;

// ---------- formatting ----------

export const fmtInt = n => Math.round(n).toLocaleString('en-IN');
export function fmtCompact(n) {
  if (!isFinite(n)) return '–';
  if (Math.abs(n) >= 1e5) return `${(n / 1e5).toFixed(1).replace(/\.0$/, '')} L`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}k`;
  return fmtInt(n);
}
export const fmtPct = (n, digits = 1) => `${(n * 100).toFixed(digits).replace(/\.0$/, '')}%`;
export const fmtRatio = n => (isFinite(n) ? n.toFixed(2) : '–');

export const istDay = ts => Math.floor((ts + IST) / DAY);                 // day number in India time
export const istHour = ts => Math.floor(((ts + IST) % DAY) / 3600000);
export const istMidnight = ts => istDay(ts) * DAY - IST;
export const dayLabel = (dayNo, opts = { day: 'numeric', month: 'short' }) =>
  new Date(dayNo * DAY).toLocaleDateString('en-IN', { ...opts, timeZone: 'UTC' });
export const hourLabel = h => `${h % 12 || 12} ${h < 12 ? 'am' : 'pm'}`;

// Every row of `table` matching `filter`, in pages of 1,000 (PostgREST's cap), up to MAX_ROWS.
export async function fetchAll(table, cols, filter) {
  const PAGE = 1000;
  const first = await filter(sb.from(table).select(cols, { count: 'exact' })).order('created_at', { ascending: true }).range(0, PAGE - 1);
  if (first.error) return { rows: [], error: first.error, truncated: false };
  const rows = [...(first.data || [])];
  const total = Math.min(first.count ?? rows.length, MAX_ROWS);
  const offsets = [];
  for (let from = PAGE; from < total; from += PAGE) offsets.push(from);
  for (let i = 0; i < offsets.length; i += 6) {
    const pages = await Promise.all(offsets.slice(i, i + 6).map(from =>
      filter(sb.from(table).select(cols)).order('created_at', { ascending: true }).range(from, from + PAGE - 1)));
    for (const p of pages) {
      if (p.error) return { rows, error: p.error, truncated: true };
      rows.push(...(p.data || []));
    }
  }
  return { rows, error: null, truncated: (first.count || 0) > MAX_ROWS };
}

// ---------- SVG helpers ----------

// A bar with 4px rounded data-end (top) and a square baseline.
export function barPath(x, y, w, h, r = 4) {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function niceMax(v) {
  if (v <= 0) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].map(m => m * pow / 4).find(s => s * 4 >= v) || pow * 2.5;
  return step * 4;
}

export function sparkline(values, { width = 120, height = 32 } = {}) {
  if (!values.length) return '';
  const max = Math.max(...values, 0) || 1;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const pts = values.map((v, i) => [values.length > 1 ? i * step : width / 2, height - 3 - (v / max) * (height - 6)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const area = `${d}L${pts[pts.length - 1][0].toFixed(1)},${height}L${pts[0][0].toFixed(1)},${height}Z`;
  return `<svg class="an-spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${area}" fill="${C.blue}" fill-opacity=".1"/>
    <path d="${d}" fill="none" stroke="${C.blue}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
  </svg>`;
}

export const ARROW_UP = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M6 2.5 10 7H7.2v2.5H4.8V7H2z" fill="currentColor"/></svg>';
export const ARROW_DOWN = '<svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M6 9.5 2 5h2.8V2.5h2.4V5H10z" fill="currentColor"/></svg>';

export function deltaHtml(k, prevLabel) {
  if (!k.prev && !k.value) return `<div class="an-delta flat">No change <span>vs ${escapeHtml(prevLabel)}</span></div>`;
  if (!k.prev) return `<div class="an-delta up">${ARROW_UP} New <span>vs ${escapeHtml(prevLabel)}</span></div>`;
  const ch = (k.value - k.prev) / k.prev;
  if (Math.abs(ch) < 0.005) return `<div class="an-delta flat">± 0% <span>vs ${escapeHtml(prevLabel)}</span></div>`;
  const up = ch > 0;
  const txt = `${up ? '+' : '−'}${fmtPct(Math.abs(ch), Math.abs(ch) >= 0.1 ? 0 : 1)}`;
  return `<div class="an-delta ${up ? 'up' : 'down'}" title="Previous period: ${escapeHtml(k.fmt(k.prev))}">${up ? ARROW_UP : ARROW_DOWN}<b>${txt}</b> <span>vs ${escapeHtml(prevLabel)}</span></div>`;
}

// A text-only tooltip in `tip` (an .an-tip element). Lines are strings, or [colour, name, value]
// rows with a swatch; the first string is the title. Kept inside the viewport.
export function createTooltip(tip) {
  function showTip(lines, clientX, clientY) {
    tip.replaceChildren(...lines.map((l, i) => {
      const div = document.createElement('div');
      if (Array.isArray(l)) {
        div.className = 'an-tip-row';
        const sw = document.createElement('span'); sw.className = 'an-swatch'; sw.style.background = l[0];
        const name = document.createElement('span'); name.textContent = l[1];
        const val = document.createElement('b'); val.textContent = l[2];
        div.append(sw, name, val);
      } else {
        div.textContent = l;
        if (i === 0) div.className = 'an-tip-title';
      }
      return div;
    }));
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let left = clientX + 14, top = clientY + 14;
    if (left + r.width > window.innerWidth - 8) left = clientX - r.width - 14;
    if (left < 8) left = 8;
    if (top + r.height > window.innerHeight - 8) top = clientY - r.height - 14;
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(8, top)}px`;
  }
  return { show: showTip, hide: () => { tip.hidden = true; } };
}

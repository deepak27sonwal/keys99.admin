import { sb } from './supabase-client.js';
import { pageHead, tablePanel, emptyRow, escapeHtml, timeAgo, fmtDate } from './utils.js';
import { callManageAdmins } from './admins.js';
import { liveCardHtml, bindLiveCard } from './live-visitors.js';
import {
  C, MAX_ROWS, fmtInt, fmtCompact, fmtPct, fmtRatio, istDay, istHour, istMidnight, dayLabel, hourLabel,
  fetchAll, barPath, niceMax, sparkline, deltaHtml, createTooltip, DAY, IST
} from './charts.js';

// Site Analytics for keys99.com.
//
// - "Live now" (js/live-visitors.js): who is on the site this moment.
// - A date range (Today / 7 / 30 / 90 days, India time) scopes everything below it: key
//   numbers with the change against the previous period of the same length, a traffic chart,
//   top pages, traffic sources, devices, page types and busiest hours, all worked out here from
//   the raw site_visits rows keys99.com writes (js/track.js there), plus enquiries from the three
//   enquiry tables and the activity_log feed.
// - Signed-in buyers come from the manage-admins Edge Function's "buyer_overview" action (the
//   only path that can read auth.sessions).
//
// site_visits / activity_log / *_enquiries are readable directly through `sb` because their RLS
// grants SELECT to signed-in admins. PostgREST returns at most 1,000 rows per request, so rows
// are fetched in pages (fetchAll).
//
// Chart colours follow one fixed categorical order (blue, orange, aqua) and a single blue for
// one-series charts; text never takes a series colour, and every chart has a hover read-out.

const SITE = 'https://keys99.com';
const RANGE_KEY = 'k99-analytics-range';
const RANGES = [
  { id: 'today', label: 'Today', days: 1 },
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
  { id: '90d', label: '90 days', days: 90 }
];

const ACTION_LABELS = {
  page_view: 'Page view',
  search: 'Search',
  save_project: 'Saved a project',
  unsave_project: 'Removed a saved project',
  enquiry_submit: 'Submitted an enquiry',
  login: 'Signed in',
  logout: 'Signed out',
  admin_password_changed: 'Changed an admin password'
};

function actionLabel(action) {
  return ACTION_LABELS[action] || (action ? action.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()) : '—');
}

// ---------- page paths ----------

const isSitePath = p => typeof p === 'string' && /^\/(?![\/\\])/.test(p);

// "/projects/shriram-nyra/?x=1" -> "/projects/shriram-nyra"
function cleanPath(p) {
  let s = String(p || '/').split(/[?#]/)[0] || '/';
  if (s.length > 1) s = s.replace(/\/+$/, '') || '/';
  return s;
}

function pageKind(path) {
  if (path === '/') return 'home';
  if (path === '/projects/compare') return 'compare';
  const seg = path.split('/')[1] || '';
  if (seg === 'projects' || seg === 'project') return 'project';
  if (seg === 'commercial') return 'commercial';
  if (seg === 'rent' || seg === 'rentals' || seg === 'rental') return 'rental';
  if (seg === 'blog') return 'blog';
  if (seg === 'search') return 'search';
  return 'other';
}
const KIND_LABELS = { home: 'Home', project: 'Residential projects', commercial: 'Commercial', rental: 'Rentals', blog: 'Blog', compare: 'Compare', search: 'Search', other: 'Other pages' };

const titleCase = s => s.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase());
function pageLabel(path) {
  if (path === '/') return 'Home';
  if (path === '/projects/compare') return 'Compare projects';
  const parts = path.split('/').filter(Boolean);
  const kind = pageKind(path);
  if (parts.length === 1) return KIND_LABELS[kind] && kind !== 'other' ? KIND_LABELS[kind] : titleCase(parts[0]);
  let last = parts[parts.length - 1];
  if (kind === 'rental') last = last.replace(/-[0-9a-f]{6,}$/i, '');
  return titleCase(decodeSafe(last)) || path;
}
function decodeSafe(s) { try { return decodeURIComponent(s); } catch (_) { return s; } }

// ---------- traffic sources ----------

const SOURCE_RULES = [
  [/(^|\.)google\./, 'Google'],
  [/(^|\.)bing\.com$/, 'Bing'],
  [/(^|\.)(duckduckgo\.com|search\.yahoo\.com|yandex\.)/, 'Other search'],
  [/(^|\.)whatsapp\.(com|net)$|^wa\.me$/, 'WhatsApp'],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, 'Facebook'],
  [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)(t\.co|twitter\.com|x\.com)$/, 'X (Twitter)'],
  [/(^|\.)(linkedin\.com|lnkd\.in)$/, 'LinkedIn'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'YouTube'],
  [/(^|\.)chatgpt\.com$|(^|\.)openai\.com$|(^|\.)perplexity\.ai$|(^|\.)claude\.ai$|(^|\.)gemini\.google\.com$/, 'AI assistants']
];
const UTM_NAMES = { google: 'Google', facebook: 'Facebook', fb: 'Facebook', instagram: 'Instagram', ig: 'Instagram', whatsapp: 'WhatsApp', wa: 'WhatsApp', linkedin: 'LinkedIn', youtube: 'YouTube', twitter: 'X (Twitter)', x: 'X (Twitter)', newsletter: 'Newsletter', email: 'Newsletter', brevo: 'Newsletter' };

function sourceOf(row) {
  const utm = String(row.utm_source || '').trim().toLowerCase();
  if (utm) return UTM_NAMES[utm] || titleCase(utm).slice(0, 40);
  const ref = String(row.referrer || '').trim();
  if (!ref) return 'Direct';
  let host;
  try { host = new URL(ref).hostname.toLowerCase().replace(/^www\.|^m\.|^l\.|^lm\./, ''); } catch (_) { return 'Direct'; }
  if (!host || host === 'keys99.com' || host.endsWith('.keys99.com')) return 'Direct';
  if (host === 'gemini.google.com') return 'AI assistants';
  for (const [re, name] of SOURCE_RULES) if (re.test(host)) return name;
  return host.slice(0, 60);
}

// ---------- data ----------


function periodFor(rangeId, now = Date.now()) {
  const r = RANGES.find(x => x.id === rangeId) || RANGES[1];
  const start = istMidnight(now) - (r.days - 1) * DAY;
  const span = r.days * DAY;
  return { range: r, start, end: now, prevStart: start - span, prevEnd: now - span, hourly: r.days === 1 };
}

async function loadData(period) {
  const fromIso = new Date(period.prevStart).toISOString();
  const since = q => q.gte('created_at', fromIso);
  const [visits, res, com, rent, activity, buyers] = await Promise.all([
    fetchAll('site_visits', 'created_at,session_id,visitor_id,page_path,referrer,utm_source,device_type', since),
    fetchAll('residential_enquiries', 'created_at', since),
    fetchAll('commercial_enquiries', 'created_at', since),
    fetchAll('rental_property_enquiries', 'created_at', since),
    sb.from('activity_log').select('id,actor_type,action,entity_type,entity_id,metadata,created_at')
      .gte('created_at', new Date(period.start).toISOString()).order('created_at', { ascending: false }).limit(100),
    callManageAdmins({ action: 'buyer_overview' }).catch(e => ({ error: e.message || String(e) }))
  ]);
  const enquiryRows = [...res.rows, ...com.rows, ...rent.rows];
  const enquiryError = [res, com, rent].map(x => x.error).find(Boolean) || null;
  return { visits, enquiryRows, enquiryError, activity, buyers };
}

// Splits [start, end] into buckets (hours for Today, India-time days otherwise).
function bucketsFor(period, offset = 0) {
  const start = period.start - offset;
  if (period.hourly) {
    const hours = Math.max(1, Math.floor((period.end - period.start) / 3600000) + 1);
    return Array.from({ length: Math.min(hours, 24) }, (_, i) => ({ t: start + i * 3600000, label: hourLabel(i), long: `${hourLabel(i)} – ${hourLabel((i + 1) % 24)}` }));
  }
  return Array.from({ length: period.range.days }, (_, i) => {
    const d = istDay(start) + i;
    return { t: d * DAY - IST, label: dayLabel(d), long: dayLabel(d, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) };
  });
}
const bucketIndex = (period, ts, offset = 0) => period.hourly
  ? Math.floor((ts - (period.start - offset)) / 3600000)
  : istDay(ts) - istDay(period.start - offset);

function analyse(period, data) {
  const visitor = r => r.visitor_id || r.session_id || 'anon';
  const ts = r => new Date(r.created_at).getTime();
  const rows = data.visits.rows.map(r => ({ ...r, ts: ts(r), path: cleanPath(r.page_path) }));
  const cur = rows.filter(r => r.ts >= period.start && r.ts <= period.end);
  const prev = rows.filter(r => r.ts >= period.prevStart && r.ts <= period.prevEnd);
  const enqTs = data.enquiryRows.map(ts);
  const enqCur = enqTs.filter(t => t >= period.start && t <= period.end);
  const enqPrev = enqTs.filter(t => t >= period.prevStart && t <= period.prevEnd);

  const buckets = bucketsFor(period);
  const n = buckets.length;
  const series = () => Array.from({ length: n }, () => 0);
  const views = series(), enq = series();
  const visitorSets = Array.from({ length: n }, () => new Set());
  cur.forEach(r => { const i = bucketIndex(period, r.ts); if (i >= 0 && i < n) { views[i]++; visitorSets[i].add(visitor(r)); } });
  enqCur.forEach(t => { const i = bucketIndex(period, t); if (i >= 0 && i < n) enq[i]++; });
  const visitors = visitorSets.map(s => s.size);

  const totals = rs => ({ views: rs.length, visitors: new Set(rs.map(visitor)).size });
  const tc = totals(cur), tp = totals(prev);
  const kpis = [
    { id: 'visitors', label: 'Visitors', value: tc.visitors, prev: tp.visitors, fmt: fmtCompact, spark: visitors, help: 'Unique browsers' },
    { id: 'views', label: 'Page views', value: tc.views, prev: tp.views, fmt: fmtCompact, spark: views, help: 'Pages opened' },
    { id: 'ppv', label: 'Pages per visitor', value: tc.visitors ? tc.views / tc.visitors : 0, prev: tp.visitors ? tp.views / tp.visitors : 0, fmt: fmtRatio, spark: views.map((v, i) => visitors[i] ? v / visitors[i] : 0), help: 'Page views ÷ visitors' },
    { id: 'enquiries', label: 'Enquiries', value: enqCur.length, prev: enqPrev.length, fmt: fmtCompact, spark: enq, help: 'Residential, commercial and rental' },
    { id: 'conv', label: 'Conversion', value: tc.visitors ? enqCur.length / tc.visitors : 0, prev: tp.visitors ? enqPrev.length / tp.visitors : 0, fmt: v => fmtPct(v), spark: enq.map((e, i) => visitors[i] ? e / visitors[i] : 0), help: 'Enquiries ÷ visitors' }
  ];

  // Top pages
  const pages = new Map();
  cur.forEach(r => {
    if (!isSitePath(r.path)) return;
    const p = pages.get(r.path) || { path: r.path, views: 0, visitors: new Set() };
    p.views++; p.visitors.add(visitor(r)); pages.set(r.path, p);
  });
  const topPages = [...pages.values()].map(p => ({ ...p, visitors: p.visitors.size })).sort((a, b) => b.views - a.views || b.visitors - a.visitors);

  // First page view of each visitor in the range: their traffic source and device.
  const firstSeen = new Map();
  cur.forEach(r => { const v = visitor(r); if (!firstSeen.has(v)) firstSeen.set(v, r); });
  const sourceCounts = new Map();
  const devices = { desktop: 0, mobile: 0, tablet: 0 };
  firstSeen.forEach(r => {
    const s = sourceOf(r);
    sourceCounts.set(s, (sourceCounts.get(s) || 0) + 1);
    const d = ['mobile', 'tablet', 'desktop'].includes(r.device_type) ? r.device_type : 'desktop';
    devices[d]++;
  });
  const sources = [...sourceCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

  const kindCounts = new Map();
  cur.forEach(r => { const k = pageKind(r.path); kindCounts.set(k, (kindCounts.get(k) || 0) + 1); });
  const kinds = [...kindCounts.entries()].map(([k, count]) => ({ name: KIND_LABELS[k], count })).sort((a, b) => b.count - a.count);

  const hours = Array.from({ length: 24 }, () => 0);
  cur.forEach(r => { hours[istHour(r.ts)]++; });

  return { hourly: period.hourly, buckets, views, visitors, kpis, topPages, sources, devices, kinds, hours, totals: tc };
}

// ---------- rendering ----------


function kpiTilesHtml(kpis, prevLabel) {
  return `<div class="an-kpis">${kpis.map(k => `
    <div class="an-kpi" data-kpi="${k.id}">
      <div class="an-kpi-label" title="${escapeHtml(k.help)}">${escapeHtml(k.label)}</div>
      <div class="an-kpi-value">${escapeHtml(k.fmt(k.value))}</div>
      ${deltaHtml(k, prevLabel)}
      ${sparkline(k.spark)}
    </div>`).join('')}</div>`;
}

function panel(title, sub, body, extraHead = '', cls = '') {
  return `<section class="panel an-panel ${cls}">
    <div class="panel-head"><div><h2>${escapeHtml(title)}</h2>${sub ? `<div class="an-sub">${escapeHtml(sub)}</div>` : ''}</div>${extraHead}</div>
    <div class="an-body">${body}</div>
  </section>`;
}

function barListHtml(items, { total, valueLabel = 'views', link = false, limit = 8, secondary } = {}) {
  if (!items.length) return '<div class="empty">No data for this period.</div>';
  const max = Math.max(...items.map(i => i.count)) || 1;
  const shown = items.slice(0, limit);
  const rest = items.slice(limit).reduce((s, i) => s + i.count, 0);
  const rowsHtml = shown.map(i => {
    const name = link && isSitePath(i.path)
      ? `<a href="${escapeHtml(SITE + i.path)}" target="_blank" rel="noopener noreferrer">${escapeHtml(i.name)}</a>`
      : escapeHtml(i.name);
    const share = total ? fmtPct(i.count / total, 0) : '';
    return `<li class="an-bar-row" data-tip="${escapeHtml(`${i.name}\n${fmtInt(i.count)} ${valueLabel}${share ? ` · ${share}` : ''}${secondary ? `\n${secondary(i)}` : ''}`)}">
      <div class="an-bar-text"><div class="an-bar-name">${name}${i.sub ? `<div class="an-bar-sub">${escapeHtml(i.sub)}</div>` : ''}</div>
        <div class="an-bar-val"><b>${fmtInt(i.count)}</b>${share ? `<span>${share}</span>` : ''}</div></div>
      <div class="an-bar-track"><div class="an-bar-fill" style="width:${Math.max(1, (i.count / max) * 100).toFixed(1)}%"></div></div>
    </li>`;
  }).join('');
  const more = rest ? `<li class="an-bar-more">+ ${items.length - limit} more · ${fmtInt(rest)} ${valueLabel}</li>` : '';
  return `<ol class="an-bars">${rowsHtml}${more}</ol>`;
}

function devicesHtml(devices) {
  const total = devices.desktop + devices.mobile + devices.tablet;
  if (!total) return '<div class="empty">No data for this period.</div>';
  const slots = [['desktop', 'Desktop', C.blue], ['mobile', 'Mobile', C.orange], ['tablet', 'Tablet', C.aqua]].filter(([k]) => devices[k] || k !== 'tablet');
  const segs = slots.filter(([k]) => devices[k]).map(([k, label, color]) =>
    `<div class="an-seg" style="flex:${devices[k]};background:${color}" data-tip="${escapeHtml(`${label}\n${fmtInt(devices[k])} visitors · ${fmtPct(devices[k] / total, 0)}`)}"></div>`).join('');
  const legend = slots.map(([k, label, color]) => `<li><span class="an-swatch" style="background:${color}"></span><span class="an-leg-name">${label}</span><b>${fmtPct(devices[k] / total, 0)}</b><span class="an-leg-count">${fmtInt(devices[k])}</span></li>`).join('');
  return `<div class="an-stack" role="img" aria-label="${escapeHtml(slots.map(([k, l]) => `${l} ${fmtPct(devices[k] / total, 0)}`).join(', '))}">${segs}</div><ul class="an-legend an-legend-col">${legend}</ul>`;
}

function hoursChartSvg(hours, width) {
  const H = 160, padL = 34, padR = 6, padT = 10, padB = 22;
  const w = Math.max(240, width);
  const plotW = w - padL - padR, plotH = H - padT - padB;
  const max = niceMax(Math.max(...hours));
  const slot = plotW / 24;
  const bw = Math.min(24, Math.max(4, slot - 2));
  const ticks = [0, 0.5, 1].map(f => max * f);
  const grid = ticks.map(t => { const y = padT + plotH - (t / max) * plotH; return `<line x1="${padL}" x2="${w - padR}" y1="${y}" y2="${y}" class="an-gl"/><text x="${padL - 6}" y="${y + 3.5}" class="an-axis" text-anchor="end">${fmtCompact(t)}</text>`; }).join('');
  const peak = hours.indexOf(Math.max(...hours));
  const bars = hours.map((v, h) => {
    const bh = (v / max) * plotH;
    const x = padL + h * slot + (slot - bw) / 2;
    return `<g class="an-hit" data-i="${h}"><rect x="${padL + h * slot}" y="${padT}" width="${slot}" height="${plotH}" fill="transparent"/><path d="${barPath(x, padT + plotH - bh, bw, bh)}" fill="${C.blue}"/></g>`;
  }).join('');
  const labels = [0, 6, 12, 18].map(h => `<text x="${padL + h * slot + slot / 2}" y="${H - 6}" class="an-axis" text-anchor="middle">${hourLabel(h)}</text>`).join('');
  const peakLabel = Math.max(...hours) ? `<text x="${padL + peak * slot + slot / 2}" y="${Math.max(padT + 10, padT + plotH - (hours[peak] / max) * plotH - 5)}" class="an-axis an-axis-strong" text-anchor="middle">${fmtCompact(hours[peak])}</text>` : '';
  return `<svg class="an-svg" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}" role="img" aria-label="Page views by hour of day, India time">${grid}${bars}${labels}${peakLabel}</svg>`;
}

function trafficChartSvg(a, width) {
  const H = 260, padL = 40, padR = 12, padT = 12, padB = 28;
  const w = Math.max(280, width);
  const n = a.buckets.length;
  const plotW = w - padL - padR, plotH = H - padT - padB;
  const max = niceMax(Math.max(...a.views, ...a.visitors));
  const x = i => padL + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const y = v => padT + plotH - (v / max) * plotH;
  const line = vals => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => max * f);
  const grid = ticks.map(t => `<line x1="${padL}" x2="${w - padR}" y1="${y(t)}" y2="${y(t)}" class="an-gl${t === 0 ? ' an-base' : ''}"/><text x="${padL - 8}" y="${y(t) + 3.5}" class="an-axis" text-anchor="end">${fmtCompact(t)}</text>`).join('');
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 70))));
  const xl = a.buckets.map((b, i) => (i % every === 0 || (i === n - 1 && (n - 1) % every > every / 2))
    ? `<text x="${x(i)}" y="${H - 8}" class="an-axis" text-anchor="${i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle'}">${escapeHtml(b.label)}</text>` : '').join('');
  const area = `${line(a.views)}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z`;
  const single = n === 1;
  const marks = single ? [[a.views, C.blue], [a.visitors, C.orange]].map(([vals, c]) => `<circle cx="${x(0)}" cy="${y(vals[0])}" r="4" fill="${c}" stroke="#fff" stroke-width="2"/>`).join('') : '';
  return `<svg class="an-svg an-traffic" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}" role="img" aria-label="Page views and visitors over time">
    ${grid}
    <path d="${area}" fill="${C.blue}" fill-opacity=".1"/>
    <path d="${line(a.views)}" fill="none" stroke="${C.blue}" stroke-width="2" stroke-linejoin="round"/>
    <path d="${line(a.visitors)}" fill="none" stroke="${C.orange}" stroke-width="2" stroke-linejoin="round"/>
    ${marks}
    ${xl}
    <g class="an-cross" style="display:none">
      <line class="an-cross-line" y1="${padT}" y2="${padT + plotH}"/>
      <circle class="an-cross-a" r="4" fill="${C.blue}" stroke="#fff" stroke-width="2"/>
      <circle class="an-cross-b" r="4" fill="${C.orange}" stroke="#fff" stroke-width="2"/>
    </g>
    <rect class="an-overlay" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent"/>
  </svg>`;
}

function trafficTableHtml(a, hourly) {
  return `<div class="table-wrap an-table"><table><thead><tr><th>${hourly ? 'Hour' : 'Date'}</th><th class="num">Page views</th><th class="num">Visitors</th></tr></thead><tbody>${
    a.buckets.map((b, i) => `<tr><td>${escapeHtml(b.long)}</td><td class="num">${fmtInt(a.views[i])}</td><td class="num">${fmtInt(a.visitors[i])}</td></tr>`).join('')
  }</tbody></table></div>`;
}

function buyersPanelHtml(buyers) {
  const err = buyers?.error;
  const rows = err
    ? emptyRow(4, err)
    : (buyers.recent || []).length
      ? buyers.recent.map(b => `
        <tr>
          <td>${escapeHtml(b.full_name || '—')}</td>
          <td>${escapeHtml(b.email || '—')}</td>
          <td>${Number(b.session_count) || 0} device${b.session_count === 1 ? '' : 's'}</td>
          <td>${b.last_active ? escapeHtml(timeAgo(b.last_active)) : '—'}</td>
        </tr>`).join('')
      : emptyRow(4, 'No buyers currently signed in.');
  const stats = err ? '' : `<div class="an-head-stats"><span><b>${fmtInt(buyers.active_buyers ?? 0)}</b> signed in now</span><span><b>${fmtInt(buyers.total_buyers ?? 0)}</b> registered</span></div>`;
  return tablePanel('Signed-in buyers', stats, ['Name', 'Email', 'Devices', 'Last active'], rows);
}

function activityPanelHtml(activity, rangeLabel) {
  const data = activity.data || [];
  const rows = data.length
    ? data.map(a => `
      <tr>
        <td><span class="pill ${a.actor_type === 'admin' ? 'admin' : a.actor_type === 'buyer' ? 'active' : 'draft'}">${escapeHtml(a.actor_type)}</span></td>
        <td>${escapeHtml(actionLabel(a.action))}</td>
        <td>${a.entity_type ? escapeHtml(a.entity_type) : (a.metadata?.q ? `“${escapeHtml(a.metadata.q)}”` : '—')}</td>
        <td>${fmtDate(a.created_at)} · ${escapeHtml(timeAgo(a.created_at))}</td>
      </tr>`).join('')
    : emptyRow(4, activity.error ? activity.error.message : 'No activity in this period.');
  return tablePanel(`Recent activity · ${rangeLabel}`, `<span class="an-sub">Latest ${data.length}</span>`, ['Actor', 'Action', 'Detail', 'When'], rows);
}

function readRange() {
  try { const v = localStorage.getItem(RANGE_KEY); if (RANGES.some(r => r.id === v)) return v; } catch (_) {}
  return '7d';
}
function saveRange(v) { try { localStorage.setItem(RANGE_KEY, v); } catch (_) {} }

const PREV_LABELS = { today: 'yesterday', '7d': 'previous 7 days', '30d': 'previous 30 days', '90d': 'previous 90 days' };

// ---------- page ----------

export async function analyticsPage(content) {
  let rangeId = readRange();
  let loadSeq = 0;
  let analysis = null;
  let showTable = false;

  content.innerHTML = pageHead('Analytics', 'Traffic, audience and enquiries on keys99.com') +
    liveCardHtml() +
    `<div class="an-root" id="an-root">
      <div class="an-toolbar">
        <div class="an-range" role="group" aria-label="Date range">${RANGES.map(r =>
          `<button type="button" data-range="${r.id}" aria-pressed="${r.id === rangeId}">${r.label}</button>`).join('')}</div>
        <div class="an-period" id="an-period"></div>
      </div>
      <div id="an-frame" class="an-frame"><div class="empty">Loading analytics…</div></div>
    </div>
    <div class="an-tip" id="an-tip" role="tooltip" hidden></div>`;
  bindLiveCard(content);

  const root = content.querySelector('#an-root');
  const frame = content.querySelector('#an-frame');
  const tip = content.querySelector('#an-tip');

  // ---- tooltip (text only) ----
  const { show: showTip, hide: hideTip } = createTooltip(tip);

  root.addEventListener('pointermove', e => {
    const t = e.target.closest('[data-tip]');
    if (t && root.contains(t)) { showTip(t.dataset.tip.split('\n'), e.clientX, e.clientY); return; }
    const hit = e.target.closest('.an-hours .an-hit');
    if (hit && analysis) {
      const h = Number(hit.dataset.i);
      const total = analysis.hours.reduce((s, v) => s + v, 0);
      showTip([`${hourLabel(h)} – ${hourLabel((h + 1) % 24)} IST`, [C.blue, 'Page views', fmtInt(analysis.hours[h])], total ? `${fmtPct(analysis.hours[h] / total, 0)} of the period` : ''].filter(Boolean), e.clientX, e.clientY);
      return;
    }
    if (!e.target.closest('.an-overlay')) hideTip();
  });
  root.addEventListener('pointerleave', hideTip);

  root.querySelector('.an-range').addEventListener('click', e => {
    const b = e.target.closest('button[data-range]');
    if (!b || b.dataset.range === rangeId) return;
    rangeId = b.dataset.range;
    saveRange(rangeId);
    root.querySelectorAll('.an-range button').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.range === rangeId)));
    load();
  });

  function bindTraffic() {
    const wrap = frame.querySelector('#an-traffic-plot');
    if (!wrap || !analysis) return;
    const svg = wrap.querySelector('svg');
    const overlay = svg?.querySelector('.an-overlay');
    if (!overlay) return;
    const cross = svg.querySelector('.an-cross');
    const n = analysis.buckets.length;
    const move = e => {
      const box = overlay.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
      const i = n > 1 ? Math.round(f * (n - 1)) : 0;
      const x0 = Number(overlay.getAttribute('x')), w = Number(overlay.getAttribute('width'));
      const y0 = Number(overlay.getAttribute('y')), h = Number(overlay.getAttribute('height'));
      const max = niceMax(Math.max(...analysis.views, ...analysis.visitors));
      const cx = x0 + (n > 1 ? (i / (n - 1)) * w : w / 2);
      const yv = v => y0 + h - (v / max) * h;
      cross.style.display = '';
      cross.querySelector('.an-cross-line').setAttribute('x1', cx);
      cross.querySelector('.an-cross-line').setAttribute('x2', cx);
      const a = cross.querySelector('.an-cross-a'), b = cross.querySelector('.an-cross-b');
      a.setAttribute('cx', cx); a.setAttribute('cy', yv(analysis.views[i]));
      b.setAttribute('cx', cx); b.setAttribute('cy', yv(analysis.visitors[i]));
      showTip([analysis.buckets[i].long, [C.blue, 'Page views', fmtInt(analysis.views[i])], [C.orange, 'Visitors', fmtInt(analysis.visitors[i])]], e.clientX, e.clientY);
    };
    overlay.addEventListener('pointermove', move);
    overlay.addEventListener('pointerdown', move);
    overlay.addEventListener('pointerleave', () => { cross.style.display = 'none'; hideTip(); });
  }

  function drawCharts() {
    if (!analysis) return;
    const plot = frame.querySelector('#an-traffic-plot');
    if (plot) {
      plot.innerHTML = showTable ? trafficTableHtml(analysis, analysis.hourly) : trafficChartSvg(analysis, plot.clientWidth);
      if (!showTable) bindTraffic();
    }
    const hours = frame.querySelector('#an-hours-plot');
    if (hours) hours.innerHTML = hoursChartSvg(analysis.hours, hours.clientWidth);
  }

  let lastWidth = 0;
  const ro = new ResizeObserver(() => {
    if (!frame.isConnected) { ro.disconnect(); return; }
    const w = frame.clientWidth;
    if (Math.abs(w - lastWidth) > 4) { lastWidth = w; drawCharts(); }
  });
  ro.observe(frame);

  frame.addEventListener('click', e => {
    const t = e.target.closest('[data-traffic-view]');
    if (!t) return;
    showTable = t.dataset.trafficView === 'table';
    frame.querySelectorAll('[data-traffic-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.trafficView === (showTable ? 'table' : 'chart'))));
    drawCharts();
  });

  async function load() {
    const seq = ++loadSeq;
    const period = periodFor(rangeId);
    const periodEl = root.querySelector('#an-period');
    periodEl.textContent = period.hourly
      ? `Today, ${dayLabel(istDay(period.end), { day: 'numeric', month: 'short', year: 'numeric' })} · India time`
      : `${dayLabel(istDay(period.start), { day: 'numeric', month: 'short' })} – ${dayLabel(istDay(period.end), { day: 'numeric', month: 'short', year: 'numeric' })} · India time`;
    frame.classList.add('is-loading');
    frame.setAttribute('aria-busy', 'true');
    let data;
    try {
      data = await loadData(period);
    } catch (e) {
      if (seq !== loadSeq || !frame.isConnected) return;
      frame.classList.remove('is-loading');
      frame.removeAttribute('aria-busy');
      frame.innerHTML = `<div class="panel"><div class="empty">Could not load analytics: ${escapeHtml(e.message || String(e))}</div></div>`;
      return;
    }
    if (seq !== loadSeq || !frame.isConnected) return;
    analysis = analyse(period, data);
    render(period, data);
    frame.classList.remove('is-loading');
    frame.removeAttribute('aria-busy');
  }

  function render(period, data) {
    const a = analysis;
    const prevLabel = PREV_LABELS[period.range.id];
    const notes = [];
    if (data.visits.error) notes.push(`Visits could not be loaded: ${data.visits.error.message}`);
    if (data.visits.truncated) notes.push(`Showing the first ${fmtInt(MAX_ROWS)} page views of this period.`);
    if (data.enquiryError) notes.push(`Enquiries could not be loaded: ${data.enquiryError.message}`);

    const legend = `<ul class="an-legend"><li><span class="an-swatch" style="background:${C.blue}"></span>Page views <b>${fmtInt(a.totals.views)}</b></li><li><span class="an-swatch" style="background:${C.orange}"></span>Visitors <b>${fmtInt(a.totals.visitors)}</b></li></ul>`;
    const viewToggle = `<div class="an-seg-toggle" role="group" aria-label="Show as"><button type="button" data-traffic-view="chart" aria-pressed="${!showTable}">Chart</button><button type="button" data-traffic-view="table" aria-pressed="${showTable}">Table</button></div>`;

    const topPages = a.topPages.map(p => ({ name: pageLabel(p.path), sub: p.path, path: p.path, count: p.views, visitors: p.visitors }));
    const visitorTotal = a.totals.visitors;

    frame.innerHTML =
      (notes.length ? `<div class="an-note" role="status">${notes.map(escapeHtml).join('<br>')}</div>` : '') +
      kpiTilesHtml(a.kpis, prevLabel) +
      panel('Traffic', period.hourly ? 'Page views and visitors by hour, India time' : 'Page views and visitors per day, India time',
        `${legend}<div id="an-traffic-plot" class="an-plot"></div>`, viewToggle, 'an-traffic-panel') +
      `<div class="an-grid">
        ${panel('Top pages', `${fmtInt(a.topPages.length)} pages viewed`, barListHtml(topPages, { total: a.totals.views, link: true, limit: 10, secondary: i => `${fmtInt(i.visitors)} visitor${i.visitors === 1 ? '' : 's'}` }))}
        ${panel('Traffic sources', 'Where visitors arrived from (first page of their visit)', barListHtml(a.sources, { total: visitorTotal, valueLabel: 'visitors' }))}
      </div>
      <div class="an-grid an-grid-3">
        ${panel('Devices', 'Visitors by device', devicesHtml(a.devices))}
        ${panel('Page types', 'Page views by section', barListHtml(a.kinds, { total: a.totals.views, limit: 8 }))}
        ${panel('Busiest hours', 'Page views by hour of day, India time', '<div id="an-hours-plot" class="an-plot an-hours"></div>')}
      </div>
      <div class="an-stack-panels">${buyersPanelHtml(data.buyers)}${activityPanelHtml(data.activity, period.range.label)}</div>`;
    lastWidth = frame.clientWidth;
    drawCharts();
  }

  load();
}

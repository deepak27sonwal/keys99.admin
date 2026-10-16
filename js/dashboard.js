import { sb } from './supabase-client.js';
import { escapeHtml, pill, timeAgo, count, icon } from './utils.js';
import { PROJECT_KINDS, KIND_KEYS, queryAllKinds, kindPill } from './project-kinds.js';
import { attachProjectThumbs, projectThumbHtml, bindThumbFallbacks } from './project-thumbs.js';
import { bindLiveTile } from './live-visitors.js';
import {
  C, DAY, fmtInt, fmtCompact, fmtPct, istDay, istHour, istMidnight, dayLabel, hourLabel,
  fetchAll, barPath, niceMax, sparkline, deltaHtml, createTooltip
} from './charts.js';

// The Dashboard: what needs action, how keys99.com is doing, and what changed recently.
//
//   1. Header with quick actions (Add Project, Review queue).
//   2. Needs attention: projects waiting for moderation, new enquiries, rentals waiting for
//      approval, draft projects.
//   3. Key numbers: live visitors, visitors today vs yesterday, enquiries this week vs last,
//      published listings, live rentals.
//   4. Enquiries per day for 30 days, and listings by moderation status.
//   5. Recent enquiries and recent projects, then the recent activity feed.
//   6. A slim strip with the catalogue counts (developers, agents, managers, cities, localities).
//
// Trends live on Analytics (js/analytics.js); this page only shows the short view. A query that
// fails shows "–" or an empty list rather than breaking the page.

const IN_REVIEW = ['pending_verification', 'under_review', 'resubmitted'];
const PENDING_MODERATION = [...IN_REVIEW, 'changes_required'];
// Status colours (good / warning / critical / neutral), always shown with their labels.
const STATUS_SEGMENTS = [
  { key: 'published', label: 'Published', color: '#0ca30c', statuses: ['published'] },
  { key: 'review', label: 'In review', color: '#f0ab1c', statuses: IN_REVIEW },
  { key: 'changes', label: 'Changes required', color: '#d03b3b', statuses: ['changes_required'] },
  { key: 'draft', label: 'Draft', color: '#b9c6c4', statuses: ['draft'] }
];
const ENQUIRY_SOURCES = [
  { kind: 'residential', label: 'Residential', table: PROJECT_KINDS.residential.tables.enquiries },
  { kind: 'commercial', label: 'Commercial', table: PROJECT_KINDS.commercial.tables.enquiries },
  { kind: 'rental', label: 'Rental', table: 'rental_property_enquiries' }
];

// "Listings overview": how many residential and commercial projects were live (published,
// not archived) at evenly spaced points across the chosen period. Counted in the browser from
// each published project's published_at, so changing the period needs no new query.
const OVERVIEW_KEY = 'k99-dashboard-period';
const OVERVIEW_POINTS = 12;
const OVERVIEW_PERIODS = ['Today', 'Yesterday', 'Last Week', 'Last 15 Days', 'Last 30 Days', 'Last 3 Months', 'Last 6 Months', 'Last 1 Year', 'Last 3 Years', 'Last 5 Years'];
const KIND_COLORS = { residential: C.blue, commercial: C.orange };

function overviewBuckets(period, now) {
  const todayStart = istMidnight(now);
  const monthsAgo = m => { const d = new Date(now + 19800000); d.setUTCMonth(d.getUTCMonth() - m); return d.getTime() - 19800000; };
  let start = monthsAgo(6), end = now;
  switch (period) {
    case 'Today': start = todayStart; break;
    case 'Yesterday': start = todayStart - DAY; end = todayStart; break;
    case 'Last Week': start = now - 7 * DAY; break;
    case 'Last 15 Days': start = now - 15 * DAY; break;
    case 'Last 30 Days': start = now - 30 * DAY; break;
    case 'Last 3 Months': start = monthsAgo(3); break;
    case 'Last 1 Year': start = monthsAgo(12); break;
    case 'Last 3 Years': start = monthsAgo(36); break;
    case 'Last 5 Years': start = monthsAgo(60); break;
  }
  const span = end - start;
  const opts = { timeZone: 'Asia/Kolkata' };
  const fmt = span <= 2 * DAY
    ? t => new Date(t).toLocaleTimeString('en-IN', { ...opts, hour: 'numeric', minute: '2-digit' })
    : span <= 400 * DAY
      ? t => new Date(t).toLocaleDateString('en-IN', { ...opts, day: 'numeric', month: 'short' })
      : t => new Date(t).toLocaleDateString('en-IN', { ...opts, month: 'short', year: '2-digit' });
  const long = span <= 2 * DAY
    ? t => new Date(t).toLocaleString('en-IN', { ...opts, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
    : t => new Date(t).toLocaleDateString('en-IN', { ...opts, day: 'numeric', month: 'short', year: 'numeric' });
  return Array.from({ length: OVERVIEW_POINTS }, (_, i) => {
    const t = start + (span * (i + 1)) / OVERVIEW_POINTS;
    return { t, label: fmt(t), long: long(t) };
  });
}

function overviewSeries(published, period, now) {
  const buckets = overviewBuckets(period, now);
  const series = KIND_KEYS.map(k => {
    const times = published.filter(p => p.kind === k).map(p => p.t).sort((a, b) => a - b);
    let j = 0;
    const values = buckets.map(b => { while (j < times.length && times[j] <= b.t) j++; return j; });
    return { kind: k, name: PROJECT_KINDS[k].label, color: KIND_COLORS[k] || C.aqua, values };
  });
  return { buckets, series };
}

function overviewChartSvg(o, width) {
  const H = 240, padL = 34, padR = 14, padT = 16, padB = 28;
  const w = Math.max(260, width);
  const n = o.buckets.length;
  const plotW = w - padL - padR, plotH = H - padT - padB;
  const max = countMax(Math.max(...o.series.flatMap(s => s.values)));
  const x = i => padL + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
  const y = v => padT + plotH - (v / max) * plotH;
  const line = vals => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const grid = [0, 0.25, 0.5, 0.75, 1].map(f => max * f)
    .map(t => `<line x1="${padL}" x2="${w - padR}" y1="${y(t)}" y2="${y(t)}" class="an-gl${t === 0 ? ' an-base' : ''}"/><text x="${padL - 8}" y="${y(t) + 3.5}" class="an-axis" text-anchor="end">${fmtCompact(t)}</text>`).join('');
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 72))));
  const xl = o.buckets.map((b, i) => (i === n - 1 || (i % every === 0 && n - 1 - i >= every))
    ? `<text x="${x(i)}" y="${H - 8}" class="an-axis" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${escapeHtml(b.label)}</text>` : '').join('');
  const first = o.series[0];
  const area = `${line(first.values)}L${x(n - 1)},${y(0)}L${x(0)},${y(0)}Z`;
  const ends = o.series.map(s => `<circle cx="${x(n - 1)}" cy="${y(s.values[n - 1])}" r="4" fill="${s.color}" stroke="#fff" stroke-width="2"/>`).join('');
  return `<svg class="an-svg" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}" role="img" aria-label="Live residential and commercial listings over time">
    ${grid}
    <path d="${area}" fill="${first.color}" fill-opacity=".1"/>
    ${o.series.map(s => `<path d="${line(s.values)}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round"/>`).join('')}
    ${ends}${xl}
    <g class="an-cross" style="display:none"><line class="an-cross-line" y1="${padT}" y2="${padT + plotH}"/>${o.series.map((s, i) => `<circle class="an-cross-${i}" r="4" fill="${s.color}" stroke="#fff" stroke-width="2"/>`).join('')}</g>
    <rect class="an-overlay" x="${padL}" y="${padT}" width="${plotW}" height="${plotH}" fill="transparent" data-max="${max}"/>
  </svg>`;
}

function overviewTableHtml(o) {
  return `<div class="table-wrap an-table"><table><thead><tr><th>As of</th>${o.series.map(s => `<th class="num">${escapeHtml(s.name)}</th>`).join('')}<th class="num">Total</th></tr></thead><tbody>${
    o.buckets.map((b, i) => `<tr><td>${escapeHtml(b.long)}</td>${o.series.map(s => `<td class="num">${fmtInt(s.values[i])}</td>`).join('')}<td class="num">${fmtInt(o.series.reduce((t, s) => t + s.values[i], 0))}</td></tr>`).join('')
  }</tbody></table></div>`;
}

function readPeriod() {
  try { const v = localStorage.getItem(OVERVIEW_KEY); if (OVERVIEW_PERIODS.includes(v)) return v; } catch (_) {}
  return 'Last 6 Months';
}

// Axis top for whole-number counts: small counts round up to a multiple of 4 so the quarter and
// half gridlines land on whole numbers.
const countMax = v => (v <= 20 ? Math.max(4, Math.ceil(v / 4) * 4) : niceMax(v));

function greeting(now) {
  const h = istHour(now);
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

// ---------- data ----------

async function loadDashboard() {
  const now = Date.now();
  const todayStart = istMidnight(now);
  const yesterdayStart = todayStart - DAY;
  const enquiryStart = todayStart - 29 * DAY;
  const monthStart = (() => { const d = new Date(now + 19800000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 19800000; })();
  const sumKinds = (tableKey, modifier) => Promise.all(KIND_KEYS.map(k => count(PROJECT_KINDS[k].tables[tableKey], modifier))).then(ns => ns.reduce((a, b) => a + b, 0));
  const live = q => q.is('deleted_at', null);
  const settle = p => p.then(v => v, e => { console.error(e); return null; });

  const [
    statusCounts, residentialDrafts, publishedThisMonth, newEnquiries, rentalsPending, rentalsLive,
    visits, enquiryRows, recentProjects, recentEnquiries, recentRentalEnquiries, recentHistory,
    developers, agents, agentsVerified, managers, cities, localities, publishedTimes
  ] = await Promise.all([
    Promise.all(STATUS_SEGMENTS.map(s => Promise.all(KIND_KEYS.map(k => count(PROJECT_KINDS[k].tables.project, q => live(q).in('moderation_status', s.statuses)))))),
    count(PROJECT_KINDS.residential.tables.project, q => live(q).eq('moderation_status', 'draft')),
    sumKinds('project', q => live(q).eq('moderation_status', 'published').gte('published_at', new Date(monthStart).toISOString())),
    Promise.all([
      sumKinds('enquiries', q => q.eq('status', 'new')),
      count('rental_property_enquiries', q => q.eq('status', 'new'))
    ]).then(([a, b]) => a + b),
    count('rental_properties', q => q.eq('status', 'pending')),
    count('rental_properties', q => q.eq('status', 'approved')),
    settle(fetchAll('site_visits', 'created_at,session_id,visitor_id', q => q.gte('created_at', new Date(yesterdayStart).toISOString()))),
    settle(Promise.all(ENQUIRY_SOURCES.map(s => fetchAll(s.table, 'created_at', q => q.gte('created_at', new Date(enquiryStart - 7 * DAY).toISOString()))
      .then(r => ({ ...r, rows: r.rows.map(x => ({ t: new Date(x.created_at).getTime(), kind: s.kind })) }))))),
    settle(queryAllKinds(K => sb.from(K.tables.project).select('id,project_code,project_name,moderation_status,updated_at,cities(name)').is('deleted_at', null).order('updated_at', { ascending: false }).limit(5))),
    settle(queryAllKinds(K => sb.from(K.tables.enquiries).select(`id,contact_person,status,enquiry_type,created_at,project:${K.tables.project}(project_name)`).order('created_at', { ascending: false }).limit(5))),
    settle(sb.from('rental_property_enquiries').select('id,name,status,created_at,listing:rental_properties(listing_title)').order('created_at', { ascending: false }).limit(5)),
    settle(queryAllKinds(K => sb.from(K.tables.history).select(`id,to_status,action,changed_at,project:${K.tables.project}(project_name)`).order('changed_at', { ascending: false }).limit(8))),
    count('developers'), count('agents'), count('agents', q => q.eq('verified', true)),
    count('relationship_managers'), count('cities'), count('localities'),
    settle(Promise.all(KIND_KEYS.map(k => sb.from(PROJECT_KINDS[k].tables.project).select('published_at').is('deleted_at', null).eq('moderation_status', 'published').not('published_at', 'is', null).limit(5000)
      .then(r => { if (r.error) throw r.error; return (r.data || []).map(p => ({ kind: k, t: new Date(p.published_at).getTime() })); }))).then(a => a.flat()))
  ]);

  // Listings by status, per kind.
  const status = STATUS_SEGMENTS.map((s, i) => ({ ...s, byKind: statusCounts[i], value: statusCounts[i].reduce((a, b) => a + b, 0) }));
  const published = status[0].value;
  const kindTotals = KIND_KEYS.map((k, i) => ({ kind: k, value: status.reduce((sum, s) => sum + s.byKind[i], 0) }));

  // Visitors today vs yesterday up to the same time, hourly sparkline for today.
  let visitors = null;
  if (visits && !visits.error) {
    const who = r => r.visitor_id || r.session_id || 'anon';
    const today = new Set(), yesterday = new Set();
    const hourly = Array.from({ length: istHour(now) + 1 }, () => new Set());
    visits.rows.forEach(r => {
      const t = new Date(r.created_at).getTime();
      if (t >= todayStart) { today.add(who(r)); const h = Math.floor((t - todayStart) / 3600000); if (hourly[h]) hourly[h].add(who(r)); }
      else if (t >= yesterdayStart && t <= now - DAY) yesterday.add(who(r));
    });
    visitors = { value: today.size, prev: yesterday.size, spark: hourly.map(s => s.size), views: visits.rows.filter(r => new Date(r.created_at).getTime() >= todayStart).length };
  }

  // Enquiries: 30 daily buckets (with the per-type split) and this week vs the previous one.
  let enquiries = null;
  if (enquiryRows && !enquiryRows.some(r => r.error)) {
    const rows = enquiryRows.flatMap(r => r.rows);
    const firstDay = istDay(enquiryStart);
    const days = Array.from({ length: 30 }, (_, i) => ({ day: firstDay + i, total: 0, residential: 0, commercial: 0, rental: 0 }));
    rows.forEach(r => { const d = days[istDay(r.t) - firstDay]; if (d) { d.total++; d[r.kind]++; } });
    const weekStart = todayStart - 6 * DAY;
    const week = rows.filter(r => r.t >= weekStart).length;
    const prevWeek = rows.filter(r => r.t >= weekStart - 7 * DAY && r.t < weekStart).length;
    enquiries = { days, week, prevWeek, total30: days.reduce((s, d) => s + d.total, 0) };
  }

  // Recent enquiries across all three kinds, newest first.
  const recentEnq = [
    ...((recentEnquiries?.data) || []).map(e => ({ name: e.contact_person, subject: e.project?.project_name, kind: e._kind, type: e.enquiry_type, status: e.status, at: e.created_at })),
    ...((recentRentalEnquiries?.data) || []).map(e => ({ name: e.name, subject: e.listing?.listing_title, kind: 'rental', type: null, status: e.status, at: e.created_at }))
  ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 5);

  const projects = ((recentProjects?.data) || []).sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).slice(0, 5);
  await attachProjectThumbs(projects).catch(() => {});

  return {
    now, status, published, kindTotals, residentialDrafts, publishedThisMonth, newEnquiries, rentalsPending, rentalsLive,
    pendingModeration: status[1].value + status[2].value,
    drafts: status[3].value,
    visitors, enquiries, recentEnq, projects, publishedTimes,
    history: ((recentHistory?.data) || []),
    catalogue: { developers, agents, agentsVerified, managers, cities, localities },
    errors: { recentProjects: recentProjects?.error, recentEnquiries: recentEnquiries?.error }
  };
}

// ---------- rendering ----------

function attentionCard({ label, value, hint, iconName, nav, filter, tone }) {
  const clear = !value;
  return `<button type="button" class="db-attn${clear ? ' is-clear' : ` tone-${tone}`}" data-nav="${nav}"${filter ? ` data-filter="${filter}"` : ''}>
    <span class="db-attn-icon">${icon(iconName, 17)}</span>
    <span class="db-attn-text"><span class="db-attn-label">${escapeHtml(label)}</span>
      <span class="db-attn-value">${clear ? '<span class="db-clear">✓ All clear</span>' : `<b>${fmtInt(value)}</b> ${escapeHtml(hint)}`}</span></span>
    <span class="db-attn-go" aria-hidden="true">→</span>
  </button>`;
}

function kpiTile({ id, label, value, delta, spark, nav, help }) {
  return `<div class="an-kpi db-kpi${nav ? ' db-link' : ''}"${nav ? ` data-nav="${nav}" role="link" tabindex="0"` : ''}${id ? ` id="${id}"` : ''}>
    <div class="an-kpi-label"${help ? ` title="${escapeHtml(help)}"` : ''}>${escapeHtml(label)}</div>
    <div class="an-kpi-value value">${value}</div>
    ${delta}
    ${spark || '<div class="db-spark-pad"></div>'}
  </div>`;
}

const note = (text, cls = 'flat') => `<div class="an-delta ${cls} trend"><span>${text}</span></div>`;

function enquiriesChartSvg(days, width) {
  const H = 200, padL = 30, padR = 6, padT = 14, padB = 24;
  const w = Math.max(260, width);
  const plotW = w - padL - padR, plotH = H - padT - padB;
  const max = countMax(Math.max(...days.map(d => d.total)));
  const slot = plotW / days.length;
  const bw = Math.min(24, Math.max(3, slot - 2));
  const grid = [0, 0.5, 1].map(f => { const y = padT + plotH - f * plotH; return `<line x1="${padL}" x2="${w - padR}" y1="${y}" y2="${y}" class="an-gl${f === 0 ? ' an-base' : ''}"/><text x="${padL - 6}" y="${y + 3.5}" class="an-axis" text-anchor="end">${fmtCompact(max * f)}</text>`; }).join('');
  const bars = days.map((d, i) => {
    const bh = (d.total / max) * plotH;
    const x = padL + i * slot + (slot - bw) / 2;
    return `<g class="an-hit" data-i="${i}"><rect x="${padL + i * slot}" y="${padT}" width="${slot}" height="${plotH}" fill="transparent"/><path d="${barPath(x, padT + plotH - bh, bw, bh)}" fill="${C.blue}"/></g>`;
  }).join('');
  const every = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor(plotW / 64))));
  const last = days.length - 1;
  const labels = days.map((d, i) => i === last || (i % every === 0 && last - i >= every)
    ? `<text x="${padL + i * slot + slot / 2}" y="${H - 7}" class="an-axis" text-anchor="${i === last ? 'end' : i === 0 ? 'start' : 'middle'}">${escapeHtml(i === last ? 'Today' : dayLabel(d.day))}</text>` : '').join('');
  return `<svg class="an-svg" width="${w}" height="${H}" viewBox="0 0 ${w} ${H}" role="img" aria-label="Enquiries per day for the last 30 days">${grid}${bars}${labels}</svg>`;
}

function statusPanelHtml(d) {
  const total = d.status.reduce((s, x) => s + x.value, 0);
  if (!total) return '<div class="empty">No projects yet.</div>';
  const segs = d.status.filter(s => s.value).map(s =>
    `<div class="an-seg" style="flex:${s.value};background:${s.color}" data-tip="${escapeHtml(`${s.label}\n${fmtInt(s.value)} project${s.value === 1 ? '' : 's'} · ${fmtPct(s.value / total, 0)}`)}"></div>`).join('');
  const legend = d.status.map(s => `<li class="${s.value ? '' : 'is-zero'}"><span class="an-swatch" style="background:${s.color}"></span><span class="an-leg-name">${escapeHtml(s.label)}</span><b>${fmtInt(s.value)}</b><span class="an-leg-count">${fmtPct(s.value / total, 0)}</span></li>`).join('');
  const kinds = d.kindTotals.map(k => `<span>${escapeHtml(PROJECT_KINDS[k.kind].label)} <b>${fmtInt(k.value)}</b></span>`).join('');
  return `<div class="db-status-total"><b>${fmtInt(total)}</b> projects</div>
    <div class="an-stack" role="img" aria-label="${escapeHtml(d.status.map(s => `${s.label} ${s.value}`).join(', '))}">${segs}</div>
    <ul class="an-legend an-legend-col">${legend}</ul>
    <div class="db-kind-split">${kinds}</div>`;
}

function recentEnquiriesHtml(list, error) {
  if (!list.length) return `<div class="empty">${escapeHtml(error ? error.message : 'No enquiries yet.')}</div>`;
  return `<ul class="db-list">${list.map(e => `
    <li class="db-row" data-nav="enquiries">
      <span class="db-avatar" aria-hidden="true">${escapeHtml(String(e.name || '?').trim().charAt(0).toUpperCase() || '?')}</span>
      <span class="db-row-main"><span class="db-row-title">${escapeHtml(e.name || 'Someone')}</span>
        <span class="db-row-sub">${escapeHtml(e.subject || (e.kind === 'rental' ? 'A rental listing' : 'A project'))}${e.type ? ` · ${escapeHtml(String(e.type).replace(/_/g, ' '))}` : ''}</span></span>
      <span class="db-row-meta">${e.kind === 'rental' ? '<span class="pill kind-rental">Rental</span>' : kindPill(e.kind)}<span class="db-time">${escapeHtml(timeAgo(e.at))}</span></span>
      <span class="db-row-status">${pill(e.status)}</span>
    </li>`).join('')}</ul>`;
}

function recentProjectsHtml(list, error) {
  if (!list.length) return `<div class="empty">${escapeHtml(error ? error.message : 'No projects yet.')}</div>`;
  return `<ul class="db-list">${list.map(p => `
    <li class="db-row" data-edit-project="${escapeHtml(p.id)}" data-kind="${escapeHtml(p._kind)}" role="button" tabindex="0" title="Open ${escapeHtml(p.project_name || 'project')}">
      <span class="proj-thumb db-thumb">${projectThumbHtml(p._thumb, p._kind === 'commercial' ? 'building' : 'home')}</span>
      <span class="db-row-main"><span class="db-row-title">${escapeHtml(p.project_name || 'Untitled')}</span>
        <span class="db-row-sub">${escapeHtml(p.project_code || '')}${p.cities?.name ? ` · ${escapeHtml(p.cities.name)}` : ''}</span></span>
      <span class="db-row-meta">${kindPill(p._kind)}<span class="db-time">${escapeHtml(timeAgo(p.updated_at))}</span></span>
      <span class="db-row-status">${pill(p.moderation_status)}</span>
    </li>`).join('')}</ul>`;
}

function activityHtml(history, enquiries) {
  const items = [];
  history.forEach(h => items.push({
    time: h.changed_at,
    text: `<b>${escapeHtml(h.project?.project_name || 'A project')}</b> moved to ${escapeHtml((h.to_status || '').replace(/_/g, ' '))}`,
    color: h.to_status === 'changes_required' ? '#d03b3b' : h.to_status === 'published' ? '#0ca30c' : C.orange,
    label: h.to_status === 'changes_required' ? 'Changes required' : h.to_status === 'published' ? 'Published' : 'Moderation'
  }));
  enquiries.forEach(e => items.push({
    time: e.at,
    text: `<b>${escapeHtml(e.name || 'Someone')}</b> sent an enquiry for <b>${escapeHtml(e.subject || 'a listing')}</b>`,
    color: C.blue, label: 'Enquiry'
  }));
  items.sort((a, b) => new Date(b.time) - new Date(a.time));
  const top = items.slice(0, 8);
  if (!top.length) return '<div class="empty">No activity yet.</div>';
  return `<ol class="db-timeline">${top.map(i => `<li><span class="db-tl-dot" style="background:${i.color}" aria-hidden="true"></span>
    <div class="db-tl-text">${i.text}</div><div class="db-tl-meta">${escapeHtml(i.label)} · ${escapeHtml(timeAgo(i.time))}</div></li>`).join('')}</ol>`;
}

function catalogueHtml(c) {
  const items = [
    ['developers', 'developer', 'Developers', c.developers, ''],
    ['agents', 'agent', 'Agents', c.agents, `${fmtInt(c.agentsVerified)} verified`],
    ['relationship-managers', 'agent', 'Relationship managers', c.managers, ''],
    ['cities', 'pin', 'Cities', c.cities, ''],
    ['cities', 'layers', 'Localities', c.localities, '']
  ];
  return `<section class="db-catalogue" aria-label="Catalogue">${items.map(([nav, ic, label, value, sub]) =>
    `<button type="button" class="db-cat" data-nav="${nav}"><span class="db-cat-icon">${icon(ic, 15)}</span><span><b>${fmtInt(value)}</b> ${escapeHtml(label)}${sub ? `<small>${escapeHtml(sub)}</small>` : ''}</span></button>`).join('')}</section>`;
}

function panel(title, sub, body, action = '', cls = '') {
  return `<section class="panel an-panel ${cls}">
    <div class="panel-head"><div><h2>${escapeHtml(title)}</h2>${sub ? `<div class="an-sub">${escapeHtml(sub)}</div>` : ''}</div>${action}</div>
    <div class="an-body">${body}</div>
  </section>`;
}
const viewAll = (nav, label = 'View all') => `<button type="button" class="panel-link" data-nav="${nav}">${escapeHtml(label)} →</button>`;

// ---------- page ----------

export async function dashboardPage(content, { navigate, currentUser, onAddProject, onEditProject }) {
  content.innerHTML = '<div class="empty">Loading dashboard…</div>';
  const d = await loadDashboard();
  if (!content.isConnected) return;

  const now = new Date(d.now);
  const name = (currentUser?.user_metadata?.full_name || (currentUser?.email || 'Admin').split('@')[0]).split(/\s+/)[0];
  const draftNav = d.residentialDrafts || !d.drafts ? 'residential' : 'commercial';
  let period = readPeriod();
  let ovTable = false;

  const v = d.visitors;
  const e = d.enquiries;
  const kpis = [
    `<div class="an-kpi db-kpi db-link kpi-live" id="kpi-live" data-nav="analytics" role="link" tabindex="0">
      <div class="an-kpi-label"><span class="live-dot" aria-hidden="true"></span> Live visitors</div>
      <div class="an-kpi-value value">–</div>
      <div class="an-delta flat trend"><span>Connecting…</span></div>
      <div class="db-spark-pad"></div>
    </div>`,
    kpiTile({
      label: 'Visitors today', nav: 'analytics', help: 'Unique browsers since midnight, India time',
      value: v ? fmtCompact(v.value) : '–',
      delta: v ? deltaHtml({ value: v.value, prev: v.prev, fmt: fmtInt }, 'yesterday') : note('Not available'),
      spark: v && v.spark.length > 1 ? sparkline(v.spark) : ''
    }),
    kpiTile({
      label: 'Enquiries this week', nav: 'enquiries', help: 'Residential, commercial and rental enquiries in the last 7 days',
      value: e ? fmtCompact(e.week) : '–',
      delta: e ? deltaHtml({ value: e.week, prev: e.prevWeek, fmt: fmtInt }, 'last week') : note('Not available'),
      spark: e ? sparkline(e.days.slice(-14).map(x => x.total)) : ''
    }),
    kpiTile({
      label: 'Published listings', nav: 'residential', help: 'Residential and commercial projects live on keys99.com',
      value: fmtCompact(d.published),
      delta: d.publishedThisMonth ? note(`<b>+${fmtInt(d.publishedThisMonth)}</b> this month`, 'up') : note('None new this month')
    }),
    kpiTile({
      label: 'Live rentals', nav: 'rentals', help: 'Approved rental listings',
      value: fmtCompact(d.rentalsLive),
      delta: d.rentalsPending ? note(`<b>${fmtInt(d.rentalsPending)}</b> awaiting approval`, 'warn') : note('None awaiting approval')
    })
  ].join('');

  const attention = [
    attentionCard({ label: 'Moderation queue', value: d.pendingModeration, hint: 'to review', iconName: 'clock', nav: 'moderation', tone: 'warn' }),
    attentionCard({ label: 'New enquiries', value: d.newEnquiries, hint: 'to contact', iconName: 'mail', nav: 'enquiries', tone: 'info' }),
    attentionCard({ label: 'Rental approvals', value: d.rentalsPending, hint: 'waiting', iconName: 'home', nav: 'rentals', tone: 'warn' }),
    attentionCard({ label: 'Draft projects', value: d.drafts, hint: 'to finish', iconName: 'edit', nav: draftNav, filter: 'draft', tone: 'muted' })
  ].join('');

  content.innerHTML = `
    <div class="db-head">
      <div>
        <h1>${escapeHtml(greeting(d.now))}, ${escapeHtml(name)}</h1>
        <p>${escapeHtml(now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }))} · Here's what's happening on keys99.com</p>
      </div>
      <div class="db-actions">
        <button type="button" class="btn-outline" data-nav="moderation">${icon('clock', 15)} Review queue${d.pendingModeration ? ` <span class="db-count">${fmtInt(d.pendingModeration)}</span>` : ''}</button>
        <button type="button" class="btn-primary" id="db-add-project">${icon('plus', 15)} Add Project</button>
      </div>
    </div>

    <h2 class="db-section-title">Needs attention</h2>
    <div class="db-attention">${attention}</div>

    <h2 class="db-section-title">Key numbers</h2>
    <div class="an-kpis db-kpis">${kpis}</div>

    <div class="db-main">
      ${panel('Listings overview', 'Live projects over time, by type', d.publishedTimes
        ? `<ul class="an-legend" id="db-ov-legend"></ul><div id="db-ov-plot" class="an-plot"></div>`
        : '<div class="empty">Listings could not be loaded.</div>',
        `<div class="db-ov-controls"><label class="db-period"><span class="sr-only">Period</span><select id="db-period">${OVERVIEW_PERIODS.map(p => `<option${p === period ? ' selected' : ''}>${p}</option>`).join('')}</select></label>
          <div class="an-seg-toggle" role="group" aria-label="Show as"><button type="button" data-ov-view="chart" aria-pressed="true">Chart</button><button type="button" data-ov-view="table" aria-pressed="false">Table</button></div></div>`)}
      ${panel('Listings by status', 'Residential and commercial projects', statusPanelHtml(d), viewAll('moderation', 'Moderation'))}
    </div>

    ${panel('Enquiries', e ? `${fmtInt(e.total30)} in the last 30 days · India time` : 'Last 30 days', e ? '<div id="db-enq-plot" class="an-plot db-enq"></div>' : '<div class="empty">Enquiries could not be loaded.</div>', viewAll('enquiries'), 'db-enq-panel')}

    <div class="db-recent">
      ${panel('Recent enquiries', 'Newest first, all listing types', recentEnquiriesHtml(d.recentEnq, d.errors.recentEnquiries), viewAll('enquiries'))}
      ${panel('Recently updated projects', 'Click a project to open it', recentProjectsHtml(d.projects, d.errors.recentProjects), viewAll('residential'))}
    </div>

    ${panel('Recent activity', 'Moderation changes and enquiries', activityHtml(d.history, d.recentEnq), '', 'db-activity')}

    ${catalogueHtml(d.catalogue)}
    <div class="an-tip" id="db-tip" role="tooltip" hidden></div>`;

  bindThumbFallbacks(content);
  bindLiveTile(content.querySelector('#kpi-live'));

  const go = el => navigate(el.dataset.nav, { filter: el.dataset.filter });
  content.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', () => go(el));
    if (el.getAttribute('role') === 'link') el.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(el); } });
  });
  content.querySelector('#db-add-project').addEventListener('click', () => onAddProject());
  content.querySelectorAll('[data-edit-project]').forEach(el => {
    const open = () => onEditProject(el.dataset.editProject, el.dataset.kind);
    el.addEventListener('click', open);
    el.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } });
  });

  // Tooltips: enquiry bars and the status bar.
  const tip = createTooltip(content.querySelector('#db-tip'));
  content.addEventListener('pointermove', ev => {
    const seg = ev.target.closest('[data-tip]');
    if (seg) { tip.show(seg.dataset.tip.split('\n'), ev.clientX, ev.clientY); return; }
    const hit = ev.target.closest('.db-enq .an-hit');
    if (hit && e) {
      const day = e.days[Number(hit.dataset.i)];
      tip.show([
        dayLabel(day.day, { weekday: 'short', day: 'numeric', month: 'short' }),
        [C.blue, 'Enquiries', fmtInt(day.total)],
        ...ENQUIRY_SOURCES.filter(s => day[s.kind]).map(s => `${s.label}: ${fmtInt(day[s.kind])}`)
      ], ev.clientX, ev.clientY);
      return;
    }
    if (!ev.target.closest('.an-overlay')) tip.hide();
  });
  content.addEventListener('pointerleave', () => tip.hide());

  // The enquiry chart is drawn at the panel's real width and redrawn when it changes.
  const plot = content.querySelector('#db-enq-plot');
  if (plot && e) {
    let lastWidth = 0;
    const draw = () => { if (Math.abs(plot.clientWidth - lastWidth) > 4) { lastWidth = plot.clientWidth; plot.innerHTML = enquiriesChartSvg(e.days, plot.clientWidth); } };
    draw();
    const ro = new ResizeObserver(() => { if (!plot.isConnected) { ro.disconnect(); return; } draw(); });
    ro.observe(plot);
  }

  // Listings overview: period picker, chart / table, crosshair read-out.
  const ovPlot = content.querySelector('#db-ov-plot');
  if (ovPlot && d.publishedTimes) {
    let ov = null, ovWidth = 0;
    const drawOverview = (force) => {
      if (!force && Math.abs(ovPlot.clientWidth - ovWidth) <= 4) return;
      ovWidth = ovPlot.clientWidth;
      ov = overviewSeries(d.publishedTimes, period, d.now);
      const last = ov.buckets.length - 1;
      content.querySelector('#db-ov-legend').innerHTML = ov.series.map(s => `<li><span class="an-swatch" style="background:${s.color}"></span>${escapeHtml(s.name)} <b>${fmtInt(s.values[last])}</b></li>`).join('');
      ovPlot.innerHTML = ovTable ? overviewTableHtml(ov) : overviewChartSvg(ov, ovPlot.clientWidth);
    };
    drawOverview(true);
    new ResizeObserver((_, obs) => { if (!ovPlot.isConnected) { obs.disconnect(); return; } drawOverview(false); }).observe(ovPlot);
    content.querySelector('#db-period').addEventListener('change', ev => {
      period = ev.target.value;
      try { localStorage.setItem(OVERVIEW_KEY, period); } catch (_) {}
      drawOverview(true);
    });
    content.querySelectorAll('[data-ov-view]').forEach(b => b.addEventListener('click', () => {
      ovTable = b.dataset.ovView === 'table';
      content.querySelectorAll('[data-ov-view]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      drawOverview(true);
    }));
    ovPlot.addEventListener('pointermove', ev => {
      const overlay = ev.target.closest('.an-overlay');
      if (!overlay || !ov) return;
      const n = ov.buckets.length;
      const box = overlay.getBoundingClientRect();
      const i = n > 1 ? Math.round(Math.min(1, Math.max(0, (ev.clientX - box.left) / box.width)) * (n - 1)) : 0;
      const x0 = +overlay.getAttribute('x'), w = +overlay.getAttribute('width'), y0 = +overlay.getAttribute('y'), h = +overlay.getAttribute('height'), max = +overlay.dataset.max;
      const cx = x0 + (n > 1 ? (i / (n - 1)) * w : w / 2);
      const cross = ovPlot.querySelector('.an-cross');
      cross.style.display = '';
      cross.querySelector('.an-cross-line').setAttribute('x1', cx);
      cross.querySelector('.an-cross-line').setAttribute('x2', cx);
      ov.series.forEach((s, k) => { const c = cross.querySelector(`.an-cross-${k}`); c.setAttribute('cx', cx); c.setAttribute('cy', y0 + h - (s.values[i] / max) * h); });
      tip.show([ov.buckets[i].long, ...ov.series.map(s => [s.color, s.name, fmtInt(s.values[i])])], ev.clientX, ev.clientY);
    });
    ovPlot.addEventListener('pointerleave', () => { const c = ovPlot.querySelector('.an-cross'); if (c) c.style.display = 'none'; tip.hide(); });
  }
}

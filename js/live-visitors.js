import { sb } from './supabase-client.js';
import { escapeHtml } from './utils.js';

// "Live now": who is on keys99.com at this moment and what they are viewing.
//
// Every open keys99.com tab joins the Supabase Realtime channel "keys99-live" and announces
// itself with presence (keys99.com js/track.js): { sid, path, title, kind, device, signedIn,
// since }. The entry disappears when the tab closes, the connection drops, or the tab has been
// in the background for 5 minutes. Nothing is stored in the database. The admin only listens
// here - it never announces itself.

const CHANNEL = 'keys99-live';
const SITE = 'https://keys99.com';
const KIND_LABELS = { home: 'Home', project: 'Project', commercial: 'Commercial', rental: 'Rental', search: 'Search', blog: 'Blog', other: 'Page' };

let channel = null;
let tabs = [];                 // one entry per open keys99.com tab
let connected = false;
const listeners = new Set();

function readState() {
  const state = channel.presenceState();
  tabs = Object.values(state).flat()
    // Only same-site paths ("/…", not "//host" or "@host"), so every link stays on keys99.com
    // even if someone sends made-up presence data to this public channel.
    .filter(t => t && typeof t.path === 'string' && /^\/(?![\/\\])/.test(t.path))
    .map(t => ({
      sid: String(t.sid || ''),
      path: t.path,
      title: String(t.title || ''),
      kind: KIND_LABELS[t.kind] ? t.kind : 'other',
      device: ['mobile', 'tablet', 'desktop'].includes(t.device) ? t.device : 'desktop',
      signedIn: !!t.signedIn,
      since: Number(t.since) || Date.now()
    }));
  emit();
}

function emit() {
  const summary = liveSummary();
  listeners.forEach(cb => { try { cb(summary); } catch (e) { console.error(e); } });
}

function ensureChannel() {
  if (channel) return;
  channel = sb.channel(CHANNEL);
  channel
    .on('presence', { event: 'sync' }, readState)
    .subscribe(status => {
      connected = status === 'SUBSCRIBED';
      if (connected) readState(); else emit();
    });
}

// Visitors (one per browser), open pages (tabs), per-page viewers, devices, signed-in.
export function liveSummary() {
  const visitors = new Map();
  tabs.forEach(t => { if (!visitors.has(t.sid)) visitors.set(t.sid, t); });
  const pages = new Map();
  tabs.forEach(t => {
    const p = pages.get(t.path) || { path: t.path, title: t.title, kind: t.kind, viewers: new Set(), since: t.since };
    p.viewers.add(t.sid);
    if (t.since < p.since) p.since = t.since;
    if (!p.title && t.title) p.title = t.title;
    pages.set(t.path, p);
  });
  const devices = { mobile: 0, desktop: 0, tablet: 0 };
  visitors.forEach(v => { devices[v.device] += 1; });
  return {
    connected,
    visitors: visitors.size,
    pagesOpen: tabs.length,
    signedIn: [...visitors.values()].filter(v => v.signedIn).length,
    devices,
    pages: [...pages.values()]
      .map(p => ({ ...p, viewers: p.viewers.size }))
      .sort((a, b) => b.viewers - a.viewers || a.since - b.since)
  };
}

// Calls `cb(summary)` now and on every change. Stops by itself once `el` (the page element
// showing it) has left the page, so navigating away needs no clean-up call.
export function onLive(cb, el) {
  ensureChannel();
  const wrapped = summary => {
    if (el && !el.isConnected) { listeners.delete(wrapped); return; }
    cb(summary);
  };
  listeners.add(wrapped);
  wrapped(liveSummary());
  return () => listeners.delete(wrapped);
}

const sinceText = ms => {
  const mins = Math.floor((Date.now() - ms) / 60000);
  return mins < 1 ? 'just now' : mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
};

// The "Live now" card on the Analytics page.
export function liveCardHtml() {
  return `<section class="panel live-card" id="live-card">
    <div class="live-head">
      <div class="live-count"><span class="live-dot" aria-hidden="true"></span><strong id="live-visitors">–</strong><span id="live-visitors-label">visitors on keys99.com right now</span></div>
      <div class="live-meta" id="live-meta">Connecting…</div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Viewing now</th><th>Type</th><th>Viewers</th><th>Longest on page</th></tr></thead>
      <tbody id="live-pages"><tr><td colspan="4"><div class="empty">Waiting for live data…</div></td></tr></tbody>
    </table></div>
  </section>`;
}

export function bindLiveCard(root) {
  const card = root.querySelector('#live-card');
  if (!card) return;
  const paint = s => {
    card.querySelector('#live-visitors').textContent = s.visitors;
    card.querySelector('#live-visitors-label').textContent = `visitor${s.visitors === 1 ? '' : 's'} on keys99.com right now`;
    card.querySelector('#live-meta').textContent = !s.connected
      ? 'Connecting to live data…'
      : `${s.pagesOpen} page${s.pagesOpen === 1 ? '' : 's'} open · ${s.devices.mobile} mobile · ${s.devices.desktop} desktop${s.devices.tablet ? ` · ${s.devices.tablet} tablet` : ''} · ${s.signedIn} signed in`;
    card.classList.toggle('is-live', s.connected);
    card.querySelector('#live-pages').innerHTML = s.pages.length
      ? s.pages.map(p => `<tr>
          <td><a href="${escapeHtml(SITE + p.path)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.title || p.path)}</a><div class="live-path">${escapeHtml(p.path)}</div></td>
          <td>${escapeHtml(KIND_LABELS[p.kind])}</td>
          <td><strong>${p.viewers}</strong></td>
          <td>${escapeHtml(sinceText(p.since))}</td>
        </tr>`).join('')
      : `<tr><td colspan="4"><div class="empty">${s.connected ? 'Nobody is on keys99.com right now.' : 'Waiting for live data…'}</div></td></tr>`;
  };
  onLive(paint, card);
  // Refresh the "longest on page" times every 30 s even when nothing else changes.
  const timer = setInterval(() => { if (!card.isConnected) { clearInterval(timer); return; } paint(liveSummary()); }, 30000);
}

// Dashboard tile: keeps the number in `el` live.
export function bindLiveTile(el) {
  if (!el) return;
  onLive(s => {
    const value = el.querySelector('.value');
    if (value) value.textContent = s.connected ? s.visitors : '–';
    const trend = el.querySelector('.trend');
    if (trend) trend.innerHTML = s.connected ? `${s.pagesOpen} <span>page${s.pagesOpen === 1 ? '' : 's'} open</span>` : '<span>Connecting…</span>';
  }, el);
}

import { sb } from './supabase-client.js';
import { pageHead, tablePanel, emptyRow, escapeHtml, timeAgo, fmtDate } from './utils.js';
import { callManageAdmins } from './admins.js';
import { liveCardHtml, bindLiveCard } from './live-visitors.js';

// Site Analytics: visitor counts, currently-active buyers, and a recent activity feed, built
// on top of the site_visits / activity_log tables keys99.com writes to (js/track.js there)
// and the manage-admins Edge Function's "buyer_overview" action (the only path that can read
// auth.sessions, same pattern as the admin session tooling in settings.js/admins.js).
// site_visits/activity_log are readable directly through `sb` here because their own RLS
// already grants SELECT to any signed-in admin (private.is_admin()) — no edge function needed
// for those two.

const ACTION_LABELS = {
  page_view: 'Page view',
  search: 'Search',
  save_project: 'Saved a project',
  unsave_project: 'Removed a saved project',
  enquiry_submit: 'Submitted an enquiry',
  login: 'Signed in',
  logout: 'Signed out'
};

function actionLabel(action) {
  return ACTION_LABELS[action] || (action ? action.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()) : '—');
}

export async function analyticsPage(content) {
  content.innerHTML = pageHead('Analytics', 'Visitor traffic, active buyers, and recent activity on keys99.com') + `<div class="empty">Loading…</div>`;

  const now = Date.now();
  const since = (days) => new Date(now - days * 86400000).toISOString();

  const [visits24h, visits7d, visits30d, topPagesRes, recentActivityRes, buyerOverview] = await Promise.all([
    sb.from('site_visits').select('id,session_id', { count: 'exact', head: true }).gte('created_at', since(1)),
    sb.from('site_visits').select('session_id').gte('created_at', since(7)).limit(20000),
    sb.from('site_visits').select('id', { count: 'exact', head: true }).gte('created_at', since(30)),
    sb.from('site_visits').select('page_path').gte('created_at', since(7)).limit(5000),
    sb.from('activity_log').select('id,actor_type,action,entity_type,entity_id,metadata,created_at').order('created_at', { ascending: false }).limit(100),
    callManageAdmins({ action: 'buyer_overview' })
  ]);

  const views24h = visits24h.count || 0;
  const views30d = visits30d.count || 0;
  const rows7d = visits7d.data || [];
  const views7d = rows7d.length;
  const uniqueSessions7d = new Set(rows7d.map(r => r.session_id)).size;

  const pageCounts = new Map();
  (topPagesRes.data || []).forEach(r => pageCounts.set(r.page_path, (pageCounts.get(r.page_path) || 0) + 1));
  const topPages = [...pageCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

  const buyerErr = buyerOverview.error;
  const activeBuyers = buyerErr ? '—' : (buyerOverview.active_buyers ?? 0);
  const totalBuyers = buyerErr ? '—' : (buyerOverview.total_buyers ?? 0);

  const cards = [
    { value: views24h, label: 'Page views (24h)' },
    { value: views7d, label: 'Page views (7d)' },
    { value: uniqueSessions7d, label: 'Unique visitors (7d)' },
    { value: views30d, label: 'Page views (30d)' },
    { value: activeBuyers, label: 'Buyers signed in now' },
    { value: totalBuyers, label: 'Registered buyers' }
  ];
  const cardsHtml = `<div class="kpi-row">${cards.map(c =>
    `<div class="kpi"><div class="value">${escapeHtml(String(c.value))}</div><div class="label">${escapeHtml(c.label)}</div></div>`
  ).join('')}</div>`;

  const topPagesRows = topPages.length
    ? topPages.map(([path, count]) => `<tr><td>${escapeHtml(path)}</td><td>${count}</td></tr>`).join('')
    : emptyRow(2, 'No page views logged yet.');
  const topPagesPanel = tablePanel('Top Pages (7 days)', '', ['Page', 'Views'], topPagesRows);

  const buyersRows = buyerErr
    ? emptyRow(4, buyerErr)
    : (buyerOverview.recent || []).length
      ? buyerOverview.recent.map(b => `
        <tr>
          <td>${escapeHtml(b.full_name || '—')}</td>
          <td>${escapeHtml(b.email || '—')}</td>
          <td>${b.session_count} device${b.session_count === 1 ? '' : 's'}</td>
          <td>${b.last_active ? escapeHtml(timeAgo(b.last_active)) : '—'}</td>
        </tr>`).join('')
      : emptyRow(4, 'No buyers currently signed in.');
  const buyersPanel = tablePanel('Signed-In Buyers', '', ['Name', 'Email', 'Devices', 'Last Active'], buyersRows);

  const activityRows = (recentActivityRes.data || []).length
    ? recentActivityRes.data.map(a => `
      <tr>
        <td><span class="pill ${a.actor_type === 'admin' ? 'admin' : a.actor_type === 'buyer' ? 'active' : 'draft'}">${escapeHtml(a.actor_type)}</span></td>
        <td>${escapeHtml(actionLabel(a.action))}</td>
        <td>${a.entity_type ? escapeHtml(a.entity_type) : (a.metadata?.q ? `“${escapeHtml(a.metadata.q)}”` : '—')}</td>
        <td>${fmtDate(a.created_at)} · ${escapeHtml(timeAgo(a.created_at))}</td>
      </tr>`).join('')
    : emptyRow(4, recentActivityRes.error ? recentActivityRes.error.message : 'No activity logged yet.');
  const activityPanel = tablePanel('Recent Activity', '', ['Actor', 'Action', 'Detail', 'When'], activityRows);

  content.innerHTML = pageHead('Analytics', 'Visitor traffic, active buyers, and recent activity on keys99.com') +
    liveCardHtml() +
    cardsHtml +
    `<div class="analytics-grid">${topPagesPanel}${buyersPanel}</div>` +
    activityPanel;
  bindLiveCard(content);
}

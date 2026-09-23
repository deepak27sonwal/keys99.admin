import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.js';

const { createClient } = window.supabase;
const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const $ = s => document.querySelector(s);
const content = $('#content');

let currentUser = null;
let currentRoles = [];

/* ---------------- helpers ---------------- */

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pill(status) {
  const cls = String(status || '').toLowerCase();
  const label = status ? String(status).replace(/_/g, ' ') : '—';
  return `<span class="pill ${cls}">${escapeHtml(label)}</span>`;
}

function fmtPrice(value, priceOnRequest) {
  if (priceOnRequest) return 'Price on request';
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(n % 1e7 === 0 ? 0 : 2)} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(n % 1e5 === 0 ? 0 : 2)} L`;
  return `₹${n.toLocaleString('en-IN')}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function timeAgo(iso) {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`;
  return fmtDate(iso);
}

async function count(table, modifier) {
  let q = sb.from(table).select('*', { count: 'exact', head: true });
  if (modifier) q = modifier(q);
  const { count: c, error } = await q;
  if (error) { console.error(table, error); return 0; }
  return c ?? 0;
}

function initials(text) {
  const base = (text || 'Admin').includes('@') ? text.split('@')[0] : (text || 'Admin');
  const parts = base.replace(/[._-]+/g, ' ').trim().split(/\s+/);
  const a = parts[0]?.[0] || 'A';
  const b = parts[1]?.[0] || parts[0]?.[1] || '';
  return (a + b).toUpperCase();
}

function pageHead(title, subtitle) {
  return `<div class="page-head"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle || '')}</p></div>`;
}

function tablePanel(title, toolbarHtml, headers, bodyHtml, footerHtml) {
  return `<div class="panel">
    <div class="panel-head"><h2>${escapeHtml(title)}</h2>${toolbarHtml || ''}</div>
    <div class="table-wrap"><table><thead><tr>${headers.map(h => '<th>' + h + '</th>').join('')}</tr></thead>
    <tbody>${bodyHtml}</tbody></table></div>
  </div>${footerHtml || ''}`;
}

function emptyRow(colspan, text) {
  return `<tr><td colspan="${colspan}"><div class="empty">${escapeHtml(text)}</div></td></tr>`;
}

/* ---------------- auth guard ---------------- */

async function guard() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { location.replace('./login.html'); return false; }

  const { data: roles, error } = await sb.from('user_roles').select('role').eq('user_id', session.user.id);
  if (error) { console.error(error); }
  const roleList = (roles || []).map(r => r.role);
  const allowed = roleList.some(r => ['admin', 'editor', 'agent', 'moderator'].includes(r));
  if (!allowed) { await sb.auth.signOut(); location.replace('./login.html'); return false; }

  currentUser = session.user;
  currentRoles = roleList;

  const label = session.user.email || 'Admin';
  $('#user-name').textContent = label;
  $('#user-role').textContent = (roleList.includes('admin') ? 'admin' : (roleList[0] || 'admin')).toUpperCase();
  $('#user-avatar').textContent = initials(label);
  return true;
}

/* ---------------- sidebar counts ---------------- */

async function loadSidebarCounts() {
  const [residential, enquiriesOpen, moderationPending] = await Promise.all([
    count('residential_projects'),
    count('residential_enquiries', q => q.in('status', ['new', 'contacted', 'follow_up'])),
    count('residential_projects', q => q.in('moderation_status', ['pending_verification', 'under_review', 'changes_required', 'resubmitted']))
  ]);
  $('#count-residential').textContent = residential;
  $('#count-enquiries').textContent = enquiriesOpen;
  $('#count-moderation').textContent = moderationPending;
  $('#notif-dot').hidden = moderationPending === 0;
}

/* ---------------- chart helpers ---------------- */

function smoothPath(ys, x0 = 44, dx = 90) {
  const pts = ys.map((y, i) => [x0 + dx * i, y]);
  let d = `M${pts[0][0]},${pts[0][1]} C${pts[0][0] + dx / 2},${pts[0][1]} ${pts[1][0] - dx / 2},${pts[1][1]} ${pts[1][0]},${pts[1][1]}`;
  for (let i = 2; i < pts.length; i++) {
    d += ` S${pts[i][0] - dx / 2},${pts[i][1]} ${pts[i][0]},${pts[i][1]}`;
  }
  return d;
}

function monthLabels(n) {
  const labels = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    labels.push(d.toLocaleDateString('en-IN', { month: 'short' }));
  }
  return labels;
}

function buildOverviewChart(residentialMonthly, commercialMonthly) {
  const maxVal = Math.max(1, ...residentialMonthly, ...commercialMonthly);
  const niceMax = Math.max(10, Math.ceil((maxVal * 1.15) / 5) * 5);
  const y = v => 160 - (v / niceMax) * 140;

  const rYs = residentialMonthly.map(y);
  const cYs = commercialMonthly.map(y);
  const rPath = smoothPath(rYs);
  const cPath = smoothPath(cYs);
  const areaPath = `${rPath} L494,160 L44,160 Z`;
  const months = monthLabels(6);
  const lastR = residentialMonthly[residentialMonthly.length - 1];
  const lastC = commercialMonthly[commercialMonthly.length - 1];

  const dotsR = residentialMonthly.map((v, i) => `<circle cx="${44 + i * 90}" cy="${y(v)}" r="${i === 5 ? 5 : 4}" stroke="#fff" stroke-width="2"/>`).join('');
  const dotsC = commercialMonthly.map((v, i) => `<circle cx="${44 + i * 90}" cy="${y(v)}" r="${i === 5 ? 4 : 3.5}" stroke="#fff" stroke-width="2"/>`).join('');
  const monthText = months.map((m, i) => `<text x="${44 + i * 90}" y="180">${m}</text>`).join('');

  const g0 = niceMax, g1 = niceMax * 0.75, g2 = niceMax * 0.5, g3 = niceMax * 0.25;

  return `<svg viewBox="0 0 500 190" width="100%" height="190">
    <defs>
      <linearGradient id="fillGreen" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#046b5e" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="#046b5e" stop-opacity="0"/>
      </linearGradient>
      <filter id="lineShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#046b5e" flood-opacity="0.35"/>
      </filter>
    </defs>
    <g stroke="#eef3f2" stroke-width="1">
      <line x1="34" y1="20" x2="500" y2="20"/><line x1="34" y1="55" x2="500" y2="55"/>
      <line x1="34" y1="90" x2="500" y2="90"/><line x1="34" y1="125" x2="500" y2="125"/>
      <line x1="34" y1="160" x2="500" y2="160"/>
    </g>
    <g font-size="10" fill="#9fb0af" font-family="Inter" text-anchor="end">
      <text x="28" y="23">${Math.round(g0)}</text><text x="28" y="58">${Math.round(g1)}</text>
      <text x="28" y="93">${Math.round(g2)}</text><text x="28" y="128">${Math.round(g3)}</text><text x="28" y="163">0</text>
    </g>
    <path d="${areaPath}" fill="url(#fillGreen)"/>
    <path d="${rPath}" fill="none" stroke="#046b5e" stroke-width="3" stroke-linecap="round" filter="url(#lineShadow)"/>
    <path d="${cPath}" fill="none" stroke="#f0ab1c" stroke-width="2.5" stroke-linecap="round"/>
    <g fill="#046b5e">${dotsR}</g>
    <g fill="#f0ab1c">${dotsC}</g>
    <g font-size="9.5" font-weight="700" fill="#046b5e"><text x="494" y="${y(lastR) - 8}" text-anchor="end">${lastR}</text></g>
    <g font-size="9.5" font-weight="700" fill="#b7791f"><text x="494" y="${y(lastC) - 8}" text-anchor="end">${lastC}</text></g>
    <g font-size="10.5" fill="#6b7f85" font-family="Inter">${monthText}</g>
  </svg>`;
}

function donut(segments, centerValue, centerLabel, size) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  let bg;
  if (total === 0) {
    bg = 'var(--line)';
  } else {
    let acc = 0;
    const stops = segments.map(seg => {
      const start = (acc / total) * 360;
      acc += seg.value;
      const end = (acc / total) * 360;
      return `${seg.color} ${start.toFixed(1)}deg ${end.toFixed(1)}deg`;
    });
    bg = `conic-gradient(${stops.join(',')})`;
  }
  const cls = size === 'sm' ? ' stacked' : '';
  return `<div class="donut-wrap${cls}">
    <div class="donut" style="background:${bg}"><div class="donut-center"><strong>${centerValue}</strong><span>${centerLabel}</span></div></div>
    <div class="donut-legend">
      ${segments.map(seg => `<div class="donut-legend-item"><i class="legend-dot" style="background:${seg.color}"></i>${escapeHtml(seg.label)}<b>${seg.text ?? seg.value}</b></div>`).join('')}
    </div>
  </div>`;
}

const ICONS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9"/>',
  building: '<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1"/><path d="M10 21v-3h4v3"/>',
  developer: '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M9 8h1M14 8h1M9 12h1M14 12h1"/>',
  agent: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20c0-3.3 2.5-6 5.5-6s5.5 2.7 5.5 6"/><circle cx="17.5" cy="9" r="2.4"/><path d="M15.5 13.2c2.4.4 4 2.6 4 5.3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  mail: '<path d="M4 4h16v4H4zM4 10h10v4H4zM4 16h13v4H4z"/>',
  eye: '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/>',
  check: '<path d="M9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.6 1H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.6 1Z"/>'
};
function icon(name, size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
}

function rowActions(kind, id) {
  return `<div class="row-actions">
    <button class="icon-btn" data-stub="edit" data-kind="${kind}">${icon('edit', 13)}</button>
    <button class="icon-btn" data-stub="view" data-kind="${kind}">${icon('eye', 13)}</button>
    <button class="icon-btn danger" data-stub="delete" data-kind="${kind}">${icon('trash', 13)}</button>
  </div>`;
}

function bindStubs() {
  content.querySelectorAll('[data-stub]').forEach(btn => {
    btn.addEventListener('click', () => {
      alert('The full editor for this section is coming soon — it will be built next, mapped directly to the Supabase schema.');
    });
  });
}

/* ---------------- Dashboard ---------------- */

async function dashboardPage() {
  content.innerHTML = `<div class="empty">Loading dashboard…</div>`;

  const MOD_STATUSES = ['published', 'under_review', 'pending_verification', 'changes_required', 'draft'];

  const [
    residentialTotal, developersTotal, agentsTotal, agentsVerified,
    enquiriesTotal, enquiriesNew, citiesTotal, localitiesTotal,
    pendingModeration, [published, underReview, pendingVerification, changesRequired, draft],
    recentProjects, recentEnquiries, recentHistory
  ] = await Promise.all([
    count('residential_projects'),
    count('developers'),
    count('agents'),
    count('agents', q => q.eq('verified', true)),
    count('residential_enquiries'),
    count('residential_enquiries', q => q.eq('status', 'new')),
    count('cities'),
    count('localities'),
    count('residential_projects', q => q.in('moderation_status', ['pending_verification', 'under_review', 'changes_required', 'resubmitted'])),
    Promise.all(MOD_STATUSES.map(s => count('residential_projects', q => q.eq('moderation_status', s)))),
    sb.from('residential_projects').select('id,project_code,project_name,project_type,status,moderation_status,starting_price,price_on_request,cities(name),localities(name)').order('updated_at', { ascending: false }).limit(4),
    sb.from('residential_enquiries').select('id,contact_person,phone,enquiry_type,status,created_at,residential_projects(project_name)').order('created_at', { ascending: false }).limit(4),
    sb.from('residential_project_moderation_history').select('id,to_status,action,changed_at,residential_projects(project_name)').order('changed_at', { ascending: false }).limit(5)
  ]);

  // Monthly cumulative growth (last 6 months), residential only — commercial table doesn't exist yet.
  const now = new Date();
  const monthEnds = Array.from({ length: 6 }, (_, i) => new Date(now.getFullYear(), now.getMonth() - (5 - i) + 1, 0, 23, 59, 59));
  const residentialMonthly = await Promise.all(
    monthEnds.map(d => count('residential_projects', q => q.lte('created_at', d.toISOString())))
  );
  const commercialMonthly = [0, 0, 0, 0, 0, 0];

  const totalProjects = residentialTotal; // commercial not counted yet
  const now2 = new Date();

  content.innerHTML = `
    <div class="welcome">
      <div><h1>Welcome, ${escapeHtml((currentUser.email || 'Admin').split('@')[0])}!</h1><p>Here's what's happening on Keys99 today.</p></div>
      <div class="welcome-date"><strong>${now2.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</strong>${now2.toLocaleDateString('en-IN', { weekday: 'long' })}, ${now2.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</div>
    </div>

    <div class="kpi-row">
      <div class="kpi"><span class="kpi-icon green">${icon('home', 17)}</span><div class="value">${residentialTotal}</div><div class="label">Residential Projects</div><div class="trend"><span>All time</span></div></div>
      <div class="kpi"><span class="kpi-icon blue">${icon('building', 17)}</span><div class="value">—</div><div class="label">Commercial Projects</div><div class="trend flat"><span>Coming soon</span></div></div>
      <div class="kpi"><span class="kpi-icon teal">${icon('developer', 17)}</span><div class="value">${developersTotal}</div><div class="label">Developers</div><div class="trend"><span>All time</span></div></div>
      <div class="kpi"><span class="kpi-icon purple">${icon('agent', 17)}</span><div class="value">${agentsTotal}</div><div class="label">Agents</div><div class="trend">${agentsVerified} <span>verified</span></div></div>
      <div class="kpi"><span class="kpi-icon warn">${icon('clock', 17)}</span><div class="value">${pendingModeration}</div><div class="label">Pending Moderation</div><div class="trend flat">Needs <span>review</span></div></div>
      <div class="kpi"><span class="kpi-icon gold">${icon('mail', 17)}</span><div class="value">${enquiriesTotal}</div><div class="label">Enquiries</div><div class="trend">${enquiriesNew} <span>new</span></div></div>
    </div>

    <div class="body-grid">
      <div class="left-col">
        <div class="chart-row">
          <div class="panel chart-panel">
            <div class="panel-head">
              <h2>Project Listings Overview</h2>
              <div class="period-select">
                <select id="period-select">
                  <option>Today</option><option>Yesterday</option><option>Last Week</option>
                  <option>Last 15 Days</option><option>Last 30 Days</option><option>Last 3 Months</option>
                  <option selected>Last 6 Months</option><option>Last 1 Year</option>
                  <option>Last 3 Years</option><option>Last 5 Years</option>
                </select>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
              </div>
            </div>
            <div class="chart-legend"><span><i class="legend-dot" style="background:var(--green)"></i>Residential</span><span><i class="legend-dot" style="background:var(--gold)"></i>Commercial</span></div>
            <div class="chart-body">${buildOverviewChart(residentialMonthly, commercialMonthly)}</div>
          </div>

          <div class="panel donut-panel">
            <div class="panel-head"><h2>Project Mix</h2></div>
            ${donut(
              [{ label: 'Residential', value: residentialTotal, color: 'var(--green)', text: `${residentialTotal}${totalProjects ? ' · ' + Math.round(residentialTotal / totalProjects * 100) + '%' : ''}` },
               { label: 'Commercial', value: 0, color: 'var(--gold)', text: 'Coming soon' }],
              totalProjects, 'TOTAL', 'sm'
            )}
          </div>

          <div class="panel donut-panel">
            <div class="panel-head"><h2>Moderation Status</h2></div>
            ${donut(
              [{ label: 'Published', value: published, color: 'var(--green)' },
               { label: 'Under Review', value: underReview, color: 'var(--blue)' },
               { label: 'Pending', value: pendingVerification, color: 'var(--gold)' },
               { label: 'Changes Req.', value: changesRequired, color: 'var(--rose)' },
               { label: 'Draft', value: draft, color: 'var(--muted)' }],
              residentialTotal, 'PROJECTS', 'sm'
            )}
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><h2>Recent Residential Projects</h2><button class="panel-link" data-nav="residential">View All →</button></div>
          <div class="table-wrap"><table>
            <thead><tr><th>Project</th><th>Type</th><th>Location</th><th>Starting Price</th><th>Status</th><th>Moderation</th><th>Actions</th></tr></thead>
            <tbody>${(recentProjects.data || []).length ? recentProjects.data.map(p => `
              <tr>
                <td><div class="proj-cell"><span class="proj-thumb">${icon('home', 16)}</span><div><div class="proj-name">${escapeHtml(p.project_name)}</div><div class="proj-code">${escapeHtml(p.project_code)}</div></div></div></td>
                <td>${escapeHtml(p.project_type || '—')}</td>
                <td>${escapeHtml(p.localities?.name || '—')}${p.cities?.name ? ', ' + escapeHtml(p.cities.name) : ''}</td>
                <td>${fmtPrice(p.starting_price, p.price_on_request)}</td>
                <td>${escapeHtml((p.status || '—').replace(/_/g, ' '))}</td>
                <td>${pill(p.moderation_status)}</td>
                <td>${rowActions('project', p.id)}</td>
              </tr>`).join('') : emptyRow(7, 'No residential projects yet.')}
            </tbody>
          </table></div>
        </div>

        <div class="panel">
          <div class="panel-head"><h2>Recent Enquiries</h2><button class="panel-link" data-nav="enquiries">View All →</button></div>
          <div class="table-wrap"><table>
            <thead><tr><th>Name</th><th>Phone</th><th>Project</th><th>Type</th><th>Date</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>${(recentEnquiries.data || []).length ? recentEnquiries.data.map(e => `
              <tr>
                <td>${escapeHtml(e.contact_person)}</td><td>${escapeHtml(e.phone)}</td>
                <td>${escapeHtml(e.residential_projects?.project_name || '—')}</td>
                <td>${escapeHtml((e.enquiry_type || '—').replace(/_/g, ' '))}</td>
                <td>${fmtDate(e.created_at)}</td><td>${pill(e.status)}</td>
                <td><button class="icon-btn" data-stub="view">${icon('eye', 13)}</button></td>
              </tr>`).join('') : emptyRow(7, 'No enquiries yet.')}
            </tbody>
          </table></div>
        </div>
      </div>

      <div class="right-col">
        <div class="panel">
          <div class="panel-head"><h2>Quick Actions</h2></div>
          <div class="qa-panel">
            <button class="qa-primary" data-nav="residential">+ Add New Project</button>
            <button class="qa-item" data-nav="enquiries">${icon('mail')}Manage Enquiries</button>
            <button class="qa-item" data-nav="moderation">${icon('check')}Moderation Queue</button>
            <button class="qa-item" data-nav="developers">${icon('developer')}Add New Developer</button>
            <button class="qa-item" data-nav="settings">${icon('gear')}Settings</button>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><h2>Recent Activity</h2></div>
          <div class="activity">
            ${buildActivity(recentHistory.data, recentEnquiries.data)}
          </div>
        </div>
      </div>
    </div>
  `;

  content.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.nav)));
  bindStubs();
}

function buildActivity(historyRows, enquiryRows) {
  const items = [];
  (historyRows || []).forEach(h => items.push({
    time: h.changed_at,
    text: `<b>${escapeHtml(h.residential_projects?.project_name || 'A project')}</b> moved to ${escapeHtml((h.to_status || '').replace(/_/g, ' '))}`,
    color: h.to_status === 'changes_required' ? 'var(--danger)' : h.to_status === 'under_review' ? 'var(--warn)' : 'var(--green)'
  }));
  (enquiryRows || []).forEach(e => items.push({
    time: e.created_at,
    text: `<b>${escapeHtml(e.contact_person)}</b> submitted enquiry for <b>${escapeHtml(e.residential_projects?.project_name || 'a project')}</b>`,
    color: 'var(--green)'
  }));
  items.sort((a, b) => new Date(b.time) - new Date(a.time));
  const top = items.slice(0, 5);
  if (!top.length) return `<div class="empty">No activity yet.</div>`;
  return top.map(i => `<div class="activity-item"><span class="activity-dot" style="background:${i.color}"></span><div><div class="activity-text">${i.text}</div><div class="activity-time">${timeAgo(i.time)}</div></div></div>`).join('');
}

/* ---------------- Residential Projects ---------------- */

async function residentialPage() {
  content.innerHTML = pageHead('Residential Projects', 'Manage the residential listing catalog') + `<div class="empty">Loading…</div>`;
  const { data, error } = await sb.from('residential_projects')
    .select('id,project_code,project_name,project_type,status,moderation_status,starting_price,price_on_request,cities(name),localities(name)')
    .order('updated_at', { ascending: false }).limit(200);

  const toolbar = `<div class="toolbar">
    <div class="list-search">${icon('search', 14)}<input type="text" placeholder="Search projects" disabled></div>
    <button class="btn-primary" id="add-project">+ Add Project</button>
  </div>`;

  const rows = error
    ? emptyRow(7, error.message)
    : (data.length ? data.map(p => `
      <tr>
        <td><div class="proj-cell"><span class="proj-thumb">${icon('home', 16)}</span><div><div class="proj-name">${escapeHtml(p.project_name)}</div><div class="proj-code">${escapeHtml(p.project_code)}</div></div></div></td>
        <td>${escapeHtml(p.project_type || '—')}</td>
        <td>${escapeHtml(p.localities?.name || '—')}${p.cities?.name ? ', ' + escapeHtml(p.cities.name) : ''}</td>
        <td>${fmtPrice(p.starting_price, p.price_on_request)}</td>
        <td>${escapeHtml((p.status || '—').replace(/_/g, ' '))}</td>
        <td>${pill(p.moderation_status)}</td>
        <td>${rowActions('project', p.id)}</td>
      </tr>`).join('') : emptyRow(7, 'No residential projects yet. Click "+ Add Project" to create the first one.'));

  content.innerHTML = pageHead('Residential Projects', 'Manage the residential listing catalog') +
    tablePanel('All Projects', toolbar, ['Project', 'Type', 'Location', 'Starting Price', 'Status', 'Moderation', 'Actions'], rows);

  $('#add-project')?.addEventListener('click', () => alert('The full 20-section project editor is coming soon, mapped directly to the residential_projects schema.'));
  bindStubs();
}

/* ---------------- Commercial Projects (schema not built yet) ---------------- */

async function commercialPage() {
  content.innerHTML = pageHead('Commercial Projects', 'Office, retail and mixed-use commercial listings') + `
    <div class="panel">
      <div class="panel-head"><h2>Coming Soon</h2></div>
      <div class="notice">Commercial project listings aren't built yet — there's no <code>commercial_projects</code> table in the database. This section will be added later, mirroring the residential project structure (configurations, media, amenities, moderation workflow, etc.).</div>
    </div>`;
}

/* ---------------- Developers ---------------- */

async function developersPage() {
  content.innerHTML = pageHead('Developers', 'Builder and developer master data') + `<div class="empty">Loading…</div>`;
  const { data, error } = await sb.from('developers').select('id,name,rera_id,contact_email,contact_phone,verified,status').order('created_at', { ascending: false }).limit(200);

  const toolbar = `<div class="toolbar"><button class="btn-primary" id="add-developer">+ Add Developer</button></div>`;
  const rows = error
    ? emptyRow(6, error.message)
    : (data.length ? data.map(d => `
      <tr>
        <td><strong>${escapeHtml(d.name)}</strong></td>
        <td>${escapeHtml(d.rera_id || '—')}</td>
        <td>${escapeHtml(d.contact_email || '—')}</td>
        <td>${escapeHtml(d.contact_phone || '—')}</td>
        <td>${d.verified ? pill('verified') : pill('unverified')}</td>
        <td>${rowActions('developer', d.id)}</td>
      </tr>`).join('') : emptyRow(6, 'No developers added yet.'));

  content.innerHTML = pageHead('Developers', 'Builder and developer master data') +
    tablePanel('All Developers', toolbar, ['Name', 'RERA ID', 'Email', 'Phone', 'Verified', 'Actions'], rows);

  $('#add-developer')?.addEventListener('click', () => alert('Developer add/edit form is coming soon.'));
  bindStubs();
}

/* ---------------- Cities & Localities ---------------- */

async function citiesPage() {
  content.innerHTML = pageHead('Cities & Localities', 'Coverage areas for residential listings') + `<div class="empty">Loading…</div>`;
  const { data, error } = await sb.from('cities').select('id,name,state,is_active,localities(id)').order('name', { ascending: true }).limit(200);

  const toolbar = `<div class="toolbar"><button class="btn-primary" id="add-city">+ Add City</button></div>`;
  const rows = error
    ? emptyRow(4, error.message)
    : (data.length ? data.map(c => `
      <tr>
        <td><strong>${escapeHtml(c.name)}</strong></td>
        <td>${escapeHtml(c.state || '—')}</td>
        <td>${(c.localities || []).length} localities</td>
        <td>${c.is_active ? pill('active') : pill('inactive')}</td>
      </tr>`).join('') : emptyRow(4, 'No cities added yet.'));

  content.innerHTML = pageHead('Cities & Localities', 'Coverage areas for residential listings') +
    tablePanel('All Cities', toolbar, ['City', 'State', 'Localities', 'Status'], rows);

  $('#add-city')?.addEventListener('click', () => alert('City/locality management form is coming soon.'));
}

/* ---------------- Agents ---------------- */

async function agentsPage() {
  content.innerHTML = pageHead('Agents', 'Agent profiles and verification') + `<div class="empty">Loading…</div>`;
  const { data, error } = await sb.from('agents').select('id,full_name,company_name,email,phone,verified,status').order('created_at', { ascending: false }).limit(200);

  const toolbar = `<div class="toolbar"><button class="btn-primary" id="add-agent">+ Add Agent</button></div>`;
  const rows = error
    ? emptyRow(6, error.message)
    : (data.length ? data.map(a => `
      <tr>
        <td><strong>${escapeHtml(a.full_name)}</strong></td>
        <td>${escapeHtml(a.company_name || '—')}</td>
        <td>${escapeHtml(a.email || '—')}</td>
        <td>${escapeHtml(a.phone || '—')}</td>
        <td>${a.verified ? pill('verified') : pill('unverified')}</td>
        <td>${rowActions('agent', a.id)}</td>
      </tr>`).join('') : emptyRow(6, 'No agents added yet.'));

  content.innerHTML = pageHead('Agents', 'Agent profiles and verification') +
    tablePanel('All Agents', toolbar, ['Name', 'Company', 'Email', 'Phone', 'Verified', 'Actions'], rows);

  $('#add-agent')?.addEventListener('click', () => alert('Agent add/edit form is coming soon.'));
  bindStubs();
}

/* ---------------- Enquiries ---------------- */

async function enquiriesPage() {
  content.innerHTML = pageHead('Enquiries', 'Residential project leads') + `<div class="empty">Loading…</div>`;
  const { data, error } = await sb.from('residential_enquiries')
    .select('id,contact_person,phone,email,enquiry_type,status,created_at,residential_projects(project_name)')
    .order('created_at', { ascending: false }).limit(200);

  const rows = error
    ? emptyRow(6, error.message)
    : (data.length ? data.map(e => `
      <tr>
        <td>${escapeHtml(e.contact_person)}</td>
        <td>${escapeHtml(e.phone)}</td>
        <td>${escapeHtml(e.residential_projects?.project_name || '—')}</td>
        <td>${escapeHtml((e.enquiry_type || '—').replace(/_/g, ' '))}</td>
        <td>${fmtDate(e.created_at)}</td>
        <td>${pill(e.status)}</td>
      </tr>`).join('') : emptyRow(6, 'No enquiries yet.'));

  content.innerHTML = pageHead('Enquiries', 'Residential project leads') +
    tablePanel('All Enquiries', '', ['Name', 'Phone', 'Project', 'Type', 'Date', 'Status'], rows);
}

/* ---------------- Moderation Queue ---------------- */

async function moderationPage() {
  content.innerHTML = pageHead('Moderation Queue', 'Review, approve and publish projects') + `<div class="empty">Loading…</div>`;
  const { data, error } = await sb.from('residential_projects')
    .select('id,project_code,project_name,moderation_status,updated_at')
    .in('moderation_status', ['pending_verification', 'under_review', 'changes_required', 'resubmitted'])
    .order('updated_at', { ascending: false }).limit(200);

  const rows = error
    ? emptyRow(4, error.message)
    : (data.length ? data.map(p => `
      <tr>
        <td><div class="proj-name">${escapeHtml(p.project_name)}</div><div class="proj-code">${escapeHtml(p.project_code)}</div></td>
        <td>${pill(p.moderation_status)}</td>
        <td>${fmtDate(p.updated_at)}</td>
        <td><button class="icon-btn" data-stub="view">${icon('eye', 13)}</button></td>
      </tr>`).join('') : emptyRow(4, 'Moderation queue is empty.'));

  content.innerHTML = pageHead('Moderation Queue', 'Review, approve and publish projects') +
    tablePanel('Awaiting Action', '', ['Project', 'Status', 'Updated', 'Actions'], rows);
  bindStubs();
}

/* ---------------- Settings & Profile ---------------- */

async function settingsPage() {
  content.innerHTML = pageHead('Settings', 'Admin account and application settings') + `
    <div class="panel"><div class="panel-head"><h2>System</h2></div>
      <div class="notice">Authentication and authorization are controlled by Supabase Auth and the <code>user_roles</code> table. No service-role key is stored in this frontend — access is enforced entirely by database row-level security.</div>
    </div>`;
}

async function profilePage() {
  const rolesText = currentRoles.length ? currentRoles.join(', ') : '—';
  content.innerHTML = pageHead('Profile', 'Your account details') + `
    <div class="panel"><div class="panel-head"><h2>Account</h2></div>
      <div class="notice">
        <strong>Email:</strong> ${escapeHtml(currentUser?.email || '—')}<br>
        <strong>Roles:</strong> ${escapeHtml(rolesText)}<br>
        <strong>User ID:</strong> ${escapeHtml(currentUser?.id || '—')}
      </div>
    </div>`;
}

/* ---------------- navigation ---------------- */

const PAGES = {
  dashboard: dashboardPage,
  residential: residentialPage,
  commercial: commercialPage,
  developers: developersPage,
  cities: citiesPage,
  agents: agentsPage,
  enquiries: enquiriesPage,
  moderation: moderationPage,
  settings: settingsPage,
  profile: profilePage
};

async function navigate(page) {
  if (!PAGES[page]) page = 'dashboard';
  document.querySelectorAll('.sb-item[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  closeSidebar();
  window.scrollTo(0, 0);
  await PAGES[page]();
}

function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sidebar-backdrop').classList.remove('open');
}

document.querySelectorAll('.sb-item[data-page]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.page)));
$('#logout-btn').addEventListener('click', async () => { await sb.auth.signOut(); location.replace('./login.html'); });
$('#menu-btn').addEventListener('click', () => {
  $('#sidebar').classList.toggle('open');
  $('#sidebar-backdrop').classList.toggle('open');
});
$('#sidebar-backdrop').addEventListener('click', closeSidebar);

/* ---------------- boot ---------------- */

if (await guard()) {
  loadSidebarCounts();
  navigate('dashboard');
}

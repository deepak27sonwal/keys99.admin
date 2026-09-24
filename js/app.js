import { openProjectForm, isWizardOpen, handleWizardPopState } from './project-form.js';
import { sb } from './supabase-client.js';
import { residentialProjectsPage } from './residential-projects.js';
import { openEntityForm, confirmDeleteEntity } from './entity-form.js';
import { enhanceSelects } from './custom-select.js';
import {
  escapeHtml, pill, fmtPrice, fmtDate, timeAgo, count, initials,
  pageHead, tablePanel, emptyRow, icon, rowActions, bindStubs, toast, customConfirm,
  confirmArchiveProject
} from './utils.js';
import { archivePage } from './archive.js';

const $ = s => document.querySelector(s);
const content = $('#content');

let currentUser = null;
let currentRoles = [];

// Wraps the shared bindStubs() with this app's edit-project wiring — used by every page
// rendered here that can show project rows (Dashboard's "Recent Projects" table, etc.);
// the Residential Projects list itself lives in residential-projects.js and does its own.
function bindPageStubs() {
  bindStubs(content, {
    onEditProject: (id) => openProjectForm(content, currentUser, id, () => navigate('residential')),
    onDeleteProject: (id, name) => confirmArchiveProject(id, name, currentUser.id, () => dashboardPage())
  });
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
    count('residential_projects', q => q.is('deleted_at', null)),
    count('residential_enquiries', q => q.in('status', ['new', 'contacted', 'follow_up'])),
    count('residential_projects', q => q.is('deleted_at', null).in('moderation_status', ['pending_verification', 'under_review', 'changes_required', 'resubmitted']))
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

const CHART_POINTS = 6;

// Turns a period-select label into an ordered list of { end: Date, label: string } points —
// the chart always shows CHART_POINTS evenly-spaced samples across the chosen range, each
// plotting the cumulative project count as of that moment. The date-math and label format
// scale with the range so "Today" reads in hours while "Last 5 Years" reads in years.
function periodBuckets(period) {
  const now = new Date();
  let start, end = now;
  switch (period) {
    case 'Today': start = new Date(now.getFullYear(), now.getMonth(), now.getDate()); break;
    case 'Yesterday':
      end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1);
      break;
    case 'Last Week': start = new Date(now - 7 * 86400000); break;
    case 'Last 15 Days': start = new Date(now - 15 * 86400000); break;
    case 'Last 30 Days': start = new Date(now - 30 * 86400000); break;
    case 'Last 3 Months': start = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate()); break;
    case 'Last 1 Year': start = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()); break;
    case 'Last 3 Years': start = new Date(now.getFullYear() - 3, now.getMonth(), now.getDate()); break;
    case 'Last 5 Years': start = new Date(now.getFullYear() - 5, now.getMonth(), now.getDate()); break;
    case 'Last 6 Months':
    default: start = new Date(now.getFullYear(), now.getMonth() - 6, now.getDate());
  }

  const spanMs = end - start;
  const fmt = spanMs <= 2 * 86400000
    ? (d) => d.toLocaleTimeString('en-IN', { hour: 'numeric' })
    : spanMs <= 400 * 86400000
      ? (d) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
      : (d) => d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });

  const points = [];
  for (let i = 0; i < CHART_POINTS; i++) {
    const t = new Date(start.getTime() + (spanMs * (i + 1)) / CHART_POINTS);
    points.push({ end: t, label: fmt(t) });
  }
  return points;
}

function buildOverviewChart(residentialSeries, commercialSeries, labels) {
  const n = residentialSeries.length;
  const dx = n > 1 ? (494 - 44) / (n - 1) : 0;
  const x = i => 44 + i * dx;

  const maxVal = Math.max(1, ...residentialSeries, ...commercialSeries);
  const niceMax = Math.max(10, Math.ceil((maxVal * 1.15) / 5) * 5);
  const y = v => 160 - (v / niceMax) * 140;

  const rYs = residentialSeries.map(y);
  const cYs = commercialSeries.map(y);
  const rPath = smoothPath(rYs, 44, dx);
  const cPath = smoothPath(cYs, 44, dx);
  const areaPath = `${rPath} L${x(n - 1)},160 L44,160 Z`;
  const lastR = residentialSeries[n - 1];
  const lastC = commercialSeries[n - 1];

  const dotsR = residentialSeries.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="${i === n - 1 ? 5 : 4}" stroke="#fff" stroke-width="2"/>`).join('');
  const dotsC = commercialSeries.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="${i === n - 1 ? 4 : 3.5}" stroke="#fff" stroke-width="2"/>`).join('');
  const labelText = labels.map((l, i) => `<text x="${x(i)}" y="180">${escapeHtml(l)}</text>`).join('');

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
    <g font-size="9.5" font-weight="700" fill="#046b5e"><text x="${x(n - 1)}" y="${y(lastR) - 8}" text-anchor="end">${lastR}</text></g>
    <g font-size="9.5" font-weight="700" fill="#b7791f"><text x="${x(n - 1)}" y="${y(lastC) - 8}" text-anchor="end">${lastC}</text></g>
    <g font-size="10.5" fill="#6b7f85" font-family="Inter">${labelText}</g>
  </svg>`;
}

async function loadOverviewChart(period) {
  const buckets = periodBuckets(period);
  const residentialSeries = await Promise.all(buckets.map(b => count('residential_projects', q => q.lte('created_at', b.end.toISOString()))));
  const commercialSeries = buckets.map(() => 0); // commercial table doesn't exist yet
  return buildOverviewChart(residentialSeries, commercialSeries, buckets.map(b => b.label));
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
    count('residential_projects', q => q.is('deleted_at', null)),
    count('developers'),
    count('agents'),
    count('agents', q => q.eq('verified', true)),
    count('residential_enquiries'),
    count('residential_enquiries', q => q.eq('status', 'new')),
    count('cities'),
    count('localities'),
    count('residential_projects', q => q.is('deleted_at', null).in('moderation_status', ['pending_verification', 'under_review', 'changes_required', 'resubmitted'])),
    Promise.all(MOD_STATUSES.map(s => count('residential_projects', q => q.is('deleted_at', null).eq('moderation_status', s)))),
    sb.from('residential_projects').select('id,project_code,project_name,project_type,status,moderation_status,starting_price,price_on_request,cities(name),localities!residential_projects_locality_id_fkey(name)').is('deleted_at', null).order('updated_at', { ascending: false }).limit(4),
    sb.from('residential_enquiries').select('id,contact_person,phone,enquiry_type,status,created_at,residential_projects(project_name)').order('created_at', { ascending: false }).limit(4),
    sb.from('residential_project_moderation_history').select('id,to_status,action,changed_at,residential_projects(project_name)').order('changed_at', { ascending: false }).limit(5)
  ]);

  const chartHtml = await loadOverviewChart('Last 6 Months');
  const totalProjects = residentialTotal; // commercial not counted yet
  const now2 = new Date();

  content.innerHTML = `
    <div class="welcome">
      <div><h1>Welcome, ${escapeHtml((currentUser.email || 'Admin').split('@')[0])}!</h1><p>Here's what's happening on Keys99 today.</p></div>
      <div class="welcome-date"><strong>${now2.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}</strong>${now2.toLocaleDateString('en-IN', { weekday: 'long' })}, ${now2.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</div>
    </div>

    <div class="kpi-row">
      <div class="kpi kpi-link" data-nav="residential"><span class="kpi-icon green">${icon('home', 17)}</span><div class="value">${residentialTotal}</div><div class="label">Residential Projects</div><div class="trend"><span>All time</span></div></div>
      <div class="kpi kpi-link" data-nav="commercial"><span class="kpi-icon blue">${icon('building', 17)}</span><div class="value">—</div><div class="label">Commercial Projects</div><div class="trend flat"><span>Coming soon</span></div></div>
      <div class="kpi kpi-link" data-nav="developers"><span class="kpi-icon teal">${icon('developer', 17)}</span><div class="value">${developersTotal}</div><div class="label">Developers</div><div class="trend"><span>All time</span></div></div>
      <div class="kpi kpi-link" data-nav="agents"><span class="kpi-icon purple">${icon('agent', 17)}</span><div class="value">${agentsTotal}</div><div class="label">Agents</div><div class="trend">${agentsVerified} <span>verified</span></div></div>
      <div class="kpi kpi-link" data-nav="moderation"><span class="kpi-icon warn">${icon('clock', 17)}</span><div class="value">${pendingModeration}</div><div class="label">Pending Moderation</div><div class="trend flat">Needs <span>review</span></div></div>
      <div class="kpi kpi-link" data-nav="enquiries"><span class="kpi-icon gold">${icon('mail', 17)}</span><div class="value">${enquiriesTotal}</div><div class="label">Enquiries</div><div class="trend">${enquiriesNew} <span>new</span></div></div>
      <div class="kpi kpi-link" data-nav="residential" data-filter="draft"><span class="kpi-icon muted">${icon('edit', 17)}</span><div class="value">${draft}</div><div class="label">Draft Projects</div><div class="trend flat"><span>Continue editing</span></div></div>
      <div class="kpi kpi-link" data-nav="cities"><span class="kpi-icon pink">${icon('pin', 17)}</span><div class="value">${citiesTotal}</div><div class="label">Cities</div><div class="trend"><span>Coverage areas</span></div></div>
      <div class="kpi kpi-link" data-nav="cities"><span class="kpi-icon cyan">${icon('layers', 17)}</span><div class="value">${localitiesTotal}</div><div class="label">Localities</div><div class="trend"><span>All cities</span></div></div>
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
            <div class="chart-body" id="chart-body">${chartHtml}</div>
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

        <div class="dash-tabs" id="dash-tabs">
          <button class="dash-tab active" data-tab="projects">Projects</button>
          <button class="dash-tab" data-tab="enquiries">Enquiries</button>
          <button class="dash-tab" data-tab="activity">Activity</button>
        </div>

        <div class="panel dash-tab-panel active" data-tab-panel="projects">
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
                <td>${rowActions('project', p.id, p.project_name)}</td>
              </tr>`).join('') : emptyRow(7, 'No residential projects yet.')}
            </tbody>
          </table></div>
        </div>

        <div class="panel dash-tab-panel" data-tab-panel="enquiries">
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
        <div class="panel dash-tab-panel" data-tab-panel="activity">
          <div class="panel-head"><h2>Recent Activity</h2></div>
          <div class="activity">
            ${buildActivity(recentHistory.data, recentEnquiries.data)}
          </div>
        </div>
      </div>
    </div>
  `;

  enhanceSelects(content);
  content.querySelectorAll('[data-nav]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.nav, { filter: b.dataset.filter })));
  content.querySelectorAll('.dash-tab').forEach(btn => btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    content.querySelectorAll('.dash-tab').forEach(b => b.classList.toggle('active', b === btn));
    content.querySelectorAll('.dash-tab-panel').forEach(p => p.classList.toggle('active', p.dataset.tabPanel === tab));
  }));
  $('#period-select')?.addEventListener('change', async (e) => {
    const chartBody = $('#chart-body');
    const trigger = e.target.closest('.cs-wrap')?.querySelector('.cs-trigger');
    e.target.disabled = true;
    if (trigger) trigger.disabled = true;
    chartBody.innerHTML = `<div class="empty">Loading…</div>`;
    chartBody.innerHTML = await loadOverviewChart(e.target.value);
    e.target.disabled = false;
    if (trigger) trigger.disabled = false;
  });
  bindPageStubs();
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

  $('#add-developer')?.addEventListener('click', () => openDeveloperForm(null));
  bindStubs(content, {
    onEditEntity: (kind, id) => kind === 'developer' && openDeveloperForm(id),
    onDeleteEntity: (kind, id) => kind === 'developer' && confirmDeleteEntity('developers', id, 'this developer', developersPage)
  });
}

const DEVELOPER_FIELDS = [
  { key: 'name', label: 'Developer Name', req: true, full: true },
  { key: 'rera_id', label: 'RERA ID' },
  { key: 'website', label: 'Website', type: 'url' },
  { key: 'contact_email', label: 'Contact Email', type: 'email' },
  { key: 'contact_phone', label: 'Contact Phone', type: 'tel' },
  { key: 'description', label: 'Description', type: 'textarea', full: true },
  { key: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }], default: 'active' },
  { key: 'verified', label: 'Verified developer', type: 'checkbox', full: true }
];

function openDeveloperForm(id) {
  openEntityForm({
    title: id ? 'Edit Developer' : 'Add Developer',
    table: 'developers',
    fields: DEVELOPER_FIELDS,
    existingId: id,
    onSaved: developersPage
  });
}

/* ---------------- Cities & Localities ---------------- */

async function citiesPage() {
  content.innerHTML = pageHead('Cities & Localities', 'Coverage areas for residential listings') + `<div class="empty">Loading…</div>`;
  const { data, error } = await sb.from('cities').select('id,name,state,is_active,localities(id)').order('name', { ascending: true }).limit(200);

  const toolbar = `<div class="toolbar"><button class="btn-primary" id="add-city">+ Add City</button></div>`;
  const rows = error
    ? emptyRow(5, error.message)
    : (data.length ? data.map(c => `
      <tr>
        <td><strong>${escapeHtml(c.name)}</strong></td>
        <td>${escapeHtml(c.state || '—')}</td>
        <td><button class="link-btn" data-localities="${c.id}">${(c.localities || []).length} localities</button></td>
        <td>${c.is_active ? pill('active') : pill('inactive')}</td>
        <td>${rowActions('city', c.id)}</td>
      </tr>`).join('') : emptyRow(5, 'No cities added yet.'));

  content.innerHTML = pageHead('Cities & Localities', 'Coverage areas for residential listings') +
    tablePanel('All Cities', toolbar, ['City', 'State', 'Localities', 'Status', 'Actions'], rows);

  $('#add-city')?.addEventListener('click', () => openCityForm(null));
  content.querySelectorAll('[data-localities]').forEach(btn => {
    btn.addEventListener('click', () => manageLocalities(btn.dataset.localities, btn.closest('tr').querySelector('strong').textContent));
  });
  bindStubs(content, {
    onEditEntity: (kind, id) => kind === 'city' && openCityForm(id),
    onDeleteEntity: (kind, id) => kind === 'city' && confirmDeleteEntity('cities', id, 'this city (and its localities)', citiesPage)
  });
}

const CITY_FIELDS = [
  { key: 'name', label: 'City Name', req: true },
  { key: 'state', label: 'State', req: true },
  { key: 'is_active', label: 'Active', type: 'checkbox', full: true, default: true }
];

function openCityForm(id) {
  openEntityForm({
    title: id ? 'Edit City' : 'Add City',
    table: 'cities',
    fields: CITY_FIELDS,
    existingId: id,
    onSaved: citiesPage
  });
}

async function manageLocalities(cityId, cityName) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-head">
        <div><h2>Localities</h2><p>${escapeHtml(cityName || '')}</p></div>
        <button type="button" class="modal-close" data-close>✕</button>
      </div>
      <div class="modal-body">
        <div class="modal-list" id="locality-list"><div class="modal-list-empty">Loading…</div></div>
        <div class="field full">
          <label>Add Locality</label>
          <div style="display:flex;gap:8px">
            <input id="new-locality-name" type="text" placeholder="Locality name" style="flex:1">
            <button type="button" class="btn-primary" id="add-locality-btn">+ Add</button>
          </div>
        </div>
      </div>
      <div class="modal-footer"><button type="button" class="btn-outline" data-close>Close</button></div>
    </div>`;
  document.body.appendChild(overlay);

  const closeModal = () => { overlay.remove(); document.removeEventListener('keydown', escHandler); };
  const escHandler = (e) => { if (e.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', escHandler);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
  overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeModal));

  async function reload() {
    const listEl = overlay.querySelector('#locality-list');
    const { data, error } = await sb.from('localities').select('id,name,is_active').eq('city_id', cityId).order('name', { ascending: true });
    if (error) { listEl.innerHTML = `<div class="modal-list-empty">${escapeHtml(error.message)}</div>`; return; }
    listEl.innerHTML = data.length
      ? data.map(l => `<div class="modal-list-row"><span>${escapeHtml(l.name)} ${l.is_active ? '' : pill('inactive')}</span><button type="button" class="icon-btn danger" data-remove-locality="${l.id}">${icon('trash', 13)}</button></div>`).join('')
      : `<div class="modal-list-empty">No localities in ${escapeHtml(cityName || 'this city')} yet.</div>`;
    listEl.querySelectorAll('[data-remove-locality]').forEach(b => b.addEventListener('click', async () => {
      if (!(await customConfirm('This cannot be undone.', { title: 'Delete this locality?', confirmLabel: 'Delete', danger: true }))) return;
      const { error } = await sb.from('localities').delete().eq('id', b.dataset.removeLocality);
      if (error) { toast(error.message, true); return; }
      toast('Deleted');
      reload();
    }));
  }

  overlay.querySelector('#add-locality-btn').addEventListener('click', async () => {
    const input = overlay.querySelector('#new-locality-name');
    const name = input.value.trim();
    if (!name) { toast('Enter a locality name', true); return; }
    const { error } = await sb.from('localities').insert({ city_id: cityId, name });
    if (error) { toast(error.message, true); return; }
    input.value = '';
    toast('Added');
    reload();
  });

  reload();
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

  $('#add-agent')?.addEventListener('click', () => openAgentForm(null));
  bindStubs(content, {
    onEditEntity: (kind, id) => kind === 'agent' && openAgentForm(id),
    onDeleteEntity: (kind, id) => kind === 'agent' && confirmDeleteEntity('agents', id, 'this agent', agentsPage)
  });
}

const AGENT_FIELDS = [
  { key: 'full_name', label: 'Full Name', req: true, full: true },
  { key: 'company_name', label: 'Company Name' },
  { key: 'rera_id', label: 'RERA ID' },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'phone', label: 'Phone', type: 'tel' },
  { key: 'whatsapp', label: 'WhatsApp', type: 'tel' },
  { key: 'bio', label: 'Bio', type: 'textarea', full: true },
  { key: 'status', label: 'Status', type: 'select', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }], default: 'active' },
  { key: 'verified', label: 'Verified agent', type: 'checkbox', full: true }
];

function openAgentForm(id) {
  openEntityForm({
    title: id ? 'Edit Agent' : 'Add Agent',
    table: 'agents',
    fields: AGENT_FIELDS,
    existingId: id,
    onSaved: agentsPage
  });
}

/* ---------------- Enquiries ---------------- */

const ENQUIRY_STATUSES = ['new', 'contacted', 'follow_up', 'site_visit_scheduled', 'converted', 'closed', 'spam'];
const ENQUIRY_CLOSING_STATUSES = ['converted', 'closed', 'spam'];

async function enquiriesPage(openId) {
  content.innerHTML = pageHead('Enquiries', 'Residential project leads') + `<div class="empty">Loading…</div>`;
  const [{ data, error }, { data: agentsList }] = await Promise.all([
    sb.from('residential_enquiries')
      .select('id,contact_person,phone,whatsapp,email,enquiry_type,message,preferred_contact_method,preferred_visit_date,assigned_agent_id,source,status,admin_notes,contacted_at,closed_at,created_at,residential_projects(project_name),agents(full_name)')
      .order('created_at', { ascending: false }).limit(200),
    sb.from('agents').select('id,full_name').order('full_name', { ascending: true })
  ]);

  const rows = error
    ? emptyRow(7, error.message)
    : (data.length ? data.map(e => `
      <tr>
        <td>${escapeHtml(e.contact_person)}</td>
        <td>${escapeHtml(e.phone)}</td>
        <td>${escapeHtml(e.residential_projects?.project_name || '—')}</td>
        <td>${escapeHtml(e.agents?.full_name || 'Unassigned')}</td>
        <td>${fmtDate(e.created_at)}</td>
        <td>${pill(e.status)}</td>
        <td><button type="button" class="icon-btn" data-view-enquiry="${e.id}">${icon('eye', 13)}</button></td>
      </tr>`).join('') : emptyRow(7, 'No enquiries yet.'));

  content.innerHTML = pageHead('Enquiries', 'Residential project leads') +
    tablePanel('All Enquiries', '', ['Name', 'Phone', 'Project', 'Assigned', 'Date', 'Status', 'Actions'], rows);

  const byId = Object.fromEntries((data || []).map(e => [e.id, e]));
  content.querySelectorAll('[data-view-enquiry]').forEach(btn => {
    btn.addEventListener('click', () => viewEnquiry(byId[btn.dataset.viewEnquiry], agentsList || [], () => enquiriesPage()));
  });

  if (openId && byId[openId]) viewEnquiry(byId[openId], agentsList || [], () => enquiriesPage());
}

function viewEnquiry(e, agentsList, onSaved) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box" style="max-width:560px">
      <div class="modal-head">
        <div><h2>${escapeHtml(e.contact_person)}</h2><p>${escapeHtml(e.residential_projects?.project_name || 'Project deleted')}</p></div>
        <button type="button" class="modal-close" data-close>✕</button>
      </div>
      <div class="modal-body">
        <div class="detail-grid" style="margin-bottom:16px">
          <div><b>Phone</b><div>${escapeHtml(e.phone)}</div></div>
          <div><b>WhatsApp</b><div>${escapeHtml(e.whatsapp || '—')}</div></div>
          <div><b>Email</b><div>${escapeHtml(e.email || '—')}</div></div>
          <div><b>Enquiry Type</b><div>${escapeHtml((e.enquiry_type || '—').replace(/_/g, ' '))}</div></div>
          <div><b>Preferred Contact</b><div>${escapeHtml((e.preferred_contact_method || '—').replace(/_/g, ' '))}</div></div>
          <div><b>Preferred Visit Date</b><div>${fmtDate(e.preferred_visit_date)}</div></div>
          <div><b>Source</b><div>${escapeHtml(e.source || '—')}</div></div>
          <div><b>Received</b><div>${fmtDate(e.created_at)}</div></div>
        </div>
        ${e.message ? `<div class="field full" style="margin-bottom:16px"><label>Message</label><p class="confirm-message" style="background:var(--bg);padding:10px 12px;border-radius:9px">${escapeHtml(e.message)}</p></div>` : ''}
        <div class="form-grid">
          <div class="field"><label>Status</label>
            <select data-field="status">${ENQUIRY_STATUSES.map(s => `<option value="${s}"${s === e.status ? ' selected' : ''}>${escapeHtml(s.replace(/_/g, ' '))}</option>`).join('')}</select>
          </div>
          <div class="field"><label>Assign Agent</label>
            <select data-field="assigned_agent_id"><option value="">Unassigned</option>${agentsList.map(a => `<option value="${a.id}"${a.id === e.assigned_agent_id ? ' selected' : ''}>${escapeHtml(a.full_name)}</option>`).join('')}</select>
          </div>
          <div class="field full"><label>Admin Notes</label>
            <textarea data-field="admin_notes" placeholder="Internal notes about this lead…">${escapeHtml(e.admin_notes || '')}</textarea>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn-outline" data-close>Cancel</button>
        <button type="button" class="btn-primary" data-save>Save Changes</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  enhanceSelects(overlay);

  const close = () => { overlay.remove(); document.removeEventListener('keydown', escHandler); };
  const escHandler = (ev) => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', escHandler);
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
  overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));

  overlay.querySelector('[data-save]').addEventListener('click', async () => {
    const status = overlay.querySelector('[data-field="status"]').value;
    const assignedAgentId = overlay.querySelector('[data-field="assigned_agent_id"]').value || null;
    const adminNotes = overlay.querySelector('[data-field="admin_notes"]').value.trim() || null;

    const payload = { status, assigned_agent_id: assignedAgentId, admin_notes: adminNotes };
    if (status === 'contacted' && !e.contacted_at) payload.contacted_at = new Date().toISOString();
    if (ENQUIRY_CLOSING_STATUSES.includes(status) && !e.closed_at) payload.closed_at = new Date().toISOString();

    const saveBtn = overlay.querySelector('[data-save]');
    saveBtn.disabled = true;
    const { error } = await sb.from('residential_enquiries').update(payload).eq('id', e.id);
    saveBtn.disabled = false;
    if (error) { toast(error.message, true); return; }

    toast('Enquiry updated');
    close();
    onSaved && onSaved();
  });
}

/* ---------------- Moderation Queue ---------------- */

const MOD_TABS = [
  { key: 'awaiting', label: 'Awaiting Action', statuses: ['pending_verification', 'under_review', 'resubmitted', 'changes_required'] },
  { key: 'published', label: 'Published', statuses: ['published'] },
  { key: 'rejected', label: 'Rejected', statuses: ['rejected'] },
  { key: 'suspended', label: 'Suspended', statuses: ['suspended'] },
  { key: 'archived', label: 'Archived', statuses: ['archived'] },
  { key: 'all', label: 'All', statuses: null }
];

const MOD_ACTIONS = {
  startReview: { label: 'Start Review', icon: 'refresh', toStatus: 'under_review', action: 'under_review' },
  approve: { label: 'Approve & Publish', icon: 'check', toStatus: 'published', setApprovedAt: true, setPublishedAt: true, action: 'approved' },
  requestChanges: { label: 'Request Changes', icon: 'edit', toStatus: 'changes_required', requireComment: true, action: 'changes_requested' },
  reject: { label: 'Reject', icon: 'close', toStatus: 'rejected', requireComment: true, action: 'rejected' },
  suspend: { label: 'Suspend', icon: 'pause', toStatus: 'suspended', requireComment: true, action: 'suspended' },
  republish: { label: 'Republish', icon: 'check', toStatus: 'published', setPublishedAt: true, action: 'republished' },
  archive: { label: 'Archive', icon: 'archive', toStatus: 'archived', action: 'archived' },
  restore: { label: 'Restore to Draft', icon: 'refresh', toStatus: 'draft', action: 'restored' }
};

function actionKeysForStatus(status) {
  switch (status) {
    case 'pending_verification':
    case 'resubmitted': return ['startReview', 'approve', 'requestChanges', 'reject'];
    case 'under_review': return ['approve', 'requestChanges', 'reject'];
    case 'changes_required': return ['reject'];
    case 'published': return ['suspend', 'archive'];
    case 'suspended': return ['republish', 'archive'];
    case 'rejected': return ['restore', 'archive'];
    case 'archived': return ['restore'];
    default: return [];
  }
}

// A small modal to collect the required reason/comment for actions like Request Changes,
// Reject and Suspend — resolves with the trimmed comment, or null if cancelled.
function promptComment(actionLabel, projectName) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box">
        <div class="modal-head">
          <div><h2>${escapeHtml(actionLabel)}</h2><p>${escapeHtml(projectName)}</p></div>
          <button type="button" class="modal-close" data-close>✕</button>
        </div>
        <div class="modal-body">
          <div class="field full">
            <label>Reason <span class="req">*</span></label>
            <textarea id="mod-comment" placeholder="Explain why, so the submitter knows what to fix…"></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn-outline" data-close>Cancel</button>
          <button type="button" class="btn-primary" id="mod-comment-submit">${escapeHtml(actionLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const finish = (value) => {
      overlay.remove();
      document.removeEventListener('keydown', escHandler);
      resolve(value);
    };
    const escHandler = (e) => { if (e.key === 'Escape') finish(null); };
    document.addEventListener('keydown', escHandler);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null); });
    overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => finish(null)));
    overlay.querySelector('#mod-comment-submit').addEventListener('click', () => {
      const val = overlay.querySelector('#mod-comment').value.trim();
      if (!val) { toast('Please enter a reason', true); return; }
      finish(val);
    });
  });
}

async function viewModerationHistory(project) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-head">
        <div><h2>Moderation History</h2><p>${escapeHtml(project.project_name)}</p></div>
        <button type="button" class="modal-close" data-close>✕</button>
      </div>
      <div class="modal-body"><div class="modal-list" id="mod-history-list"><div class="modal-list-empty">Loading…</div></div></div>
      <div class="modal-footer"><button type="button" class="btn-outline" data-close>Close</button></div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', escHandler); };
  const escHandler = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', escHandler);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));

  const { data, error } = await sb.from('residential_project_moderation_history')
    .select('id,from_status,to_status,action,comment,changed_at')
    .eq('project_id', project.id).order('changed_at', { ascending: false });

  const listEl = overlay.querySelector('#mod-history-list');
  if (error) { listEl.innerHTML = `<div class="modal-list-empty">${escapeHtml(error.message)}</div>`; return; }
  listEl.innerHTML = data.length ? data.map(h => `
    <div class="modal-list-row" style="align-items:flex-start;flex-direction:column;gap:6px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        ${h.from_status ? pill(h.from_status) + ' →' : ''} ${pill(h.to_status)}
        <span style="font-size:11px;color:var(--muted)">${fmtDate(h.changed_at)}</span>
      </div>
      ${h.comment ? `<div style="font-size:12.5px;color:var(--ink-soft)">${escapeHtml(h.comment)}</div>` : ''}
    </div>`).join('') : `<div class="modal-list-empty">No moderation history yet.</div>`;
}

async function runModAction(project, actionKey, reload) {
  const cfg = MOD_ACTIONS[actionKey];
  let comment = null;
  if (cfg.requireComment) {
    comment = await promptComment(cfg.label, project.project_name);
    if (comment === null) return;
  } else if (!(await customConfirm(project.project_name, { title: `${cfg.label}?`, confirmLabel: cfg.label }))) {
    return;
  }

  const payload = { moderation_status: cfg.toStatus };
  if (cfg.setApprovedAt) payload.approved_at = new Date().toISOString();
  if (cfg.setPublishedAt) payload.published_at = new Date().toISOString();

  const { error } = await sb.from('residential_projects').update(payload).eq('id', project.id);
  if (error) { toast(error.message, true); return; }

  await sb.from('residential_project_moderation_history').insert({
    project_id: project.id, from_status: project.moderation_status, to_status: cfg.toStatus,
    action: cfg.action, comment, changed_by: currentUser.id
  });

  toast(cfg.label + ' — done');
  reload();
}

async function moderationPage() {
  let activeTab = 'awaiting';

  async function render() {
    const tabsHtml = `<div class="tab-row">${MOD_TABS.map(t =>
      `<button type="button" class="tab-pill${t.key === activeTab ? ' active' : ''}" data-mod-tab="${t.key}">${t.label}</button>`
    ).join('')}</div>`;
    content.innerHTML = pageHead('Moderation Queue', 'Review, approve and publish projects') + tabsHtml + `<div class="empty">Loading…</div>`;

    const tab = MOD_TABS.find(t => t.key === activeTab);
    let q = sb.from('residential_projects').select('id,project_code,project_name,moderation_status,updated_at').is('deleted_at', null).order('updated_at', { ascending: false }).limit(200);
    if (tab.statuses) q = q.in('moderation_status', tab.statuses);
    const { data, error } = await q;

    const rows = error
      ? emptyRow(4, error.message)
      : (data.length ? data.map(p => {
        const actions = actionKeysForStatus(p.moderation_status).map(key =>
          `<button class="icon-btn" data-mod-action="${key}" data-id="${p.id}" title="${escapeHtml(MOD_ACTIONS[key].label)}">${icon(MOD_ACTIONS[key].icon, 13)}</button>`
        ).join('');
        return `
      <tr>
        <td><div class="proj-name">${escapeHtml(p.project_name)}</div><div class="proj-code">${escapeHtml(p.project_code)}</div></td>
        <td>${pill(p.moderation_status)}</td>
        <td>${fmtDate(p.updated_at)}</td>
        <td><div class="row-actions">
          <button class="icon-btn" data-edit-project="${p.id}" title="Edit">${icon('edit', 13)}</button>
          <button class="icon-btn" data-mod-history="${p.id}" title="History">${icon('history', 13)}</button>
          ${actions}
        </div></td>
      </tr>`;
      }).join('') : emptyRow(4, 'Nothing here.'));

    content.innerHTML = pageHead('Moderation Queue', 'Review, approve and publish projects') + tabsHtml +
      tablePanel(tab.label, '', ['Project', 'Status', 'Updated', 'Actions'], rows);

    const byId = Object.fromEntries((data || []).map(p => [p.id, p]));
    content.querySelectorAll('[data-mod-tab]').forEach(btn => btn.addEventListener('click', () => { activeTab = btn.dataset.modTab; render(); }));
    content.querySelectorAll('[data-mod-action]').forEach(btn => btn.addEventListener('click', () => runModAction(byId[btn.dataset.id], btn.dataset.modAction, render)));
    content.querySelectorAll('[data-mod-history]').forEach(btn => btn.addEventListener('click', () => viewModerationHistory(byId[btn.dataset.modHistory])));
    bindPageStubs();
  }

  await render();
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
  residential: (filter, openAdd) => residentialProjectsPage(content, currentUser, navigate, filter, openAdd),
  commercial: commercialPage,
  developers: developersPage,
  cities: citiesPage,
  agents: agentsPage,
  enquiries: (openId) => enquiriesPage(openId),
  moderation: moderationPage,
  archive: () => archivePage(content, navigate),
  settings: settingsPage,
  profile: profilePage
};

// Every top-level page navigation pushes (or, on first load, replaces) a browser history
// entry, so the phone/browser back button steps back through previously opened pages
// instead of leaving the app entirely. popstate ignores wizard-internal states — those are
// handled by project-form.js's own listener while the project form is open.
async function navigate(page, opts = {}) {
  if (!PAGES[page]) page = 'dashboard';
  document.querySelectorAll('.sb-item[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  closeSidebar();
  window.scrollTo(0, 0);
  if (!opts.fromPopstate) {
    const hash = '#/' + page;
    if (opts.replace) history.replaceState({ page }, '', hash);
    else if (location.hash !== hash) history.pushState({ page }, '', hash);
  }
  await PAGES[page](opts.filter ?? opts.openId, opts.openAdd);
}

window.addEventListener('popstate', (e) => {
  if (isWizardOpen() && handleWizardPopState(e)) return; // fully handled inside the wizard (step change, or a cancelled exit)
  const st = e.state;
  const page = (st && st.page) || location.hash.replace(/^#\//, '') || 'dashboard';
  navigate(page, { fromPopstate: true });
});

function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sidebar-backdrop').classList.remove('open');
}

document.querySelectorAll('.sb-item[data-page]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.page, { openAdd: b.dataset.add === '1' })));
$('#logout-btn').addEventListener('click', async () => { await sb.auth.signOut(); location.replace('./login.html'); });
$('#menu-btn').addEventListener('click', () => {
  $('#sidebar').classList.toggle('open');
  $('#sidebar-backdrop').classList.toggle('open');
});
$('#sidebar-backdrop').addEventListener('click', closeSidebar);

/* ---------------- global search ---------------- */

function initGlobalSearch() {
  const input = $('#tb-search-input');
  const results = $('#tb-search-results');
  if (!input) return;

  let debounceTimer;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (!q) { results.hidden = true; results.innerHTML = ''; return; }
    debounceTimer = setTimeout(() => runGlobalSearch(q), 250);
  });
  input.addEventListener('focus', () => { if (input.value.trim()) results.hidden = false; });
  document.addEventListener('click', (e) => { if (!$('#tb-search-wrap').contains(e.target)) results.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') results.hidden = true; });
}

function searchResultGroup(label, iconName, items) {
  if (!items.length) return '';
  return `<div class="sr-group-label">${escapeHtml(label)}</div>${items.map(it =>
    `<div class="sr-item" data-sr-idx="${it.idx}"><span class="sr-item-icon">${icon(iconName, 14)}</span><div class="sr-item-text"><div class="sr-item-title">${escapeHtml(it.title)}</div><div class="sr-item-sub">${escapeHtml(it.sub)}</div></div></div>`
  ).join('')}`;
}

async function runGlobalSearch(q) {
  const input = $('#tb-search-input');
  const results = $('#tb-search-results');
  results.hidden = false;
  results.innerHTML = `<div class="sr-empty">Searching…</div>`;

  const like = `%${q}%`;
  const [projects, developers, enquiries] = await Promise.all([
    sb.from('residential_projects').select('id,project_name,project_code').is('deleted_at', null).or(`project_name.ilike.${like},project_code.ilike.${like}`).limit(5),
    sb.from('developers').select('id,name').ilike('name', like).limit(5),
    sb.from('residential_enquiries').select('id,contact_person,phone').ilike('contact_person', like).limit(5)
  ]);

  const actions = [];
  const mkItem = (title, sub, action) => { actions.push(action); return { idx: actions.length - 1, title, sub }; };

  const projectItems = (projects.data || []).map(p => mkItem(p.project_name, p.project_code, async () => {
    results.hidden = true; input.value = '';
    openProjectForm(content, currentUser, p.id, () => navigate('residential'));
  }));
  const developerItems = (developers.data || []).map(d => mkItem(d.name, 'Developer', async () => {
    results.hidden = true; input.value = '';
    await navigate('developers');
    openDeveloperForm(d.id);
  }));
  const enquiryItems = (enquiries.data || []).map(e => mkItem(e.contact_person, e.phone, async () => {
    results.hidden = true; input.value = '';
    await navigate('enquiries', { openId: e.id });
  }));

  const html = searchResultGroup('Residential Projects', 'home', projectItems)
    + searchResultGroup('Developers', 'developer', developerItems)
    + searchResultGroup('Enquiries', 'mail', enquiryItems);

  results.innerHTML = html || `<div class="sr-empty">No results for "${escapeHtml(q)}"</div>`;
  results.querySelectorAll('[data-sr-idx]').forEach(el => {
    el.addEventListener('click', () => actions[Number(el.dataset.srIdx)]());
  });
}

/* ---------------- notification panel ---------------- */

function initNotifPanel() {
  const btn = $('#notif-btn');
  const panel = $('#notif-panel');
  if (!btn) return;
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const opening = panel.hidden;
    panel.hidden = !panel.hidden;
    if (opening) await loadNotifPanel();
  });
  document.addEventListener('click', (e) => { if (!panel.hidden && !$('#notif-wrap').contains(e.target)) panel.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') panel.hidden = true; });
}

function notifItem(navKey, id, dotColor, title, sub) {
  return `<div class="notif-item" data-notif-nav="${navKey}"${id ? ` data-notif-id="${id}"` : ''}>
    <span class="notif-item-dot"${dotColor ? ` style="background:${dotColor}"` : ''}></span>
    <div class="notif-item-text"><div class="notif-item-title">${escapeHtml(title)}</div><div class="notif-item-sub">${escapeHtml(sub)}</div></div>
  </div>`;
}

async function loadNotifPanel() {
  const panel = $('#notif-panel');
  panel.innerHTML = `<div class="notif-panel-head">Notifications</div><div class="notif-empty">Loading…</div>`;

  const [{ data: pending }, { data: newEnquiries }] = await Promise.all([
    sb.from('residential_projects').select('id,project_name,moderation_status,updated_at')
      .is('deleted_at', null)
      .in('moderation_status', ['pending_verification', 'under_review', 'resubmitted', 'changes_required'])
      .order('updated_at', { ascending: false }).limit(5),
    sb.from('residential_enquiries').select('id,contact_person,phone,created_at').eq('status', 'new').order('created_at', { ascending: false }).limit(5)
  ]);

  const sections = [];
  if (pending?.length) sections.push(`<div class="notif-section"><div class="notif-section-label">Pending Moderation</div>${
    pending.map(p => notifItem('moderation', null, 'var(--gold)', p.project_name, `${(p.moderation_status || '').replace(/_/g, ' ')} · ${timeAgo(p.updated_at)}`)).join('')
  }</div>`);
  if (newEnquiries?.length) sections.push(`<div class="notif-section"><div class="notif-section-label">New Enquiries</div>${
    newEnquiries.map(e => notifItem('enquiries', e.id, 'var(--blue)', e.contact_person, `${e.phone} · ${timeAgo(e.created_at)}`)).join('')
  }</div>`);

  panel.innerHTML = `<div class="notif-panel-head">Notifications</div>`
    + (sections.length ? sections.join('') : `<div class="notif-empty">You're all caught up.</div>`)
    + `<div class="notif-panel-foot"><button type="button" data-notif-nav="moderation">Moderation Queue</button><button type="button" data-notif-nav="enquiries">All Enquiries</button></div>`;

  panel.querySelectorAll('[data-notif-nav]').forEach(el => {
    el.addEventListener('click', () => {
      panel.hidden = true;
      const id = el.dataset.notifId;
      navigate(el.dataset.notifNav, id ? { openId: id } : {});
    });
  });
}

/* ---------------- boot ---------------- */

if (await guard()) {
  initGlobalSearch();
  initNotifPanel();
  loadSidebarCounts();
  navigate('dashboard', { replace: true });
}

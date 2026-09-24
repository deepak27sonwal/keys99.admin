import { sb } from './supabase-client.js';
import { pageHead, tablePanel, emptyRow, escapeHtml, fmtPrice, fmtDate, pill, toast } from './utils.js';

// The Reports section of the sidebar. Each report loads its own data, renders summary
// cards + a table, and can be exported as CSV or Excel (via the SheetJS CDN script
// loaded in index.html). The tab row at the top lets you switch reports without going
// back to the sidebar.
const IN_MODERATION = ['pending_verification', 'under_review', 'changes_required', 'resubmitted'];

const REPORTS = {
  projects: { label: 'Projects', title: 'Projects Report', subtitle: 'Every active residential project, with status and pricing', load: loadProjectsReport },
  enquiries: { label: 'Enquiries', title: 'Enquiries Report', subtitle: 'Latest 500 enquiries, with conversion at a glance', load: loadEnquiriesReport },
  developers: { label: 'Developers', title: 'Developers Report', subtitle: 'Project counts per developer', load: loadDevelopersReport },
  agents: { label: 'Agents', title: 'Agents Report', subtitle: 'Enquiry load and conversions per agent', load: loadAgentsReport },
  moderation: { label: 'Moderation', title: 'Moderation Report', subtitle: 'Status breakdown and time-in-queue for projects awaiting action', load: loadModerationReport }
};

export async function reportsPage(content, navigate, kind = 'projects') {
  const def = REPORTS[kind] || REPORTS.projects;
  content.innerHTML = pageHead(def.title, def.subtitle) + tabRowHtml(kind) + `<div class="empty">Loading…</div>`;

  const { cards, headers, exportRows, rowsHtml, emptyText } = await def.load();

  const cardsHtml = `<div class="kpi-row">${cards.map(c =>
    `<div class="kpi"><div class="value">${escapeHtml(String(c.value))}</div><div class="label">${escapeHtml(c.label)}</div></div>`
  ).join('')}</div>`;

  const toolbar = `<div class="toolbar"><button type="button" class="btn-outline" id="export-csv">Export CSV</button><button type="button" class="btn-outline" id="export-excel">Export Excel</button></div>`;
  const body = rowsHtml.length ? rowsHtml.join('') : emptyRow(headers.length, emptyText);

  content.innerHTML = pageHead(def.title, def.subtitle) + tabRowHtml(kind) + cardsHtml + tablePanel(def.title, toolbar, headers, body);

  content.querySelectorAll('[data-report-tab]').forEach(btn =>
    btn.addEventListener('click', () => reportsPage(content, navigate, btn.dataset.reportTab)));
  content.querySelector('#export-csv').addEventListener('click', () => exportCSV(`${kind}-report.csv`, headers, exportRows));
  content.querySelector('#export-excel').addEventListener('click', () => exportExcel(`${kind}-report.xlsx`, headers, exportRows));
}

function tabRowHtml(active) {
  return `<div class="tab-row">${Object.entries(REPORTS).map(([key, r]) =>
    `<button type="button" class="tab-pill${key === active ? ' active' : ''}" data-report-tab="${key}">${escapeHtml(r.label)}</button>`
  ).join('')}</div>`;
}

function daysSince(iso) {
  if (!iso) return '—';
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
}

/* ---------------- report data loaders ---------------- */

async function loadProjectsReport() {
  const [{ data }, { count: archivedCount }] = await Promise.all([
    sb.from('residential_projects')
      .select('project_code,project_name,project_type,status,moderation_status,starting_price,price_on_request,created_at,cities(name),localities!residential_projects_locality_id_fkey(name),developers(name)')
      .is('deleted_at', null)
      .order('created_at', { ascending: false }),
    sb.from('residential_projects').select('id', { count: 'exact', head: true }).not('deleted_at', 'is', null)
  ]);
  const rows = data || [];
  const countBy = s => rows.filter(p => p.moderation_status === s).length;

  const cards = [
    { label: 'Total Projects', value: rows.length },
    { label: 'Published', value: countBy('published') },
    { label: 'Draft', value: countBy('draft') },
    { label: 'In Moderation', value: rows.filter(p => IN_MODERATION.includes(p.moderation_status)).length },
    { label: 'Archived', value: archivedCount ?? 0 }
  ];

  const headers = ['Project', 'Code', 'Type', 'Developer', 'City', 'Locality', 'Status', 'Moderation', 'Starting Price', 'Created'];
  const exportRows = rows.map(p => [
    p.project_name, p.project_code, p.project_type || '', p.developers?.name || '', p.cities?.name || '', p.localities?.name || '',
    p.status || '', p.moderation_status || '', p.price_on_request ? 'On request' : (p.starting_price ?? ''), fmtDate(p.created_at)
  ]);
  const rowsHtml = rows.map(p => `<tr>
    <td>${escapeHtml(p.project_name)}</td><td>${escapeHtml(p.project_code)}</td><td>${escapeHtml(p.project_type || '—')}</td>
    <td>${escapeHtml(p.developers?.name || '—')}</td><td>${escapeHtml(p.cities?.name || '—')}</td><td>${escapeHtml(p.localities?.name || '—')}</td>
    <td>${escapeHtml((p.status || '—').replace(/_/g, ' '))}</td><td>${pill(p.moderation_status)}</td>
    <td>${fmtPrice(p.starting_price, p.price_on_request)}</td><td>${fmtDate(p.created_at)}</td>
  </tr>`);

  return { cards, headers, exportRows, rowsHtml, emptyText: 'No projects yet.' };
}

async function loadEnquiriesReport() {
  const { data } = await sb.from('residential_enquiries')
    .select('contact_person,phone,email,enquiry_type,status,source,created_at,residential_projects(project_name)')
    .order('created_at', { ascending: false }).limit(500);
  const rows = data || [];
  const countBy = s => rows.filter(e => e.status === s).length;
  const converted = countBy('converted');

  const cards = [
    { label: 'Total Enquiries', value: rows.length },
    { label: 'New', value: countBy('new') },
    { label: 'Converted', value: converted },
    { label: 'Closed', value: countBy('closed') },
    { label: 'Conversion Rate', value: rows.length ? Math.round(converted / rows.length * 100) + '%' : '0%' }
  ];

  const headers = ['Contact', 'Phone', 'Email', 'Project', 'Type', 'Source', 'Status', 'Date'];
  const exportRows = rows.map(e => [
    e.contact_person, e.phone, e.email || '', e.residential_projects?.project_name || '', e.enquiry_type || '', e.source || '', e.status || '', fmtDate(e.created_at)
  ]);
  const rowsHtml = rows.map(e => `<tr>
    <td>${escapeHtml(e.contact_person)}</td><td>${escapeHtml(e.phone)}</td><td>${escapeHtml(e.email || '—')}</td>
    <td>${escapeHtml(e.residential_projects?.project_name || '—')}</td><td>${escapeHtml((e.enquiry_type || '—').replace(/_/g, ' '))}</td>
    <td>${escapeHtml(e.source || '—')}</td><td>${pill(e.status)}</td><td>${fmtDate(e.created_at)}</td>
  </tr>`);

  return { cards, headers, exportRows, rowsHtml, emptyText: 'No enquiries yet.' };
}

async function loadDevelopersReport() {
  const [{ data: devs }, { data: projects }] = await Promise.all([
    sb.from('developers').select('id,name,verified,status').order('name'),
    sb.from('residential_projects').select('developer_id,moderation_status').is('deleted_at', null)
  ]);
  const devList = devs || [];
  const projList = projects || [];
  const rows = devList.map(d => {
    const own = projList.filter(p => p.developer_id === d.id);
    return { ...d, total: own.length, published: own.filter(p => p.moderation_status === 'published').length, draft: own.filter(p => p.moderation_status === 'draft').length };
  });

  const cards = [
    { label: 'Total Developers', value: devList.length },
    { label: 'Verified', value: devList.filter(d => d.verified).length },
    { label: 'With Projects', value: rows.filter(d => d.total > 0).length },
    { label: 'Total Projects', value: projList.length }
  ];

  const headers = ['Developer', 'Status', 'Verified', 'Total Projects', 'Published', 'Draft'];
  const exportRows = rows.map(d => [d.name, d.status || '', d.verified ? 'Yes' : 'No', d.total, d.published, d.draft]);
  const rowsHtml = rows.map(d => `<tr>
    <td>${escapeHtml(d.name)}</td><td>${pill(d.status)}</td><td>${d.verified ? 'Yes' : 'No'}</td>
    <td>${d.total}</td><td>${d.published}</td><td>${d.draft}</td>
  </tr>`);

  return { cards, headers, exportRows, rowsHtml, emptyText: 'No developers yet.' };
}

async function loadAgentsReport() {
  const [{ data: agentsData }, { data: enquiries }] = await Promise.all([
    sb.from('agents').select('id,full_name,company_name,verified,status').order('full_name'),
    sb.from('residential_enquiries').select('assigned_agent_id,status')
  ]);
  const agentList = agentsData || [];
  const enqList = enquiries || [];
  const rows = agentList.map(a => {
    const assigned = enqList.filter(e => e.assigned_agent_id === a.id);
    return { ...a, assigned: assigned.length, converted: assigned.filter(e => e.status === 'converted').length };
  });

  const cards = [
    { label: 'Total Agents', value: agentList.length },
    { label: 'Verified', value: agentList.filter(a => a.verified).length },
    { label: 'Assigned Enquiries', value: enqList.filter(e => e.assigned_agent_id).length },
    { label: 'Unassigned Enquiries', value: enqList.filter(e => !e.assigned_agent_id).length }
  ];

  const headers = ['Agent', 'Company', 'Status', 'Verified', 'Assigned Enquiries', 'Converted'];
  const exportRows = rows.map(a => [a.full_name, a.company_name || '', a.status || '', a.verified ? 'Yes' : 'No', a.assigned, a.converted]);
  const rowsHtml = rows.map(a => `<tr>
    <td>${escapeHtml(a.full_name)}</td><td>${escapeHtml(a.company_name || '—')}</td><td>${pill(a.status)}</td>
    <td>${a.verified ? 'Yes' : 'No'}</td><td>${a.assigned}</td><td>${a.converted}</td>
  </tr>`);

  return { cards, headers, exportRows, rowsHtml, emptyText: 'No agents yet.' };
}

async function loadModerationReport() {
  const { data } = await sb.from('residential_projects')
    .select('project_code,project_name,moderation_status,submitted_at,updated_at')
    .is('deleted_at', null);
  const rows = data || [];
  const countBy = s => rows.filter(p => p.moderation_status === s).length;

  const cards = ['published', 'pending_verification', 'under_review', 'changes_required', 'resubmitted', 'draft']
    .map(s => ({ label: s.replace(/_/g, ' '), value: countBy(s) }));

  const queue = rows.filter(p => IN_MODERATION.includes(p.moderation_status))
    .sort((a, b) => new Date(a.submitted_at || a.updated_at) - new Date(b.submitted_at || b.updated_at));

  const headers = ['Project', 'Code', 'Moderation Status', 'Submitted', 'Days In Queue'];
  const exportRows = queue.map(p => [p.project_name, p.project_code, p.moderation_status || '', fmtDate(p.submitted_at), daysSince(p.submitted_at)]);
  const rowsHtml = queue.map(p => `<tr>
    <td>${escapeHtml(p.project_name)}</td><td>${escapeHtml(p.project_code)}</td><td>${pill(p.moderation_status)}</td>
    <td>${fmtDate(p.submitted_at)}</td><td>${daysSince(p.submitted_at)}</td>
  </tr>`);

  return { cards, headers, exportRows, rowsHtml, emptyText: 'Nothing in the moderation queue.' };
}

/* ---------------- export ---------------- */

function toCSV(headers, rows) {
  const esc = v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [headers, ...rows].map(r => r.map(esc).join(',')).join('\n');
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportCSV(filename, headers, rows) {
  downloadBlob(filename, new Blob([toCSV(headers, rows)], { type: 'text/csv;charset=utf-8;' }));
}

function exportExcel(filename, headers, rows) {
  if (!window.XLSX) { toast('Excel export library failed to load — try again in a moment', true); return; }
  const ws = window.XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, ws, 'Report');
  window.XLSX.writeFile(wb, filename);
}

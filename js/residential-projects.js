import { sb } from './supabase-client.js';
import { openProjectForm } from './project-form.js';
import { pageHead, emptyRow, pill, fmtPrice, rowActions, bindStubs, confirmArchiveProject, escapeHtml } from './utils.js';
import { enhanceSelects, refreshSelect } from './custom-select.js';
import { projectKind, localityEmbed } from './project-kinds.js';
import { attachProjectThumbs, projectThumbHtml, bindThumbFallbacks } from './project-thumbs.js';

// This page's markup (the panel/toolbar/table shell, plus a <template> for one row) lives
// in residential-projects.html, and its layout-only rules in css/residential-projects.css —
// this file only fetches that markup once, fills it with live data, and wires interactions.
// See residential-projects.html for why it has no <script> tag of its own.

let templateCache = null;
async function loadTemplate() {
  if (templateCache) return templateCache;
  // Versioned like the JS modules (see scripts/stamp-build.sh) so a deploy never pairs new
  // code with a cached template.
  const build = document.querySelector('meta[name="build"]')?.content || '';
  const html = await (await fetch(`./residential-projects.html${build ? `?v=${encodeURIComponent(build)}` : ''}`)).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  templateCache = {
    panelHtml: doc.getElementById('residential-projects-panel').outerHTML,
    rowTemplate: doc.getElementById('residential-row-template').innerHTML.trim()
  };
  return templateCache;
}

const STATUS_LABELS = { draft: 'Draft' };

// content: the app shell's #content element to render into.
// currentUser: the signed-in Supabase user (passed through to the project form).
// navigate: the host app's page-navigation function, called to return to this page
//   ('residential') after the Add/Edit Project wizard closes.
// moderationFilter: optional moderation_status to restrict the list to (e.g. 'draft', from
//   the Dashboard's Draft Projects stat card) — lets an admin find and resume drafts instead
//   of scrolling the full catalog. Cleared by reloading the page without a filter.
// openAdd: when true (from the sidebar's "Add Project" shortcut), opens the Add Project
//   wizard immediately once the list has rendered.
// isSuperAdmin: only super admins can archive a project — a plain admin doesn't get the
//   delete icon in the row actions at all (the server enforces this too; this just keeps
//   the UI from offering an action that would be silently rejected).
// openEditId: reopens the Edit wizard for this project id immediately once the list has
//   rendered — used to restore an in-progress edit after a page refresh (see app.js's boot
//   sequence, which reads this back out of the #/residential/edit/<id> URL the wizard stamps
//   on itself while open).
export function residentialProjectsPage(content, currentUser, navigate, moderationFilter, openAdd, isSuperAdmin, openEditId) {
  return projectsListPage('residential', content, currentUser, navigate, moderationFilter, openAdd, isSuperAdmin, openEditId);
}

export function commercialProjectsPage(content, currentUser, navigate, moderationFilter, openAdd, isSuperAdmin, openEditId) {
  return projectsListPage('commercial', content, currentUser, navigate, moderationFilter, openAdd, isSuperAdmin, openEditId);
}

const PAGE_TEXT = {
  residential: { title: 'Residential Projects', subtitle: 'Manage the residential listing catalog', icon: 'home' },
  commercial: { title: 'Commercial Projects', subtitle: 'Offices, shops, showrooms, warehouses and other commercial listings', icon: 'building' }
};

// Each kind gets its own set of filters (in the Filters bottom sheet). Options are built from the loaded
// projects (with counts), so a dropdown only offers values that actually match something.
// `get` reads the value off a project row; `label` overrides the default title-casing.
const FILTERS = {
  residential: [
    { key: 'project_type', label: 'Project Type', get: p => p.project_type },
    { key: 'status', label: 'Project Status', get: p => p.status },
    { key: 'city', label: 'City', get: p => p.cities?.name, raw: true },
    { key: 'developer', label: 'Developer', get: p => p.developers?.name, raw: true },
    { key: 'moderation_status', label: 'Moderation', get: p => p.moderation_status }
  ],
  commercial: [
    { key: 'project_type', label: 'Property Type', get: p => p.project_type },
    { key: 'transaction_type', label: 'Available For', get: p => p.transaction_type, labels: { sale: 'Sale', lease: 'Lease', sale_and_lease: 'Sale & Lease' } },
    { key: 'status', label: 'Project Status', get: p => p.status },
    { key: 'occupancy_certificate', label: 'OC Status', get: p => p.occupancy_certificate, labels: { received: 'OC Received', applied: 'OC Applied', not_applied: 'OC Not Applied' } },
    { key: 'city', label: 'City', get: p => p.cities?.name, raw: true },
    { key: 'developer', label: 'Developer', get: p => p.developers?.name, raw: true },
    { key: 'moderation_status', label: 'Moderation', get: p => p.moderation_status }
  ]
};
const FILTER_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg>';
const TXN_SHORT = { sale: 'For Sale', lease: 'For Lease', sale_and_lease: 'Sale & Lease' };
const OC_SHORT = { received: 'OC received', applied: 'OC applied', not_applied: 'OC not applied' };
const titleCase = v => String(v).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const filterLabel = (f, v) => f.labels?.[v] || (f.raw ? v : titleCase(v));

// Filter choices survive leaving the page (e.g. opening a project and coming back) for the
// rest of the session, separately per kind.
const savedFilters = { residential: {}, commercial: {} };

// Same page for both kinds — only the table, labels and the wizard's kind differ.
async function projectsListPage(kind, content, currentUser, navigate, moderationFilter, openAdd, isSuperAdmin, openEditId) {
  const K = projectKind(kind);
  const text = PAGE_TEXT[K.key];
  content.innerHTML = pageHead(text.title, text.subtitle) + `<div class="empty">Loading…</div>`;

  const [{ panelHtml, rowTemplate }, { data, error }] = await Promise.all([
    loadTemplate(),
    (() => {
      let q = sb.from(K.tables.project)
        .select(`id,project_code,project_name,project_type,status,moderation_status,starting_price,price_on_request,cities(name),developers(name),${localityEmbed(K.key)}${K.key === 'commercial' ? ',transaction_type,occupancy_certificate' : ''}`)
        .is('deleted_at', null)
        .order('updated_at', { ascending: false }).limit(200);
      if (moderationFilter) q = q.eq('moderation_status', moderationFilter);
      return q.then(async res => {
        if (!res.error && res.data?.length) await attachProjectThumbs(res.data, K.key);
        return res;
      });
    })()
  ]);

  content.innerHTML = pageHead(text.title, text.subtitle) + panelHtml;

  if (moderationFilter) {
    content.querySelector('.panel-head h2').insertAdjacentHTML('afterend',
      `<span class="chip active" style="margin-left:8px">${STATUS_LABELS[moderationFilter] || moderationFilter}<span id="clear-filter" style="cursor:pointer;margin-left:6px">✕</span></span>`);
    content.querySelector('#clear-filter').addEventListener('click', () => projectsListPage(K.key, content, currentUser, navigate, null, false, isSuperAdmin));
  }

  const searchInput = content.querySelector('#project-search-input');
  if (searchInput) searchInput.placeholder = `Search ${K.label.toLowerCase()} projects`;
  if (K.key === 'commercial') content.querySelector('thead th:nth-child(2)').textContent = 'Property Type';

  const tbody = content.querySelector('#residential-projects-rows');
  if (error) {
    tbody.innerHTML = emptyRow(7, error.message);
  } else if (!data.length) {
    tbody.innerHTML = emptyRow(7, moderationFilter ? `No ${(STATUS_LABELS[moderationFilter] || moderationFilter).toLowerCase()} projects.` : `No ${K.label.toLowerCase()} projects yet. Click "+ Add Project" to create the first one.`);
  } else {
    tbody.innerHTML = '';
    const rowProjects = new Map();
    data.forEach(p => {
      const tpl = document.createElement('template');
      tpl.innerHTML = rowTemplate;
      const row = tpl.content.firstElementChild;
      row.dataset.searchText = [p.project_name, p.project_code, p.localities?.name, p.cities?.name, p.developers?.name].filter(Boolean).join(' ').toLowerCase();
      rowProjects.set(row, p);
      row.querySelector('[data-field="icon"]').innerHTML = projectThumbHtml(p._thumb, text.icon);
      row.querySelector('[data-field="project_name"]').textContent = p.project_name;
      row.querySelector('[data-field="project_code"]').textContent = p.project_code;
      row.querySelector('[data-field="project_type"]').textContent = K.key === 'commercial'
        ? [p.project_type ? titleCase(p.project_type) : '—', TXN_SHORT[p.transaction_type]].filter(Boolean).join(' · ')
        : (p.project_type || '—');
      row.querySelector('[data-field="location"]').textContent = `${p.localities?.name || '—'}${p.cities?.name ? ', ' + p.cities.name : ''}`;
      row.querySelector('[data-field="price"]').textContent = fmtPrice(p.starting_price, p.price_on_request);
      row.querySelector('[data-field="status"]').textContent = [(p.status || '—').replace(/_/g, ' '), K.key === 'commercial' ? OC_SHORT[p.occupancy_certificate] : null].filter(Boolean).join(' · ');
      row.querySelector('[data-field="moderation"]').innerHTML = pill(p.moderation_status);
      row.querySelector('[data-field="actions"]').innerHTML = rowActions('project', p.id, p.project_name, isSuperAdmin, K.key);
      tbody.appendChild(row);
    });
    bindThumbFallbacks(tbody);

    const noMatchRow = document.createElement('tr');
    noMatchRow.hidden = true;
    noMatchRow.innerHTML = `<td colspan="7"><div class="empty">No projects match your search or filters.</div></td>`;
    tbody.appendChild(noMatchRow);

    // Filters — this kind's own set of dropdowns, built from the loaded projects. They live
    // in a bottom sheet opened from the toolbar's Filters button; the active ones show as
    // removable chips under the panel head.
    const filters = FILTERS[K.key].filter(f => !(f.key === 'moderation_status' && moderationFilter));
    const chosen = savedFilters[K.key];
    const fieldsHtml = filters.map(f => {
      const counts = new Map();
      data.forEach(p => { const v = f.get(p); if (v) counts.set(v, (counts.get(v) || 0) + 1); });
      if (chosen[f.key] && !counts.has(chosen[f.key])) delete chosen[f.key];
      const opts = [...counts].sort((a, b) => filterLabel(f, a[0]).localeCompare(filterLabel(f, b[0])))
        .map(([v, n]) => `<option value="${escapeHtml(v)}"${chosen[f.key] === v ? ' selected' : ''}>${escapeHtml(filterLabel(f, v))} (${n})</option>`).join('');
      return `<label class="list-filter"><span>${f.label}</span><select data-filter="${f.key}"${counts.size ? '' : ' disabled'}><option value="">All</option>${opts}</select></label>`;
    }).join('');

    const filtersBtn = document.createElement('button');
    filtersBtn.type = 'button';
    filtersBtn.className = 'btn-outline filters-btn';
    filtersBtn.setAttribute('aria-haspopup', 'dialog');
    filtersBtn.innerHTML = `${FILTER_ICON}<span>Filters</span><span class="filters-badge" hidden></span>`;
    content.querySelector('#open-by-developer').before(filtersBtn);

    const summary = document.createElement('div');
    summary.className = 'filter-summary';
    summary.hidden = true;
    content.querySelector('#residential-projects-panel .panel-head').after(summary);

    const sheet = document.createElement('div');
    sheet.className = 'filter-sheet-layer';
    sheet.hidden = true;
    sheet.innerHTML = `
      <div class="filter-sheet-backdrop" data-close-sheet></div>
      <div class="filter-sheet" role="dialog" aria-modal="true" aria-labelledby="filter-sheet-title">
        <div class="filter-sheet-grip"></div>
        <div class="filter-sheet-head">
          <h2 id="filter-sheet-title">Filter ${K.label} Projects</h2>
          <button type="button" class="modal-close" data-close-sheet aria-label="Close">✕</button>
        </div>
        <div class="filter-sheet-body">${fieldsHtml}</div>
        <div class="filter-sheet-foot">
          <button type="button" class="btn-outline" id="sheet-clear">Clear all</button>
          <button type="button" class="btn-primary" id="sheet-apply" data-close-sheet></button>
        </div>
      </div>`;
    content.appendChild(sheet);

    const openSheet = () => {
      sheet.hidden = false;
      requestAnimationFrame(() => requestAnimationFrame(() => sheet.classList.add('open')));
      document.addEventListener('keydown', escClose);
      sheet.querySelector('select:not(:disabled)')?.focus({ preventScroll: true });
    };
    const closeSheet = () => {
      if (!sheet.classList.contains('open')) return;
      sheet.classList.remove('open');
      document.removeEventListener('keydown', escClose);
      setTimeout(() => { if (!sheet.classList.contains('open')) sheet.hidden = true; }, 260);
      filtersBtn.focus({ preventScroll: true });
    };
    const escClose = (e) => { if (e.key === 'Escape') closeSheet(); };
    filtersBtn.addEventListener('click', openSheet);
    sheet.querySelectorAll('[data-close-sheet]').forEach(el => el.addEventListener('click', closeSheet));

    const applyFilters = () => {
      const q = (searchInput?.value || '').trim().toLowerCase();
      const active = filters.filter(f => chosen[f.key]);
      let shown = 0;
      tbody.querySelectorAll('tr[data-search-text]').forEach(row => {
        const p = rowProjects.get(row);
        const match = (!q || row.dataset.searchText.includes(q)) && active.every(f => f.get(p) === chosen[f.key]);
        row.hidden = !match;
        if (match) shown++;
      });
      noMatchRow.hidden = shown > 0;

      const badge = filtersBtn.querySelector('.filters-badge');
      badge.hidden = !active.length;
      badge.textContent = active.length;
      filtersBtn.classList.toggle('active', active.length > 0);
      sheet.querySelector('#sheet-apply').textContent = `Show ${shown} project${shown === 1 ? '' : 's'}`;
      sheet.querySelector('#sheet-clear').disabled = !active.length;
      sheet.querySelectorAll('select[data-filter]').forEach(sel => sel.classList.toggle('active', !!sel.value));

      summary.hidden = !active.length && !q;
      summary.innerHTML = active.map(f => `<span class="chip active filter-chip">${escapeHtml(f.label)}: ${escapeHtml(filterLabel(f, chosen[f.key]))}<button type="button" data-remove-filter="${f.key}" aria-label="Remove ${escapeHtml(f.label)} filter">✕</button></span>`).join('') +
        `<span class="filter-summary-count">Showing ${shown} of ${data.length}</span><button type="button" class="panel-link" data-clear-all>Clear all</button>`;
    };
    const setFilter = (key, value) => {
      if (value) chosen[key] = value; else delete chosen[key];
      const sel = sheet.querySelector(`select[data-filter="${key}"]`);
      if (sel) sel.value = value || '';
      applyFilters();
    };
    const clearAll = (alsoSearch) => {
      Object.keys(chosen).forEach(k => setFilter(k, ''));
      if (alsoSearch && searchInput) searchInput.value = '';
      applyFilters();
    };
    sheet.querySelectorAll('select[data-filter]').forEach(sel => sel.addEventListener('change', () => setFilter(sel.dataset.filter, sel.value)));
    sheet.querySelector('#sheet-clear').addEventListener('click', () => clearAll(false));
    summary.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-remove-filter]');
      if (rm) setFilter(rm.dataset.removeFilter, '');
      else if (e.target.closest('[data-clear-all]')) clearAll(true);
    });
    searchInput?.addEventListener('input', applyFilters);
    applyFilters();
  }

  const openWizard = (projectId) => openProjectForm(content, currentUser, projectId, () => navigate(K.routeBase), undefined, K.key);
  content.querySelector('#add-project')?.addEventListener('click', () => openWizard(null));
  content.querySelector('#open-by-developer')?.addEventListener('click', () => openDeveloperProjectPicker(openWizard, K));
  bindStubs(content, {
    onEditProject: openWizard,
    onDeleteProject: (id, name) => confirmArchiveProject(id, name, currentUser.id, () => projectsListPage(K.key, content, currentUser, navigate, moderationFilter, false, isSuperAdmin), K.key)
  });

  if (openAdd) openWizard(null);
  else if (openEditId) openWizard(openEditId);
}

// Lets an admin jump straight to editing a project by first picking its Developer, instead
// of scrolling/searching the full catalog — both dropdowns are searchable (via
// custom-select.js, auto-enabled once a list has more than a handful of options). The
// Project dropdown stays empty/disabled until a Developer is chosen, then lists only that
// developer's projects.
async function openDeveloperProjectPicker(openWizard, K) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box" style="max-width:420px">
      <div class="modal-head">
        <div><h2>Open Project by Developer</h2></div>
        <button type="button" class="modal-close" data-cancel>✕</button>
      </div>
      <div class="modal-body">
        <div class="form-grid">
          <div class="field full">
            <label>Developer</label>
            <select id="dp-developer"><option value="">Select a developer…</option></select>
          </div>
          <div class="field full">
            <label>Project Name</label>
            <select id="dp-project" disabled><option value="">Select a developer first…</option></select>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn-outline" data-cancel>Cancel</button>
        <button type="button" class="btn-primary" id="dp-open" disabled>Open</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => { overlay.remove(); document.removeEventListener('keydown', escHandler); };
  const escHandler = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', escHandler);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', close));

  const devSelect = overlay.querySelector('#dp-developer');
  const projectSelect = overlay.querySelector('#dp-project');
  const openBtn = overlay.querySelector('#dp-open');

  const { data: developers } = await sb.from('developers').select('id,name').order('name');
  devSelect.innerHTML = '<option value="">Select a developer…</option>' +
    (developers || []).map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join('');
  enhanceSelects(overlay);

  devSelect.addEventListener('change', async () => {
    const developerId = devSelect.value;
    projectSelect.disabled = true;
    openBtn.disabled = true;
    if (!developerId) {
      projectSelect.innerHTML = '<option value="">Select a developer first…</option>';
      refreshSelect(projectSelect);
      return;
    }
    projectSelect.innerHTML = '<option value="">Loading…</option>';
    refreshSelect(projectSelect);
    const { data: projects } = await sb.from(K.tables.project)
      .select('id,project_name').eq('developer_id', developerId).is('deleted_at', null).order('project_name');
    if (!projects || !projects.length) {
      projectSelect.innerHTML = '<option value="">No projects for this developer</option>';
    } else {
      projectSelect.innerHTML = '<option value="">Select a project…</option>' +
        projects.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.project_name)}</option>`).join('');
      projectSelect.disabled = false;
    }
    refreshSelect(projectSelect);
  });

  projectSelect.addEventListener('change', () => { openBtn.disabled = !projectSelect.value; });

  openBtn.addEventListener('click', () => {
    const projectId = projectSelect.value;
    if (!projectId) return;
    close();
    openWizard(projectId);
  });
}

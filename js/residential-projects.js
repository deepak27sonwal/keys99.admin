import { sb } from './supabase-client.js';
import { openProjectForm } from './project-form.js';
import { pageHead, emptyRow, icon, pill, fmtPrice, rowActions, bindStubs, confirmArchiveProject, escapeHtml } from './utils.js';
import { enhanceSelects, refreshSelect } from './custom-select.js';
import { projectKind, localityEmbed } from './project-kinds.js';

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

// Same page for both kinds — only the table, labels and the wizard's kind differ.
async function projectsListPage(kind, content, currentUser, navigate, moderationFilter, openAdd, isSuperAdmin, openEditId) {
  const K = projectKind(kind);
  const text = PAGE_TEXT[K.key];
  content.innerHTML = pageHead(text.title, text.subtitle) + `<div class="empty">Loading…</div>`;

  const [{ panelHtml, rowTemplate }, { data, error }] = await Promise.all([
    loadTemplate(),
    (() => {
      let q = sb.from(K.tables.project)
        .select(`id,project_code,project_name,project_type,status,moderation_status,starting_price,price_on_request,cities(name),${localityEmbed(K.key)}`)
        .is('deleted_at', null)
        .order('updated_at', { ascending: false }).limit(200);
      if (moderationFilter) q = q.eq('moderation_status', moderationFilter);
      return q;
    })()
  ]);

  content.innerHTML = pageHead(text.title, text.subtitle) + panelHtml;

  if (moderationFilter) {
    content.querySelector('.panel-head h2').insertAdjacentHTML('afterend',
      `<span class="chip active" style="margin-left:8px">${STATUS_LABELS[moderationFilter] || moderationFilter}<span id="clear-filter" style="cursor:pointer;margin-left:6px">✕</span></span>`);
    content.querySelector('#clear-filter').addEventListener('click', () => projectsListPage(K.key, content, currentUser, navigate, null, false, isSuperAdmin));
  }

  const tbody = content.querySelector('#residential-projects-rows');
  if (error) {
    tbody.innerHTML = emptyRow(7, error.message);
  } else if (!data.length) {
    tbody.innerHTML = emptyRow(7, moderationFilter ? `No ${(STATUS_LABELS[moderationFilter] || moderationFilter).toLowerCase()} projects.` : `No ${K.label.toLowerCase()} projects yet. Click "+ Add Project" to create the first one.`);
  } else {
    tbody.innerHTML = '';
    data.forEach(p => {
      const tpl = document.createElement('template');
      tpl.innerHTML = rowTemplate;
      const row = tpl.content.firstElementChild;
      row.dataset.searchText = `${p.project_name} ${p.project_code}`.toLowerCase();
      row.querySelector('[data-field="icon"]').innerHTML = icon(text.icon, 16);
      row.querySelector('[data-field="project_name"]').textContent = p.project_name;
      row.querySelector('[data-field="project_code"]').textContent = p.project_code;
      row.querySelector('[data-field="project_type"]').textContent = K.key === 'commercial' ? (p.project_type || '—').replace(/_/g, ' ') : (p.project_type || '—');
      row.querySelector('[data-field="location"]').textContent = `${p.localities?.name || '—'}${p.cities?.name ? ', ' + p.cities.name : ''}`;
      row.querySelector('[data-field="price"]').textContent = fmtPrice(p.starting_price, p.price_on_request);
      row.querySelector('[data-field="status"]').textContent = (p.status || '—').replace(/_/g, ' ');
      row.querySelector('[data-field="moderation"]').innerHTML = pill(p.moderation_status);
      row.querySelector('[data-field="actions"]').innerHTML = rowActions('project', p.id, p.project_name, isSuperAdmin, K.key);
      tbody.appendChild(row);
    });

    const noMatchRow = document.createElement('tr');
    noMatchRow.hidden = true;
    noMatchRow.innerHTML = `<td colspan="7"><div class="empty">No projects match your search.</div></td>`;
    tbody.appendChild(noMatchRow);

    const searchInput = content.querySelector('#project-search-input');
    searchInput?.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      let anyVisible = false;
      tbody.querySelectorAll('tr[data-search-text]').forEach(row => {
        const match = !q || row.dataset.searchText.includes(q);
        row.hidden = !match;
        if (match) anyVisible = true;
      });
      noMatchRow.hidden = anyVisible || !q;
    });
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

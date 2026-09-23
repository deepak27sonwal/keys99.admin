import { sb } from './supabase-client.js';
import { openProjectForm } from './project-form.js';
import { pageHead, emptyRow, icon, pill, fmtPrice, rowActions, bindStubs } from './utils.js';

// This page's markup (the panel/toolbar/table shell, plus a <template> for one row) lives
// in residential-projects.html, and its layout-only rules in css/residential-projects.css —
// this file only fetches that markup once, fills it with live data, and wires interactions.
// See residential-projects.html for why it has no <script> tag of its own.

let templateCache = null;
async function loadTemplate() {
  if (templateCache) return templateCache;
  const html = await (await fetch('./residential-projects.html')).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');
  templateCache = {
    panelHtml: doc.getElementById('residential-projects-panel').outerHTML,
    rowTemplate: doc.getElementById('residential-row-template').innerHTML.trim()
  };
  return templateCache;
}

// content: the app shell's #content element to render into.
// currentUser: the signed-in Supabase user (passed through to the project form).
// navigate: the host app's page-navigation function, called to return to this page
//   ('residential') after the Add/Edit Project wizard closes.
export async function residentialProjectsPage(content, currentUser, navigate) {
  content.innerHTML = pageHead('Residential Projects', 'Manage the residential listing catalog') + `<div class="empty">Loading…</div>`;

  const [{ panelHtml, rowTemplate }, { data, error }] = await Promise.all([
    loadTemplate(),
    sb.from('residential_projects')
      .select('id,project_code,project_name,project_type,status,moderation_status,starting_price,price_on_request,cities(name),localities(name)')
      .order('updated_at', { ascending: false }).limit(200)
  ]);

  content.innerHTML = pageHead('Residential Projects', 'Manage the residential listing catalog') + panelHtml;

  const tbody = content.querySelector('#residential-projects-rows');
  if (error) {
    tbody.innerHTML = emptyRow(7, error.message);
  } else if (!data.length) {
    tbody.innerHTML = emptyRow(7, 'No residential projects yet. Click "+ Add Project" to create the first one.');
  } else {
    tbody.innerHTML = '';
    data.forEach(p => {
      const tpl = document.createElement('template');
      tpl.innerHTML = rowTemplate;
      const row = tpl.content.firstElementChild;
      row.querySelector('[data-field="icon"]').innerHTML = icon('home', 16);
      row.querySelector('[data-field="project_name"]').textContent = p.project_name;
      row.querySelector('[data-field="project_code"]').textContent = p.project_code;
      row.querySelector('[data-field="project_type"]').textContent = p.project_type || '—';
      row.querySelector('[data-field="location"]').textContent = `${p.localities?.name || '—'}${p.cities?.name ? ', ' + p.cities.name : ''}`;
      row.querySelector('[data-field="price"]').textContent = fmtPrice(p.starting_price, p.price_on_request);
      row.querySelector('[data-field="status"]').textContent = (p.status || '—').replace(/_/g, ' ');
      row.querySelector('[data-field="moderation"]').innerHTML = pill(p.moderation_status);
      row.querySelector('[data-field="actions"]').innerHTML = rowActions('project', p.id);
      tbody.appendChild(row);
    });
  }

  const openWizard = (projectId) => openProjectForm(content, currentUser, projectId, () => navigate('residential'));
  content.querySelector('#add-project')?.addEventListener('click', () => openWizard(null));
  bindStubs(content, { onEditProject: openWizard });
}

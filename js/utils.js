import { sb } from './supabase-client.js';
import { projectKind } from './project-kinds.js';

// Shared formatting, table/panel-markup and row-action helpers used across every admin
// page (Dashboard, Residential Projects, Developers, Agents, Cities, Enquiries,
// Moderation). Kept in one place so pages that live in their own files (like
// residential-projects.js) don't have to redeclare them.

export function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function pill(status) {
  const cls = String(status || '').toLowerCase();
  const label = status ? String(status).replace(/_/g, ' ') : '—';
  return `<span class="pill ${cls}">${escapeHtml(label)}</span>`;
}

export function fmtPrice(value, priceOnRequest) {
  if (priceOnRequest) return 'Price on request';
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(n % 1e7 === 0 ? 0 : 2)} Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(n % 1e5 === 0 ? 0 : 2)} L`;
  return `₹${n.toLocaleString('en-IN')}`;
}

const NUM_ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const NUM_TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigitWords(n) {
  if (n < 20) return NUM_ONES[n];
  const t = Math.floor(n / 10), o = n % 10;
  return NUM_TENS[t] + (o ? ` ${NUM_ONES[o]}` : '');
}
function threeDigitWords(n) {
  const h = Math.floor(n / 100), rest = n % 100;
  const parts = [];
  if (h) parts.push(`${NUM_ONES[h]} Hundred`);
  if (rest) parts.push(twoDigitWords(rest));
  return parts.join(' ');
}

// Converts a rupee amount into Indian-numbering words (Crore/Lakh/Thousand), e.g.
// 2500000 -> "Twenty Five Lakh", 12345678 -> "One Crore Twenty Three Lakh Forty Five
// Thousand Six Hundred Seventy Eight". Used for the human-facing "spelled out" price
// display, as an alternative to fmtPrice()'s abbreviated "₹25 L" form.
export function numberToIndianWords(value) {
  let n = Math.round(Number(value) || 0);
  if (n === 0) return 'Zero';
  const negative = n < 0;
  n = Math.abs(n);
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1e3); n %= 1e3;
  const rest = n;
  const parts = [];
  if (crore) parts.push(`${threeDigitWords(crore)} Crore`);
  if (lakh) parts.push(`${twoDigitWords(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigitWords(thousand)} Thousand`);
  if (rest) parts.push(threeDigitWords(rest));
  return (negative ? 'Minus ' : '') + parts.join(' ');
}

export function fmtPriceWords(value, priceOnRequest) {
  if (priceOnRequest) return 'Price on request';
  if (value === null || value === undefined || value === '') return '—';
  return `₹ ${numberToIndianWords(value)}`;
}

export function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function timeAgo(iso) {
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

export async function count(table, modifier) {
  let q = sb.from(table).select('*', { count: 'exact', head: true });
  if (modifier) q = modifier(q);
  const { count: c, error } = await q;
  if (error) { console.error(table, error); return 0; }
  return c ?? 0;
}

export function initials(text) {
  const base = (text || 'Admin').includes('@') ? text.split('@')[0] : (text || 'Admin');
  const parts = base.replace(/[._-]+/g, ' ').trim().split(/\s+/);
  const a = parts[0]?.[0] || 'A';
  const b = parts[1]?.[0] || parts[0]?.[1] || '';
  return (a + b).toUpperCase();
}

export function pageHead(title, subtitle) {
  return `<div class="page-head"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle || '')}</p></div>`;
}

export function tablePanel(title, toolbarHtml, headers, bodyHtml, footerHtml) {
  return `<div class="panel">
    <div class="panel-head"><h2>${escapeHtml(title)}</h2>${toolbarHtml || ''}</div>
    <div class="table-wrap"><table><thead><tr>${headers.map(h => '<th>' + h + '</th>').join('')}</tr></thead>
    <tbody>${bodyHtml}</tbody></table></div>
  </div>${footerHtml || ''}`;
}

export function emptyRow(colspan, text) {
  return `<tr><td colspan="${colspan}"><div class="empty">${escapeHtml(text)}</div></td></tr>`;
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
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.6 1H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.6 1Z"/>',
  pin: '<path d="M12 22s7-7.5 7-13a7 7 0 1 0-14 0c0 5.5 7 13 7 13Z"/><circle cx="12" cy="9" r="2.5"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  archive: '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 13h4"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3.5 2"/>',
  plus: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'
};

export function icon(name, size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
}

const ENTITY_KINDS = ['developer', 'agent', 'city', 'relationship_manager'];

// projectKind ('residential' | 'commercial') only applies to kind === 'project' — it's
// carried on the buttons so bindStubs() can hand it back to the edit/archive callbacks.
export function rowActions(kind, id, name, canDelete = true, projectKind = 'residential') {
  if (kind === 'project') {
    const pk = `data-project-kind="${escapeHtml(projectKind)}"`;
    const del = canDelete ? `<button class="icon-btn danger" data-delete-project="${id}" ${pk} data-project-name="${escapeHtml(name || '')}">${icon('trash', 13)}</button>` : '';
    return `<div class="row-actions">
      <button class="icon-btn" data-edit-project="${id}" ${pk}>${icon('edit', 13)}</button>
      <button class="icon-btn" data-edit-project="${id}" ${pk}>${icon('eye', 13)}</button>
      ${del}
    </div>`;
  }
  if (ENTITY_KINDS.includes(kind)) {
    // A developer has no projects of its own to list here — creating one means handing off
    // to the Add Project wizard with this developer already picked, not an inline add like
    // Edit/Delete.
    const addProject = kind === 'developer' ? `<button class="icon-btn" data-add-project-for="${id}" title="Add Project">${icon('plus', 13)}</button>` : '';
    return `<div class="row-actions">
      ${addProject}
      <button class="icon-btn" data-edit-entity="${kind}:${id}">${icon('edit', 13)}</button>
      <button class="icon-btn danger" data-delete-entity="${kind}:${id}">${icon('trash', 13)}</button>
    </div>`;
  }
  return `<div class="row-actions">
    <button class="icon-btn" data-stub="edit" data-kind="${kind}">${icon('edit', 13)}</button>
    <button class="icon-btn" data-stub="view" data-kind="${kind}">${icon('eye', 13)}</button>
    <button class="icon-btn danger" data-stub="delete" data-kind="${kind}">${icon('trash', 13)}</button>
  </div>`;
}

// Wires the placeholder "coming soon" alert for [data-stub] actions, and — when the
// matching opts.* callback is given — the real edit/archive paths for [data-edit-project]/
// [data-delete-project] (rowActions('project', id, name)) and [data-edit-entity]/
// [data-delete-entity] (rowActions('developer'|'agent'|'city', id)) buttons.
export function bindStubs(content, opts = {}) {
  content.querySelectorAll('[data-stub]').forEach(btn => {
    btn.addEventListener('click', () => {
      customAlert('The full editor for this section is coming soon — it will be built next, mapped directly to the Supabase schema.');
    });
  });
  if (opts.onEditProject) {
    content.querySelectorAll('[data-edit-project]').forEach(btn => {
      btn.addEventListener('click', () => opts.onEditProject(btn.dataset.editProject, btn.dataset.projectKind || 'residential'));
    });
  }
  if (opts.onDeleteProject) {
    content.querySelectorAll('[data-delete-project]').forEach(btn => {
      btn.addEventListener('click', () => opts.onDeleteProject(btn.dataset.deleteProject, btn.dataset.projectName, btn.dataset.projectKind || 'residential'));
    });
  }
  if (opts.onEditEntity) {
    content.querySelectorAll('[data-edit-entity]').forEach(btn => {
      const [kind, id] = btn.dataset.editEntity.split(':');
      btn.addEventListener('click', () => opts.onEditEntity(kind, id));
    });
  }
  if (opts.onDeleteEntity) {
    content.querySelectorAll('[data-delete-entity]').forEach(btn => {
      const [kind, id] = btn.dataset.deleteEntity.split(':');
      btn.addEventListener('click', () => opts.onDeleteEntity(kind, id));
    });
  }
}

// Soft-deletes a project (sets deleted_at/deleted_by instead of removing the row) so it
// drops out of every normal listing but can be brought back from the Archive section.
// Shared by both project lists and the Dashboard's recent-projects table.
export async function confirmArchiveProject(id, name, userId, onArchived, kind = 'residential') {
  const ok = await customConfirm(
    `"${name || 'This project'}" will be moved to Archive and hidden from listings. You can restore it anytime from the Archive section.`,
    { title: 'Archive this project?', confirmLabel: 'Archive', danger: true }
  );
  if (!ok) return;
  const { error } = await sb.from(projectKind(kind).tables.project)
    .update({ deleted_at: new Date().toISOString(), deleted_by: userId ?? null })
    .eq('id', id);
  if (error) { toast(error.message, true); return; }
  toast('Project archived');
  onArchived && onArchived();
}

export function toast(msg, isError) {
  const t = document.createElement('div');
  t.className = 'toast' + (isError ? ' error' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

// Custom-styled replacements for the browser's native alert()/confirm(), matching the rest
// of the app's modal look instead of the OS dialog box. Both resolve once the person
// responds — customAlert() always resolves, customConfirm() resolves true/false.
export function customAlert(message, opts = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box" style="max-width:400px">
        ${opts.title ? `<div class="modal-head"><div><h2>${escapeHtml(opts.title)}</h2></div><button type="button" class="modal-close" data-ok>✕</button></div>` : ''}
        <div class="modal-body"><p class="confirm-message">${escapeHtml(message)}</p></div>
        <div class="modal-footer"><button type="button" class="btn-primary" data-ok>${escapeHtml(opts.okLabel || 'OK')}</button></div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => { overlay.remove(); document.removeEventListener('keydown', escHandler); resolve(); };
    const escHandler = (e) => { if (e.key === 'Escape' || e.key === 'Enter') close(); };
    document.addEventListener('keydown', escHandler);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.querySelectorAll('[data-ok]').forEach(b => b.addEventListener('click', close));
  });
}

export function customConfirm(message, opts = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box" style="max-width:420px">
        <div class="modal-head">
          <div><h2>${escapeHtml(opts.title || 'Are you sure?')}</h2></div>
          <button type="button" class="modal-close" data-cancel>✕</button>
        </div>
        <div class="modal-body"><p class="confirm-message">${escapeHtml(message)}</p></div>
        <div class="modal-footer">
          <button type="button" class="btn-outline" data-cancel>${escapeHtml(opts.cancelLabel || 'Cancel')}</button>
          <button type="button" class="btn-primary${opts.danger ? ' danger' : ''}" data-confirm>${escapeHtml(opts.confirmLabel || 'Confirm')}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const finish = (val) => { overlay.remove(); document.removeEventListener('keydown', escHandler); resolve(val); };
    const escHandler = (e) => { if (e.key === 'Escape') finish(false); };
    document.addEventListener('keydown', escHandler);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); });
    overlay.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', () => finish(false)));
    overlay.querySelector('[data-confirm]').addEventListener('click', () => finish(true));
  });
}

// Asks which kind of project to create (for the shared "Add Project" entry points — the
// sidebar shortcut and a developer row's Add Project action). Resolves 'residential',
// 'commercial', or null if dismissed.
export function chooseProjectKind() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box" style="max-width:420px">
        <div class="modal-head">
          <div><h2>Add Project</h2><p>What kind of project is this?</p></div>
          <button type="button" class="modal-close" data-cancel>✕</button>
        </div>
        <div class="modal-body">
          <div class="kind-choice">
            <button type="button" class="kind-choice-btn" data-kind="residential">${icon('home', 22)}<b>Residential</b><span>Apartments, villas, plots</span></button>
            <button type="button" class="kind-choice-btn" data-kind="commercial">${icon('building', 22)}<b>Commercial</b><span>Offices, shops, warehouses</span></button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const finish = (val) => { overlay.remove(); document.removeEventListener('keydown', escHandler); resolve(val); };
    const escHandler = (e) => { if (e.key === 'Escape') finish(null); };
    document.addEventListener('keydown', escHandler);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null); });
    overlay.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', () => finish(null)));
    overlay.querySelectorAll('[data-kind]').forEach(b => b.addEventListener('click', () => finish(b.dataset.kind)));
  });
}

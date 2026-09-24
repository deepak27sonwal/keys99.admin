import { sb } from './supabase-client.js';
import { pageHead, tablePanel, emptyRow, icon, escapeHtml, fmtDate, toast, customConfirm } from './utils.js';

// Archived (soft-deleted) residential projects — the "Delete" action on the Residential
// Projects list and the Dashboard's recent-projects table sets deleted_at instead of
// removing the row, so a mistaken delete can be undone here. Restoring puts the project
// straight back live (moderation_status: 'published'), skipping the moderation queue,
// since only already-live projects are expected to go through Archive. Permanent delete
// is a separate, explicit action since it cascades to the project's enquiries, media, etc.
export async function archivePage(content, navigate) {
  content.innerHTML = pageHead('Archive', 'Projects removed from the live listings — restore or permanently delete them') + `<div class="empty">Loading…</div>`;

  const { data, error } = await sb.from('residential_projects')
    .select('id,project_code,project_name,project_type,cities(name),localities!residential_projects_locality_id_fkey(name),deleted_at')
    .not('deleted_at', 'is', null)
    .order('deleted_at', { ascending: false }).limit(200);

  const rows = error
    ? emptyRow(4, error.message)
    : (data.length ? data.map(p => `
      <tr>
        <td><div class="proj-name">${escapeHtml(p.project_name)}</div><div class="proj-code">${escapeHtml(p.project_code)}</div></td>
        <td>${escapeHtml(p.project_type || '—')}</td>
        <td>${escapeHtml(p.localities?.name || '—')}${p.cities?.name ? ', ' + escapeHtml(p.cities.name) : ''}</td>
        <td>${fmtDate(p.deleted_at)}</td>
        <td><div class="row-actions">
          <button class="icon-btn" data-restore="${p.id}" data-name="${escapeHtml(p.project_name)}" title="Restore">${icon('refresh', 13)}</button>
          <button class="icon-btn danger" data-purge="${p.id}" data-name="${escapeHtml(p.project_name)}" title="Delete permanently">${icon('trash', 13)}</button>
        </div></td>
      </tr>`).join('') : emptyRow(4, 'Nothing archived. Projects you delete from the Residential Projects list show up here first.'));

  content.innerHTML = pageHead('Archive', 'Projects removed from the live listings — restore or permanently delete them') +
    tablePanel('Archived Projects', '', ['Project', 'Type', 'Location', 'Archived', 'Actions'], rows);

  content.querySelectorAll('[data-restore]').forEach(btn => btn.addEventListener('click', () => restore(btn.dataset.restore, btn.dataset.name)));
  content.querySelectorAll('[data-purge]').forEach(btn => btn.addEventListener('click', () => purge(btn.dataset.purge, btn.dataset.name)));

  async function restore(id, name) {
    const { error } = await sb.from('residential_projects')
      .update({ deleted_at: null, deleted_by: null, moderation_status: 'published', published_at: new Date().toISOString() })
      .eq('id', id);
    if (error) { toast(error.message, true); return; }
    toast(`"${name}" restored and published`);
    archivePage(content, navigate);
  }

  async function purge(id, name) {
    const ok = await customConfirm(
      `"${name}" and everything attached to it — media, floor plans, enquiries, moderation history — will be permanently deleted. This cannot be undone.`,
      { title: 'Delete permanently?', confirmLabel: 'Delete permanently', danger: true }
    );
    if (!ok) return;
    const { error } = await sb.from('residential_projects').delete().eq('id', id);
    if (error) { toast(error.message, true); return; }
    toast(`"${name}" permanently deleted`);
    archivePage(content, navigate);
  }
}

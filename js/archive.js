import { sb } from './supabase-client.js';
import { pageHead, tablePanel, emptyRow, icon, escapeHtml, fmtDate, toast, customConfirm } from './utils.js';
import { projectKind, queryAllKinds, localityEmbed, kindPill } from './project-kinds.js';

// Archived (soft-deleted) projects of both kinds — the "Delete" action on the project lists
// and the Dashboard's recent-projects table sets deleted_at instead of removing the row, so a
// mistaken delete can be undone here. Restoring puts the project straight back live
// (moderation_status: 'published'), skipping the moderation queue, since only already-live
// projects are expected to go through Archive. Permanent delete is a separate, explicit
// action since it cascades to the project's enquiries, media, etc.
export async function archivePage(content, navigate, isSuperAdmin) {
  if (!isSuperAdmin) {
    content.innerHTML = pageHead('Archive', 'Projects removed from the live listings') +
      `<div class="empty">Archive is restricted to super admins.</div>`;
    return;
  }
  content.innerHTML = pageHead('Archive', 'Projects removed from the live listings — restore or permanently delete them') + `<div class="empty">Loading…</div>`;

  const { data, error } = await queryAllKinds(K => sb.from(K.tables.project)
    .select(`id,project_code,project_name,project_type,cities(name),${localityEmbed(K.key)},deleted_at`)
    .not('deleted_at', 'is', null)
    .order('deleted_at', { ascending: false }).limit(200));
  data.sort((a, b) => new Date(b.deleted_at) - new Date(a.deleted_at));

  const rows = error
    ? emptyRow(6, error.message)
    : (data.length ? data.map(p => `
      <tr>
        <td><div class="proj-name">${escapeHtml(p.project_name)}</div><div class="proj-code">${escapeHtml(p.project_code)}</div></td>
        <td>${kindPill(p._kind)}</td>
        <td>${escapeHtml((p.project_type || '—').replace(/_/g, ' '))}</td>
        <td>${escapeHtml(p.localities?.name || '—')}${p.cities?.name ? ', ' + escapeHtml(p.cities.name) : ''}</td>
        <td>${fmtDate(p.deleted_at)}</td>
        <td><div class="row-actions">
          <button class="icon-btn" data-restore="${p.id}" data-kind="${p._kind}" data-name="${escapeHtml(p.project_name)}" title="Restore">${icon('refresh', 13)}</button>
          <button class="icon-btn danger" data-purge="${p.id}" data-kind="${p._kind}" data-name="${escapeHtml(p.project_name)}" title="Delete permanently">${icon('trash', 13)}</button>
        </div></td>
      </tr>`).join('') : emptyRow(6, 'Nothing archived. Projects you delete from the project lists show up here first.'));

  content.innerHTML = pageHead('Archive', 'Projects removed from the live listings — restore or permanently delete them') +
    tablePanel('Archived Projects', '', ['Project', 'Kind', 'Type', 'Location', 'Archived', 'Actions'], rows);

  content.querySelectorAll('[data-restore]').forEach(btn => btn.addEventListener('click', () => restore(btn.dataset.restore, btn.dataset.name, btn.dataset.kind)));
  content.querySelectorAll('[data-purge]').forEach(btn => btn.addEventListener('click', () => purge(btn.dataset.purge, btn.dataset.name, btn.dataset.kind)));

  async function restore(id, name, kind) {
    const { error } = await sb.from(projectKind(kind).tables.project)
      .update({ deleted_at: null, deleted_by: null, moderation_status: 'published', published_at: new Date().toISOString() })
      .eq('id', id);
    if (error) { toast(error.message, true); return; }
    toast(`"${name}" restored and published`);
    archivePage(content, navigate, isSuperAdmin);
  }

  async function purge(id, name, kind) {
    const ok = await customConfirm(
      `"${name}" and everything attached to it — media, floor plans, enquiries, moderation history — will be permanently deleted. This cannot be undone.`,
      { title: 'Delete permanently?', confirmLabel: 'Delete permanently', danger: true }
    );
    if (!ok) return;
    await deleteProjectStorageFiles(id, kind);
    const { error } = await sb.from(projectKind(kind).tables.project).delete().eq('id', id);
    if (error) { toast(error.message, true); return; }
    toast(`"${name}" permanently deleted`);
    archivePage(content, navigate, isSuperAdmin);
  }
}

// Deleting a project row cascades to every child DB row (media, documents, litigation,
// construction updates, etc.), but a DB cascade has no effect on the actual files those rows
// pointed at in Supabase Storage — those live in a separate system and stay orphaned forever
// unless removed explicitly, and removing them has to happen *before* the cascade deletes the
// rows that record their paths. Best-effort throughout: a failed storage delete here (a stale
// path, a network blip) should never block the person from actually deleting the project.
async function deleteProjectStorageFiles(projectId, kind) {
  const { tables: T, buckets } = projectKind(kind);
  const [media, documents, litigation, updates, blogs] = await Promise.all([
    sb.from(T.media).select('media_path').eq('project_id', projectId),
    sb.from(T.documents).select('file_path').eq('project_id', projectId),
    sb.from(T.litigation).select('supporting_document_path').eq('project_id', projectId),
    sb.from(T.updates).select('id').eq('project_id', projectId),
    sb.from(T.blogs).select('cover_image_path').eq('project_id', projectId)
  ]);

  const updateIds = (updates.data || []).map(u => u.id);
  const updateMedia = updateIds.length
    ? await sb.from(T.updateMedia).select('media_path').in('update_id', updateIds)
    : { data: [] };

  const mediaPaths = [
    ...(media.data || []).map(r => r.media_path),
    ...(updateMedia.data || []).map(r => r.media_path),
    ...(blogs.data || []).map(r => r.cover_image_path)
  ].filter(Boolean);
  const documentPaths = [
    ...(documents.data || []).map(r => r.file_path),
    ...(litigation.data || []).map(r => r.supporting_document_path)
  ].filter(Boolean);

  await Promise.all([
    mediaPaths.length ? sb.storage.from(buckets.media).remove(mediaPaths).catch(() => {}) : null,
    documentPaths.length ? sb.storage.from(buckets.docs).remove(documentPaths).catch(() => {}) : null
  ]);
}

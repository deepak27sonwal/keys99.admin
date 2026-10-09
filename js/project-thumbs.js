import { sb } from './supabase-client.js';
import { projectKind } from './project-kinds.js';
import { icon, escapeHtml } from './utils.js';

// Project photos for the list tables (Residential / Commercial Projects, the Dashboard's
// Recent Projects). The picture is the project's Main Image from Step 15 (Project Media) —
// stored as a media row, not on the project itself — falling back to its first gallery photo,
// then to the kind's icon when the project has no photos yet.

// Tags each row with `_thumb` (a public image URL, or null). `rows` carry `_kind` (merged
// lists) or all belong to `kind`. One query per kind; a failed query just leaves the icons.
export async function attachProjectThumbs(rows, kind) {
  const idsByKind = {};
  rows.forEach(r => { r._thumb = null; (idsByKind[r._kind || kind] ||= []).push(r.id); });

  const best = new Map();   // project_id -> { url, rank }
  await Promise.all(Object.entries(idsByKind).map(async ([k, ids]) => {
    if (!ids.length) return;
    const { data, error } = await sb.from(projectKind(k).tables.media)
      .select('project_id,media_url,media_type,display_order')
      .in('project_id', ids)
      .in('media_type', ['main_image', 'gallery']);
    if (error) return;
    (data || []).forEach(m => {
      if (!m.media_url) return;
      const rank = (m.media_type === 'main_image' ? 0 : 1000) + (m.display_order ?? 999);
      const cur = best.get(m.project_id);
      if (!cur || rank < cur.rank) best.set(m.project_id, { url: m.media_url, rank });
    });
  }));
  rows.forEach(r => { r._thumb = best.get(r.id)?.url || null; });
  return rows;
}

// Inner HTML for a .proj-thumb cell. The icon stays underneath the photo, so a broken or
// slow image still shows something — see bindThumbFallbacks().
export function projectThumbHtml(url, iconName) {
  return icon(iconName, 16) + (url ? `<img src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async">` : '');
}

// Removes photos that fail to load (deleted file, bad URL), revealing the icon again.
export function bindThumbFallbacks(root) {
  // Called right after the rows are inserted, before any load can have failed.
  root.querySelectorAll('.proj-thumb img').forEach(img => {
    img.addEventListener('error', () => img.remove(), { once: true });
  });
}

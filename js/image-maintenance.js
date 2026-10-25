import { sb } from './supabase-client.js';
import { escapeHtml, toast, customConfirm } from './utils.js';
import { PROJECT_KINDS, KIND_KEYS } from './project-kinds.js';
import { prepareImageForUpload, IMAGE_TARGET_BYTES } from './image-compress.js';

// Settings → "Image Optimization" (super admins). Every new upload is already converted to a
// ≤ 100 KB WebP (CLAUDE.md), but photos uploaded before that rule exist in Storage as JPEG /
// PNG or oversized files. This scans the project media and document buckets, matches each
// image to the rows that use it, and:
//   - Convert: downloads each non-compliant image, runs it through prepareImageForUpload(),
//     uploads the WebP next to it, repoints every row that used the old file, and only then
//     deletes the original — a failure at any step leaves the original and its rows untouched.
//   - Delete unused: removes images no project, blog or document refers to (leftovers from
//     replaced images and permanently deleted projects).

const MEDIA_LABELS = { main_image: 'Main image', master_plan: 'Master plan', gallery: 'Gallery photo' };
// Inline images in blog / newsletter bodies are referenced from HTML, not a path column: one
// counts as used while any blog or newsletter HTML still contains its path.
const INLINE_PREFIXES = ['blog/inline/', 'newsletter/'];

const DIRECTORY_SOURCES = [
  { table: 'cities', url: 'city_image', where: () => 'City photo', name: r => r.name },
  { table: 'developers', url: 'logo_url', where: () => 'Developer logo', name: r => r.name },
  { table: 'agents', url: 'photo_url', where: () => 'Agent photo', name: r => r.full_name },
  { table: 'relationship_managers', url: 'photo_url', where: () => 'Relationship manager photo', name: r => r.full_name },
  { table: 'advertisements', url: 'image_url', where: () => 'Advertisement banner', name: r => r.title },
  { table: 'testimonials', url: 'photo_url', where: () => 'Testimonial photo', name: r => r.name }
];

const isImage = mime => /^image\//.test(mime || '') && mime !== 'image/svg+xml';
const fmtKb = n => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
const typeLabel = mime => (mime || '').replace('image/', '').toUpperCase() || '?';

// Every place a stored file path is recorded, per kind.
function referenceSources(K) {
  const T = K.tables, B = K.buckets;
  const list = [
    { table: T.media, bucket: B.media, path: 'media_path', url: 'media_url', where: r => MEDIA_LABELS[r.media_type] || 'Media' },
    { table: T.updateMedia, bucket: B.media, path: 'media_path', url: 'media_url', where: () => 'Construction update photo', projectVia: 'update' },
    { table: T.blogs, bucket: B.media, path: 'cover_image_path', url: 'cover_image_url', where: r => `Blog cover — ${r.title || ''}` },
    { table: T.documents, bucket: B.docs, path: 'file_path', url: 'file_url', where: r => `Document — ${r.title || r.document_type || ''}` },
    { table: T.litigation, bucket: B.docs, path: 'supporting_document_path', url: 'supporting_document_url', where: () => 'Litigation document' }
  ];
  if (T.floorPlans) list.push({ table: T.floorPlans, bucket: B.media, path: 'image_path', url: 'image_url', where: r => `Floor plan — ${r.bhk_type || ''} ${String(r.plan_type || '').toUpperCase()}` });
  return list;
}

async function listBucket(bucket) {
  const files = [];
  async function walk(prefix, depth) {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await sb.storage.from(bucket).list(prefix, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } });
      if (error) throw new Error(`${bucket}: ${error.message}`);
      for (const e of data || []) {
        const full = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.id === null || !e.metadata) { if (depth < 6) await walk(full, depth + 1); }
        else files.push({ bucket, path: full, size: e.metadata.size || 0, mime: e.metadata.mimetype || '' });
      }
      if (!data || data.length < 1000) break;
    }
  }
  await walk('', 0);
  return files;
}

export async function scanImages(onProgress = () => {}) {
  const buckets = KIND_KEYS.flatMap(k => [PROJECT_KINDS[k].buckets.media, PROJECT_KINDS[k].buckets.docs]);
  const files = [];
  for (const b of buckets) { onProgress(`Listing ${b}…`); files.push(...await listBucket(b)); }

  onProgress('Matching files to projects…');
  const refs = new Map();   // "bucket/path" -> [{ source, row, project }]
  for (const k of KIND_KEYS) {
    const K = PROJECT_KINDS[k];
    const [{ data: projects }, { data: updates }] = await Promise.all([
      sb.from(K.tables.project).select('id,project_name,deleted_at'),
      sb.from(K.tables.updates).select('id,project_id')
    ]);
    const projectName = new Map((projects || []).map(p => [p.id, p.project_name + (p.deleted_at ? ' (archived)' : '')]));
    const updateProject = new Map((updates || []).map(u => [u.id, u.project_id]));
    for (const src of referenceSources(K)) {
      const { data, error } = await sb.from(src.table).select('*').not(src.path, 'is', null);
      if (error) throw new Error(`${src.table}: ${error.message}`);
      for (const row of data || []) {
        const key = `${src.bucket}/${row[src.path]}`;
        const pid = src.projectVia === 'update' ? updateProject.get(row.update_id) : row.project_id;
        if (!refs.has(key)) refs.set(key, []);
        refs.get(key).push({ src, row, kind: k, project: projectName.get(pid) || '—' });
      }
    }
  }

  // Directory images (city photos, agent / RM photos, developer logos) are stored as public
  // URLs only, in residential-media/directory/… (see entity-form.js).
  const marker = '/storage/v1/object/public/';
  for (const src of DIRECTORY_SOURCES) {
    const { data, error } = await sb.from(src.table).select('*').not(src.url, 'is', null);
    if (error) throw new Error(`${src.table}: ${error.message}`);
    for (const row of data || []) {
      const i = String(row[src.url]).indexOf(marker);
      if (i < 0) continue;
      const key = decodeURIComponent(row[src.url].slice(i + marker.length).split(/[?#]/)[0]);   // bucket/path
      if (!refs.has(key)) refs.set(key, []);
      refs.get(key).push({ src, row, project: src.name(row) });
    }
  }

  // All blog and newsletter HTML, to tell which inline images are still used.
  const htmlParts = [];
  for (const k of KIND_KEYS) {
    const { data, error } = await sb.from(PROJECT_KINDS[k].tables.blogs).select('body_html');
    if (error) throw new Error(`${PROJECT_KINDS[k].tables.blogs}: ${error.message}`);
    htmlParts.push(...(data || []).map(b => b.body_html || ''));
  }
  const { data: campaigns, error: cErr } = await sb.from('newsletter_campaigns').select('body_html,content_html');
  if (cErr) throw new Error(`newsletter_campaigns: ${cErr.message}`);
  htmlParts.push(...(campaigns || []).map(c => `${c.body_html || ''} ${c.content_html || ''}`));
  const allHtml = htmlParts.join('\n');

  const needs = [], unused = [], inline = [];
  const bad = f => f.mime !== 'image/webp' || f.size > IMAGE_TARGET_BYTES;
  for (const f of files) {
    if (!isImage(f.mime)) continue;
    const used = refs.get(`${f.bucket}/${f.path}`);
    if (used) {
      if (bad(f)) needs.push({ ...f, refs: used });
    } else if (INLINE_PREFIXES.some(p => f.path.startsWith(p)) && allHtml.includes(f.path)) {
      if (bad(f)) inline.push(f);   // inside blog / newsletter text — fix by re-inserting in the editor
    } else {
      unused.push(f);
    }
  }
  const imageCount = files.filter(f => isImage(f.mime)).length;
  return { needs, unused, inline, imageCount, compliant: imageCount - needs.length - unused.length - inline.length };
}

function publicUrl(bucket, path) {
  return /-media$/.test(bucket) ? sb.storage.from(bucket).getPublicUrl(path).data.publicUrl : null;
}

// Converts one in-use image. Resolves { ok, newPath, before, after } or { ok: false, error }.
export async function convertImage(item, existingPaths) {
  const { bucket, path } = item;
  const dl = await sb.storage.from(bucket).download(path);
  if (dl.error) return { ok: false, error: `Download failed: ${dl.error.message}` };
  const name = path.split('/').pop();
  const original = new File([dl.data], name, { type: dl.data.type || item.mime });
  const out = await prepareImageForUpload(original);
  if (out.error) return { ok: false, error: out.error };
  if (out.file.type !== 'image/webp') return { ok: false, error: 'This browser can’t create WebP images — run this in Chrome, Edge or Firefox.' };

  let newPath = path.replace(/\.[^./]+$/, '') + '.webp';
  if (newPath === path || existingPaths.has(`${bucket}/${newPath}`)) newPath = path.replace(/\.[^./]+$/, '') + `-${Date.now().toString(36)}.webp`;
  const up = await sb.storage.from(bucket).upload(newPath, out.file, { upsert: false, contentType: 'image/webp' });
  if (up.error) return { ok: false, error: `Upload failed: ${up.error.message}` };

  const newUrl = publicUrl(bucket, newPath);
  const oldUrl = publicUrl(bucket, path);
  const done = [];
  for (const ref of item.refs) {
    const patch = ref.src.path ? { [ref.src.path]: newPath } : {};
    if (ref.src.url in ref.row && ref.row[ref.src.url]) patch[ref.src.url] = newUrl || ref.row[ref.src.url].replace(path, newPath);
    const { error } = await sb.from(ref.src.table).update(patch).eq('id', ref.row.id);
    if (error) {
      // Put back what was already repointed, drop the new file, keep the original.
      for (const d of done) await sb.from(d.src.table).update({ ...(d.src.path ? { [d.src.path]: path } : {}), ...(d.src.url in d.row ? { [d.src.url]: d.row[d.src.url] } : {}) }).eq('id', d.row.id);
      await sb.storage.from(bucket).remove([newPath]);
      return { ok: false, error: `Couldn't update ${ref.src.table}: ${error.message}` };
    }
    done.push(ref);
  }
  // Blog bodies may show the same image inline by URL.
  if (oldUrl) {
    for (const k of KIND_KEYS) {
      const t = PROJECT_KINDS[k].tables.blogs;
      const { data } = await sb.from(t).select('id,body_html').like('body_html', `%${path}%`);
      for (const b of data || []) await sb.from(t).update({ body_html: b.body_html.split(oldUrl).join(newUrl) }).eq('id', b.id);
    }
  }
  const rm = await sb.storage.from(bucket).remove([path]);
  existingPaths.add(`${bucket}/${newPath}`);
  return { ok: true, newPath, before: item.size, after: out.file.size, removeError: rm.error?.message };
}

/* ---------------- Settings panel ---------------- */

export function imageMaintenancePanel(isSuperAdmin) {
  return `<div class="panel" id="image-maint">
    <div class="panel-head"><h2>Image Optimization</h2>
      ${isSuperAdmin ? '<div class="toolbar"><button type="button" class="btn-primary" id="img-scan">Scan stored images</button></div>' : ''}</div>
    <div class="settings-body">
      <p class="hint">New uploads are always converted to WebP of 100 KB or less. This finds photos stored before that rule — JPEG, PNG or larger than 100 KB — converts them to WebP in your browser, and points every project, floor plan, blog and document at the new file. Unused leftover images can be deleted too.</p>
      ${isSuperAdmin ? '<div id="img-results"></div>' : '<p class="notice">Only super admins can optimize stored images.</p>'}
    </div>
  </div>`;
}

export function bindImageMaintenance(root, isSuperAdmin) {
  if (!isSuperAdmin) return;
  const btn = root.querySelector('#img-scan');
  const out = root.querySelector('#img-results');
  let scan = null;

  async function runScan() {
    btn.disabled = true;
    out.innerHTML = `<div class="img-status" id="img-status">Scanning…</div>`;
    try {
      scan = await scanImages(msg => { const s = out.querySelector('#img-status'); if (s) s.textContent = msg; });
      render();
    } catch (e) {
      out.innerHTML = `<p class="notice">${escapeHtml(e.message)}</p>`;
    } finally { btn.disabled = false; }
  }

  function row(f, extra = '') {
    const thumb = /-media$/.test(f.bucket) ? `<img src="${escapeHtml(publicUrl(f.bucket, f.path))}" alt="" loading="lazy">` : '<span class="img-doc">IMG</span>';
    const where = f.refs ? f.refs.map(r => `${escapeHtml(r.project)} · ${escapeHtml(r.src.where(r.row))}`).join('<br>') : `<span class="hint">${escapeHtml(f.path)}</span>`;
    return `<tr data-key="${escapeHtml(`${f.bucket}/${f.path}`)}">
      <td class="img-thumb">${thumb}</td>
      <td>${where}</td>
      <td><span class="pill ${f.mime === 'image/webp' ? 'followup' : 'draft'}">${typeLabel(f.mime)}</span> ${fmtKb(f.size)}</td>
      <td class="img-result">${extra}</td>
    </tr>`;
  }

  function render() {
    const { needs, unused, inline, imageCount, compliant } = scan;
    const allGood = !needs.length && !unused.length && !inline.length;
    out.innerHTML = `
      <div class="img-summary${allGood ? ' ok' : ''}">${allGood
        ? `✓ All ${imageCount} stored images are WebP of 100 KB or less, and none are unused.`
        : `${imageCount} images stored · <b>${compliant}</b> already WebP ≤ 100 KB · <b>${needs.length}</b> to convert · <b>${unused.length}</b> unused${inline.length ? ` · <b>${inline.length}</b> inside blog / newsletter text` : ''}`}</div>
      ${needs.length ? `<h3 class="img-h">In use — needs converting</h3>
        <div class="table-wrap"><table class="img-table"><thead><tr><th></th><th>Used by</th><th>Now</th><th>Result</th></tr></thead><tbody>${needs.map(f => row(f)).join('')}</tbody></table></div>
        <div class="settings-actions"><button type="button" class="btn-primary" id="img-convert">Convert ${needs.length} image${needs.length === 1 ? '' : 's'} to WebP</button></div>` : ''}
      ${unused.length ? `<h3 class="img-h">Not used anywhere</h3>
        <div class="table-wrap"><table class="img-table"><thead><tr><th></th><th>File</th><th>Size</th><th></th></tr></thead><tbody>${unused.map(f => row(f)).join('')}</tbody></table></div>
        <div class="settings-actions"><button type="button" class="btn-outline danger" id="img-delete">Delete ${unused.length} unused image${unused.length === 1 ? '' : 's'}</button></div>` : ''}
      ${inline.length ? `<h3 class="img-h">Inside blog / newsletter text</h3>
        <p class="hint">These were placed inside a post's or email's text before compression existed. Open the post, delete the image and insert it again — it will be compressed to WebP automatically.</p>
        <div class="table-wrap"><table class="img-table"><thead><tr><th></th><th>File</th><th>Size</th><th></th></tr></thead><tbody>${inline.map(f => row(f)).join('')}</tbody></table></div>` : ''}`;
    out.querySelector('#img-convert')?.addEventListener('click', convertAll);
    out.querySelector('#img-delete')?.addEventListener('click', deleteUnused);
  }

  async function convertAll(e) {
    const ok = await customConfirm(`${scan.needs.length} image${scan.needs.length === 1 ? '' : 's'} will be converted to WebP (≤ 100 KB). Projects, floor plans, blogs and documents will use the new files, and the originals will be deleted.`,
      { title: 'Convert images?', confirmLabel: 'Convert' });
    if (!ok) return;
    e.target.disabled = true; btn.disabled = true;
    const existing = new Set([...scan.needs, ...scan.unused].map(f => `${f.bucket}/${f.path}`));
    let good = 0, saved = 0;
    for (const f of scan.needs) {
      const cell = out.querySelector(`tr[data-key="${CSS.escape(`${f.bucket}/${f.path}`)}"] .img-result`);
      cell.textContent = 'Converting…';
      let r;
      try { r = await convertImage(f, existing); } catch (err) { r = { ok: false, error: err.message }; }
      if (r.ok) { good++; saved += Math.max(0, r.before - r.after); cell.innerHTML = `<span class="img-ok">✓ WebP ${fmtKb(r.after)}</span>${r.removeError ? `<br><span class="hint">Original not deleted: ${escapeHtml(r.removeError)}</span>` : ''}`; }
      else cell.innerHTML = `<span class="nl-error">${escapeHtml(r.error)}</span>`;
    }
    toast(`${good} of ${scan.needs.length} converted${saved ? ` · ${fmtKb(saved)} saved` : ''}`, good < scan.needs.length);
    btn.disabled = false;
    btn.textContent = 'Scan again';
  }

  async function deleteUnused(e) {
    const ok = await customConfirm(`${scan.unused.length} image${scan.unused.length === 1 ? '' : 's'} that no project, blog or document uses will be permanently deleted from Storage.`,
      { title: 'Delete unused images?', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    e.target.disabled = true;
    // Re-check right before deleting, in case someone attached one of them meanwhile.
    let fresh;
    try { fresh = await scanImages(); } catch (err) { toast(err.message, true); e.target.disabled = false; return; }
    const stillUnused = new Set(fresh.unused.map(f => `${f.bucket}/${f.path}`));
    const byBucket = {};
    scan.unused.filter(f => stillUnused.has(`${f.bucket}/${f.path}`)).forEach(f => (byBucket[f.bucket] ||= []).push(f.path));
    let removed = 0, failed = null;
    for (const [bucket, paths] of Object.entries(byBucket)) {
      const { error } = await sb.storage.from(bucket).remove(paths);
      if (error) failed = error.message; else removed += paths.length;
    }
    toast(failed ? `Some files couldn't be deleted: ${failed}` : `${removed} unused image${removed === 1 ? '' : 's'} deleted`, !!failed);
    await runScan();
  }

  btn.addEventListener('click', runScan);
}

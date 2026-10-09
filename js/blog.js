import { sb } from './supabase-client.js';
import { pageHead, tablePanel, emptyRow, escapeHtml, fmtDate, toast, customConfirm, icon, pill } from './utils.js';
import { enhanceSelects } from './custom-select.js';
import { KIND_KEYS, projectKind, queryAllKinds, kindPill } from './project-kinds.js';
import { prepareImageForUpload } from './image-compress.js';
import { loadEditor, createEditor, sanitizeHtml, htmlForEditor, textToHtml, htmlToPlainText, wordCount, readingTime } from './rich-text.js';

// Project Blogs: a standalone page (not part of the project wizard) that manages blog posts
// across every project of both kinds — each post lives in its kind's <kind>_project_blogs
// table, tied to a project_id in that kind's project table. Mirrors the look of Admins/Reports (pageHead + tablePanel) and the modal
// mechanics of entity-form.js, but needs its own form since a blog post has a cover-image
// upload and a rich-text body that the generic entity form doesn't support.

const COVER_LIMITS = { maxBytes: 10 * 1024 * 1024, mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'], label: 'JPG, PNG, WEBP, AVIF or GIF · compressed to 100 KB WebP' };

function slugify(text) {
  return String(text || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function blogPage(content, currentUser) {
  const subtitle = 'Blog posts published under each residential or commercial project';
  content.innerHTML = pageHead('Project Blogs', subtitle) + `<div class="empty">Loading…</div>`;

  const [{ data: posts, error }, { data: projects }] = await Promise.all([
    queryAllKinds(K => sb.from(K.tables.blogs)
      .select(`id,title,slug,author,is_published,is_featured,reading_time_minutes,published_at,updated_at,project_id,project:${K.tables.project}(project_name)`)
      .order('updated_at', { ascending: false })),
    queryAllKinds(K => sb.from(K.tables.project).select('id,project_name').is('deleted_at', null).order('project_name'))
  ]);

  if (error) {
    content.innerHTML = pageHead('Project Blogs', subtitle) + `<div class="empty">${escapeHtml(error.message)}</div>`;
    return;
  }
  posts.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

  const rows = posts.map(p => `
    <tr>
      <td><strong>${escapeHtml(p.title)}</strong>${p.is_featured ? ' <span class="pill featured">★ Featured</span>' : ''}${p.reading_time_minutes ? `<div class="proj-code">${p.reading_time_minutes} min read</div>` : ''}</td>
      <td>${escapeHtml(p.project?.project_name || '—')} ${kindPill(p._kind)}</td>
      <td>${escapeHtml(p.author || '—')}</td>
      <td>${pill(p.is_published ? 'published' : 'draft')}</td>
      <td>${fmtDate(p.updated_at)}</td>
      <td>
        <div class="row-actions">
          <button class="icon-btn" data-edit-blog="${p.id}" data-kind="${p._kind}">${icon('edit', 13)}</button>
          <button class="icon-btn danger" data-delete-blog="${p.id}" data-kind="${p._kind}" data-title="${escapeHtml(p.title)}">${icon('trash', 13)}</button>
        </div>
      </td>
    </tr>`).join('');

  const toolbar = `<button type="button" class="btn-primary" id="add-blog-btn">+ Add Blog Post</button>`;

  content.innerHTML = pageHead('Project Blogs', subtitle) +
    tablePanel('Blog Posts', toolbar, ['Title', 'Project', 'Author', 'Status', 'Updated', 'Actions'], rows.length ? rows : emptyRow(6, 'No blog posts yet. Click "+ Add Blog Post" to write the first one.'));

  const reload = () => blogPage(content, currentUser);

  content.querySelector('#add-blog-btn').addEventListener('click', () => openBlogForm({ currentUser, projects, onSaved: reload }));
  content.querySelectorAll('[data-edit-blog]').forEach(btn =>
    btn.addEventListener('click', () => openBlogForm({ currentUser, projects, existingId: btn.dataset.editBlog, existingKind: btn.dataset.kind, onSaved: reload })));
  content.querySelectorAll('[data-delete-blog]').forEach(btn =>
    btn.addEventListener('click', () => deleteBlogPost(btn.dataset.deleteBlog, btn.dataset.kind, btn.dataset.title, reload)));
}

async function deleteBlogPost(id, kind, title, onDeleted) {
  const ok = await customConfirm('This cannot be undone.', { title: `Delete "${title}"?`, confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  const { error } = await sb.from(projectKind(kind).tables.blogs).delete().eq('id', id);
  if (error) { toast(error.message, true); return; }
  toast('Blog post deleted');
  onDeleted();
}

// Project options are "<kind>:<id>" so the post is saved to the right kind's blogs table.
// An existing post stays with its kind — moving it would mean a different table — so its
// project picker only offers projects of that same kind.
//
// The editor is a large two-column dialog: the post itself (title, slug, excerpt, rich-text
// body with a Write / Preview toggle) on the left, and publishing, cover image, author, tags
// and SEO on the right. The body is written in a rich-text editor (see rich-text.js) and
// saved twice: sanitized HTML in body_html for the public site, plain text in body.
async function openBlogForm({ currentUser, projects, existingId, existingKind, onSaved }) {
  let values = {
    project_id: '', title: '', slug: '', excerpt: '', body: '', body_html: '', author: '', tags: [],
    meta_title: '', meta_description: '', is_published: false, is_featured: false, published_at: '',
    cover_image_path: null, cover_image_url: null, cover_image_alt: ''
  };
  let slugTouched = !!existingId;

  const [loaded] = await Promise.all([
    existingId ? sb.from(projectKind(existingKind).tables.blogs).select('*').eq('id', existingId).single() : null,
    loadEditor().catch(e => e)
  ]);
  if (loaded?.error) { toast(loaded.error.message, true); return; }
  if (!window.Quill) { toast('The text editor could not be loaded — check your connection and try again.', true); return; }
  if (loaded?.data) {
    const d = loaded.data;
    values = { ...values, ...d, tags: d.tags || [], published_at: d.published_at ? d.published_at.slice(0, 10) : '' };
    for (const k of ['excerpt', 'author', 'meta_title', 'meta_description', 'cover_image_alt']) values[k] = values[k] || '';
  }
  let tags = [...values.tags];

  const projectOptions = KIND_KEYS.filter(k => !existingId || k === existingKind).map(k => `<optgroup label="${escapeHtml(projectKind(k).label)}">${
    projects.filter(p => p._kind === k).map(p => `<option value="${escapeHtml(`${k}:${p.id}`)}"${values.project_id === p.id && (existingKind || k) === k ? ' selected' : ''}>${escapeHtml(p.project_name)}</option>`).join('')
  }</optgroup>`).join('');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay blog-editor-overlay';
  overlay.innerHTML = `
    <div class="modal-box blog-editor" role="dialog" aria-modal="true" aria-label="${existingId ? 'Edit blog post' : 'New blog post'}">
      <div class="modal-head">
        <div><h2>${existingId ? 'Edit Blog Post' : 'New Blog Post'}</h2><p>Published on the selected project's page on Keys99.</p></div>
        <div class="blog-mode" role="tablist">
          <button type="button" class="active" data-mode="write" role="tab">Write</button>
          <button type="button" data-mode="preview" role="tab">Preview</button>
        </div>
        <button type="button" class="modal-close" data-close aria-label="Close">✕</button>
      </div>
      <div class="modal-body blog-editor-body">
        <div class="blog-main">
          <div data-pane="write">
            <input class="blog-title-input" data-field="title" type="text" value="${escapeHtml(values.title)}" placeholder="Post title" maxlength="160">
            <div class="blog-slug-row">
              <span>/blog/</span><input data-field="slug" type="text" value="${escapeHtml(values.slug)}" placeholder="post-url" aria-label="Slug">
            </div>
            <div class="field full">
              <label>Excerpt <span class="hint" data-count="excerpt"></span></label>
              <textarea data-field="excerpt" rows="2" placeholder="One or two sentences shown on blog cards and at the top of the post">${escapeHtml(values.excerpt)}</textarea>
            </div>
            <div class="field full">
              <label>Content <span class="req">*</span></label>
              <div class="blog-editor-wrap"><div id="blog-quill"></div></div>
              <div class="blog-stats" id="blog-stats"></div>
            </div>
          </div>
          <div data-pane="preview" hidden><div class="blog-preview" id="blog-preview"></div></div>
        </div>
        <aside class="blog-side">
          <section class="blog-card">
            <h3>Publishing</h3>
            <div class="field"><label>Project <span class="req">*</span></label>
              <select data-field="project_id"><option value="">Select a project…</option>${projectOptions}</select></div>
            <label class="blog-check"><input type="checkbox" data-field="is_published" ${values.is_published ? 'checked' : ''}> Published</label>
            <div class="field"><label>Publish date</label><input data-field="published_at" type="date" value="${escapeHtml(values.published_at)}"></div>
            <label class="blog-check" title="Highlighted at the top of the project's blog list"><input type="checkbox" data-field="is_featured" ${values.is_featured ? 'checked' : ''}> Featured post</label>
          </section>
          <section class="blog-card">
            <h3>Cover image</h3>
            <div id="blog-cover-slot"></div>
            <div class="field"><label>Alt text</label><input data-field="cover_image_alt" type="text" value="${escapeHtml(values.cover_image_alt)}" placeholder="Describe the image for SEO & screen readers"></div>
          </section>
          <section class="blog-card">
            <h3>Author &amp; tags</h3>
            <div class="field"><label>Author</label><input data-field="author" type="text" value="${escapeHtml(values.author)}" placeholder="Keys99 Editorial"></div>
            <div class="field"><label>Tags <span class="hint">· Enter or comma to add</span></label>
              <div class="tag-input" id="blog-tags"><input type="text" placeholder="e.g. Punawale" aria-label="Add tag"></div></div>
          </section>
          <section class="blog-card">
            <h3>SEO</h3>
            <div class="field"><label>SEO title <span class="hint" data-count="meta_title"></span></label>
              <input data-field="meta_title" type="text" value="${escapeHtml(values.meta_title)}"></div>
            <div class="field"><label>Meta description <span class="hint" data-count="meta_description"></span></label>
              <textarea data-field="meta_description" rows="3" placeholder="Leave blank to use the excerpt">${escapeHtml(values.meta_description)}</textarea></div>
            <div class="seo-preview blog-seo-preview" id="blog-seo-preview"></div>
          </section>
        </aside>
      </div>
      <div class="modal-footer">
        <span class="blog-footer-note" id="blog-footer-note"></span>
        <button type="button" class="btn-outline" data-close>Cancel</button>
        <button type="button" class="btn-primary" data-save>${existingId ? 'Save Changes' : 'Create Post'}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  enhanceSelects(overlay);

  const box = overlay.querySelector('.modal-box');
  const get = (key) => box.querySelector(`[data-field="${key}"]`);
  const projectSelect = get('project_id');
  const selectedKind = () => (projectSelect.value ? projectSelect.value.split(':')[0] : existingKind || null);
  let busy = 0;   // uploads in flight — saving waits for them

  // ---- rich-text body ----
  const quill = createEditor(overlay.querySelector('#blog-quill'), {
    placeholder: 'Write the post… Use headings (H2/H3) to break it into sections, lists for features, and quotes for highlights.',
    onImage: insertInlineImage,
    onChange: () => { refreshStats(); refreshSeo(); }
  });
  const startHtml = values.body_html || textToHtml(values.body);
  if (startHtml) quill.clipboard.dangerouslyPasteHTML(htmlForEditor(startHtml), 'silent');
  quill.history.clear();
  const bodyHtml = () => sanitizeHtml(quill.root.innerHTML);

  function refreshStats() {
    const text = quill.getText();
    const words = wordCount(text);
    overlay.querySelector('#blog-stats').textContent = words ? `${words.toLocaleString('en-IN')} words · ${readingTime(text)} min read` : 'Empty';
  }

  // ---- counters & SEO snippet ----
  const LIMITS = { excerpt: 160, meta_title: 60, meta_description: 160 };
  function refreshCounts() {
    Object.entries(LIMITS).forEach(([k, max]) => {
      const n = get(k).value.length;
      const el = overlay.querySelector(`[data-count="${k}"]`);
      el.textContent = `${n} / ${max}`;
      el.classList.toggle('over', n > max);
    });
  }
  const suggestedMetaTitle = () => {
    const t = get('title').value.trim();
    if (t.length <= 60) return t;
    let words = t.slice(0, 61).split(/\s+/);
    words.pop();   // the last word may be cut off
    while (words.length > 3 && /^(a|an|the|in|of|for|to|and|&|with|at|on|by|from|or|—|-|:|\|)$/i.test(words[words.length - 1])) words.pop();
    return words.join(' ').replace(/[,:;–—-]+$/, '').trim();
  };
  function refreshSeo() {
    get('meta_title').placeholder = suggestedMetaTitle() || 'Defaults to the post title';
    const title = get('meta_title').value.trim() || suggestedMetaTitle() || 'Post title';
    const desc = get('meta_description').value.trim() || get('excerpt').value.trim() || quill.getText().trim().slice(0, 160);
    overlay.querySelector('#blog-seo-preview').innerHTML =
      `<div class="seo-preview-url">keys99.com › blog › ${escapeHtml(slugify(get('slug').value) || 'post-url')}</div>
       <div class="seo-preview-title">${escapeHtml(title)}</div>
       <div class="seo-preview-desc">${escapeHtml(desc || 'Add an excerpt or meta description.')}</div>`;
    refreshCounts();
  }

  // ---- title → slug ----
  get('slug').addEventListener('input', () => { slugTouched = true; refreshSeo(); });
  get('title').addEventListener('input', () => {
    if (!slugTouched) get('slug').value = slugify(get('title').value);
    refreshSeo();
  });
  ['excerpt', 'meta_title', 'meta_description'].forEach(k => get(k).addEventListener('input', refreshSeo));

  // ---- tags as chips ----
  const tagBox = overlay.querySelector('#blog-tags');
  const tagInput = tagBox.querySelector('input');
  function renderTags() {
    tagBox.querySelectorAll('.tag-chip').forEach(c => c.remove());
    tags.forEach((t, i) => tagInput.insertAdjacentHTML('beforebegin', `<span class="tag-chip">${escapeHtml(t)}<button type="button" data-rm-tag="${i}" aria-label="Remove ${escapeHtml(t)}">✕</button></span>`));
  }
  function addTags(raw) {
    raw.split(',').map(t => t.trim()).filter(Boolean).forEach(t => { if (!tags.some(x => x.toLowerCase() === t.toLowerCase())) tags.push(t); });
    tagInput.value = '';
    renderTags();
  }
  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTags(tagInput.value); }
    else if (e.key === 'Backspace' && !tagInput.value && tags.length) { tags.pop(); renderTags(); }
  });
  tagInput.addEventListener('blur', () => { if (tagInput.value.trim()) addTags(tagInput.value); });
  tagBox.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm-tag]');
    if (rm) { tags.splice(Number(rm.dataset.rmTag), 1); renderTags(); } else tagInput.focus();
  });
  renderTags();

  // ---- images (cover + inline), always compressed to ≤ 100 KB first (see CLAUDE.md) ----
  async function uploadImage(file, folder) {
    const kind = selectedKind();
    if (!kind) { toast('Select a project first', true); return null; }
    if (!COVER_LIMITS.mimeTypes.includes(file.type)) { toast(`Unsupported file type. Allowed: ${COVER_LIMITS.label}.`, true); return null; }
    const out = await prepareImageForUpload(file);
    if (out.error) { toast(out.error, true); return null; }
    const bucket = projectKind(kind).buckets.media;
    const safeName = out.file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    const path = `${folder}/${Date.now()}-${safeName}`;
    const { error } = await sb.storage.from(bucket).upload(path, out.file, { upsert: true });
    if (error) { toast(error.message, true); return null; }
    return { path, url: sb.storage.from(bucket).getPublicUrl(path).data.publicUrl, note: out.note };
  }
  const pickFile = () => new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => resolve(input.files[0] || null), { once: true });
    input.click();
  });
  function setFooterNote() {
    overlay.querySelector('#blog-footer-note').textContent = busy ? 'Optimizing & uploading image…' : '';
    overlay.querySelector('[data-save]').disabled = busy > 0;
  }
  async function insertInlineImage() {
    if (!selectedKind()) { toast('Select a project first — images are stored with the project', true); return null; }
    const file = await pickFile();
    if (!file) return null;
    busy++; setFooterNote();
    try {
      const up = await uploadImage(file, 'blog/inline');
      if (!up) return null;
      const alt = await askText('Describe this image', 'Alt text helps search engines and screen readers.', file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '));
      toast(`Image added${up.note}`);
      return { url: up.url, alt: alt || '' };
    } finally { busy--; setFooterNote(); }
  }

  const coverSlot = overlay.querySelector('#blog-cover-slot');
  let cover = { path: values.cover_image_path, url: values.cover_image_url };
  function renderCoverSlot(state) {
    if (state === 'uploading') {
      coverSlot.innerHTML = `<div class="upload-box uploading">Optimizing &amp; uploading…</div>`;
    } else if (cover.url) {
      coverSlot.innerHTML = `<div class="blog-cover"><img src="${escapeHtml(cover.url)}" alt=""><button type="button" data-remove-cover title="Remove cover">✕</button></div>`;
      coverSlot.querySelector('[data-remove-cover]').addEventListener('click', () => { cover = { path: null, url: null }; renderCoverSlot(); });
    } else {
      coverSlot.innerHTML = `<label class="upload-box">🖼️ Upload cover image<input type="file" accept="image/*"><span class="hint">${COVER_LIMITS.label} · 16:9 looks best</span></label>`;
      coverSlot.querySelector('input[type=file]').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (!selectedKind()) { toast('Select a project first', true); e.target.value = ''; return; }
        busy++; setFooterNote(); renderCoverSlot('uploading');
        const up = await uploadImage(file, 'blog');
        busy--; setFooterNote();
        if (up) { cover = { path: up.path, url: up.url }; toast(`Cover uploaded${up.note}`); }
        renderCoverSlot();
      });
    }
  }
  renderCoverSlot();

  // ---- Write / Preview ----
  function renderPreview() {
    const html = bodyHtml();
    const text = htmlToPlainText(html);
    const date = get('published_at').value ? fmtDate(get('published_at').value) : fmtDate(new Date().toISOString());
    const meta = [get('author').value.trim() || 'Keys99 Editorial', date, `${readingTime(text) || 1} min read`].map(escapeHtml).join(' · ');
    const project = projectSelect.selectedOptions[0]?.value ? projectSelect.selectedOptions[0].textContent : '';
    overlay.querySelector('#blog-preview').innerHTML = `
      <article class="k99-post">
        ${project ? `<div class="k99-post-kicker">${escapeHtml(project)}</div>` : ''}
        <h1 class="k99-post-title">${escapeHtml(get('title').value.trim() || 'Untitled post')}</h1>
        <div class="k99-post-meta">${meta}</div>
        ${cover.url ? `<img class="k99-post-cover" src="${escapeHtml(cover.url)}" alt="${escapeHtml(get('cover_image_alt').value)}">` : ''}
        ${get('excerpt').value.trim() ? `<p class="k99-post-lead">${escapeHtml(get('excerpt').value.trim())}</p>` : ''}
        <div class="k99-article">${html || '<p><em>No content yet.</em></p>'}</div>
        ${tags.length ? `<div class="k99-post-tags">${tags.map(t => `<span>#${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      </article>`;
  }
  overlay.querySelectorAll('[data-mode]').forEach(btn => btn.addEventListener('click', () => {
    const mode = btn.dataset.mode;
    overlay.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('active', b === btn));
    overlay.querySelector('[data-pane="write"]').hidden = mode !== 'write';
    overlay.querySelector('[data-pane="preview"]').hidden = mode !== 'preview';
    if (mode === 'preview') renderPreview();
  }));

  refreshStats();
  refreshSeo();

  // ---- close (asks first when something was changed, so a stray Esc can't lose a post) ----
  let dirty = false;
  quill.on('text-change', (_d, _o, source) => { if (source === 'user') dirty = true; });
  box.addEventListener('input', () => { dirty = true; });
  box.addEventListener('change', () => { dirty = true; });
  const close = () => { overlay.remove(); document.removeEventListener('keydown', escHandler); };
  const requestClose = async () => {
    if (dirty && !(await customConfirm('Your changes to this post haven\'t been saved.', { title: 'Discard changes?', confirmLabel: 'Discard', danger: true }))) return;
    close();
  };
  const escHandler = (e) => {
    if (e.key === 'Escape' && !document.querySelector('.blog-ask') && document.querySelectorAll('.modal-overlay').length === 1) requestClose();
  };
  document.addEventListener('keydown', escHandler);
  overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', requestClose));

  // ---- save ----
  overlay.querySelector('[data-save]').addEventListener('click', async () => {
    if (busy) return;
    const [kind, projectId] = (projectSelect.value || ':').split(':');
    if (tagInput.value.trim()) addTags(tagInput.value);
    const html = bodyHtml();
    const text = htmlToPlainText(html);
    const hasContent = !!text.trim() || /<img\b/i.test(html);
    const payload = {
      project_id: projectId || null,
      title: get('title').value.trim(),
      slug: slugify(get('slug').value),
      excerpt: get('excerpt').value.trim() || null,
      body: text,
      body_html: html,
      reading_time_minutes: readingTime(text),
      author: get('author').value.trim() || null,
      tags,
      meta_title: get('meta_title').value.trim() || suggestedMetaTitle() || null,
      meta_description: get('meta_description').value.trim() || null,
      published_at: get('published_at').value || (get('is_published').checked ? new Date().toISOString().slice(0, 10) : null),
      is_published: get('is_published').checked,
      is_featured: get('is_featured').checked,
      cover_image_path: cover.path,
      cover_image_url: cover.url,
      cover_image_alt: get('cover_image_alt').value.trim() || null,
      storage_bucket: kind ? projectKind(kind).buckets.media : null
    };

    const missing = [];
    if (!payload.project_id) missing.push('Project');
    if (!payload.title) missing.push('Title');
    if (!payload.slug) missing.push('Slug');
    if (!hasContent) missing.push('Content');
    if (missing.length) { toast(`Please fill: ${missing.join(', ')}`, true); return; }

    const table = projectKind(kind).tables.blogs;
    let dupe = sb.from(table).select('id').eq('project_id', payload.project_id).eq('slug', payload.slug);
    if (existingId) dupe = dupe.neq('id', existingId);
    const { data: clash } = await dupe;
    if (clash?.length) { toast(`Another post of this project already uses the URL "/blog/${payload.slug}" — change the slug.`, true); get('slug').focus(); return; }

    const saveBtn = overlay.querySelector('[data-save]');
    saveBtn.disabled = true;
    const { error } = existingId
      ? await sb.from(table).update({ ...payload, updated_by: currentUser.id }).eq('id', existingId)
      : await sb.from(table).insert({ ...payload, created_by: currentUser.id });
    saveBtn.disabled = false;
    if (error) { toast(error.message, true); return; }

    toast(existingId ? 'Post saved' : 'Post created');
    close();
    onSaved();
  });
}

// Small single-field prompt (used for an inline image's alt text). Resolves the text, or ''.
function askText(title, hint, initial = '') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay blog-ask';
    overlay.innerHTML = `
      <div class="modal-box" style="max-width:420px">
        <div class="modal-head"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(hint)}</p></div></div>
        <div class="modal-body"><input type="text" value="${escapeHtml(initial)}" style="width:100%"></div>
        <div class="modal-footer"><button type="button" class="btn-outline" data-skip>Skip</button><button type="button" class="btn-primary" data-ok>Add</button></div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('input');
    input.focus(); input.select();
    const finish = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelector('[data-ok]').addEventListener('click', () => finish(input.value.trim()));
    overlay.querySelector('[data-skip]').addEventListener('click', () => finish(''));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value.trim()); if (e.key === 'Escape') finish(''); });
  });
}

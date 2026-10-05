import { sb } from './supabase-client.js';
import { pageHead, tablePanel, emptyRow, escapeHtml, fmtDate, toast, customConfirm, icon, pill } from './utils.js';
import { enhanceSelects } from './custom-select.js';

// Project Blogs: a standalone page (not part of the project wizard) that manages blog posts
// across every residential project, each row of residential_project_blogs tied to a
// project_id. Mirrors the look of Admins/Reports (pageHead + tablePanel) and the modal
// mechanics of entity-form.js, but needs its own form since a blog post has a cover-image
// upload and a long-form body textarea that the generic entity form doesn't support.

const BUCKET = 'residential-media';
const COVER_LIMITS = { maxBytes: 10 * 1024 * 1024, mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'], label: 'JPG, PNG, WEBP, AVIF or GIF · up to 10MB' };

function slugify(text) {
  return String(text || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export async function blogPage(content, currentUser) {
  content.innerHTML = pageHead('Project Blogs', 'Blog posts published under each residential project') + `<div class="empty">Loading…</div>`;

  const [{ data: posts, error }, { data: projects }] = await Promise.all([
    sb.from('residential_project_blogs')
      .select('id,title,slug,author,is_published,published_at,updated_at,project_id,residential_projects(project_name)')
      .order('updated_at', { ascending: false }),
    sb.from('residential_projects').select('id,project_name').is('deleted_at', null).order('project_name')
  ]);

  if (error) {
    content.innerHTML = pageHead('Project Blogs', 'Blog posts published under each residential project') + `<div class="empty">${escapeHtml(error.message)}</div>`;
    return;
  }

  const rows = posts.map(p => `
    <tr>
      <td>${escapeHtml(p.title)}</td>
      <td>${escapeHtml(p.residential_projects?.project_name || '—')}</td>
      <td>${escapeHtml(p.author || '—')}</td>
      <td>${pill(p.is_published ? 'published' : 'draft')}</td>
      <td>${fmtDate(p.updated_at)}</td>
      <td>
        <div class="row-actions">
          <button class="icon-btn" data-edit-blog="${p.id}">${icon('edit', 13)}</button>
          <button class="icon-btn danger" data-delete-blog="${p.id}" data-title="${escapeHtml(p.title)}">${icon('trash', 13)}</button>
        </div>
      </td>
    </tr>`).join('');

  const toolbar = `<button type="button" class="btn-primary" id="add-blog-btn">+ Add Blog Post</button>`;

  content.innerHTML = pageHead('Project Blogs', 'Blog posts published under each residential project') +
    tablePanel('Blog Posts', toolbar, ['Title', 'Project', 'Author', 'Status', 'Updated', 'Actions'], rows.length ? rows : emptyRow(6, 'No blog posts yet. Click "+ Add Blog Post" to write the first one.'));

  const reload = () => blogPage(content, currentUser);

  content.querySelector('#add-blog-btn').addEventListener('click', () => openBlogForm({ currentUser, projects, onSaved: reload }));
  content.querySelectorAll('[data-edit-blog]').forEach(btn =>
    btn.addEventListener('click', () => openBlogForm({ currentUser, projects, existingId: btn.dataset.editBlog, onSaved: reload })));
  content.querySelectorAll('[data-delete-blog]').forEach(btn =>
    btn.addEventListener('click', () => deleteBlogPost(btn.dataset.deleteBlog, btn.dataset.title, reload)));
}

async function deleteBlogPost(id, title, onDeleted) {
  const ok = await customConfirm('This cannot be undone.', { title: `Delete "${title}"?`, confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  const { error } = await sb.from('residential_project_blogs').delete().eq('id', id);
  if (error) { toast(error.message, true); return; }
  toast('Blog post deleted');
  onDeleted();
}

async function openBlogForm({ currentUser, projects, existingId, onSaved }) {
  let values = {
    project_id: '', title: '', slug: '', excerpt: '', body: '', author: '', tags: '',
    meta_description: '', is_published: false, published_at: '',
    cover_image_path: null, cover_image_url: null
  };
  let slugTouched = !!existingId;

  if (existingId) {
    const { data, error } = await sb.from('residential_project_blogs').select('*').eq('id', existingId).single();
    if (error) { toast(error.message, true); return; }
    values = {
      ...data,
      tags: (data.tags || []).join(', '),
      published_at: data.published_at ? data.published_at.slice(0, 10) : ''
    };
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box" style="max-width:680px">
      <div class="modal-head">
        <div><h2>${existingId ? 'Edit Blog Post' : 'Add Blog Post'}</h2><p>Shown on the public listing page of the selected project.</p></div>
        <button type="button" class="modal-close" data-close>✕</button>
      </div>
      <div class="modal-body">
        <div class="form-grid">
          <div class="field full">
            <label>Project <span class="req">*</span></label>
            <select data-field="project_id">
              <option value="">Select a project…</option>
              ${projects.map(p => `<option value="${escapeHtml(p.id)}"${values.project_id === p.id ? ' selected' : ''}>${escapeHtml(p.project_name)}</option>`).join('')}
            </select>
          </div>
          <div class="field full">
            <label>Title <span class="req">*</span></label>
            <input data-field="title" type="text" value="${escapeHtml(values.title)}" placeholder="5 Things to Know Before Booking Here">
          </div>
          <div class="field full">
            <label>Slug <span class="req">*</span></label>
            <input data-field="slug" type="text" value="${escapeHtml(values.slug)}" placeholder="auto-generated-from-title">
            <span class="hint">Used in the post's URL. Unique per project.</span>
          </div>
          <div class="field full">
            <label>Excerpt</label>
            <textarea data-field="excerpt" placeholder="Short summary shown in blog listings" style="min-height:60px">${escapeHtml(values.excerpt)}</textarea>
          </div>
          <div class="field full">
            <label>Body <span class="req">*</span></label>
            <textarea data-field="body" placeholder="Full post content" style="min-height:220px">${escapeHtml(values.body)}</textarea>
          </div>
          <div class="field full" id="blog-cover-field">
            <label>Cover Image</label>
            <div id="blog-cover-slot"></div>
          </div>
          <div class="field">
            <label>Author</label>
            <input data-field="author" type="text" value="${escapeHtml(values.author)}" placeholder="Keys99 Editorial">
          </div>
          <div class="field">
            <label>Tags</label>
            <input data-field="tags" type="text" value="${escapeHtml(values.tags)}" placeholder="launch, amenities, offers">
          </div>
          <div class="field full">
            <label>Meta Description</label>
            <textarea data-field="meta_description" placeholder="SEO description for search results" style="min-height:60px">${escapeHtml(values.meta_description)}</textarea>
          </div>
          <div class="field">
            <label>Published Date</label>
            <input data-field="published_at" type="date" value="${escapeHtml(values.published_at)}">
          </div>
          <div class="field" style="justify-content:flex-end">
            <label style="flex-direction:row;align-items:center;gap:8px">
              <input type="checkbox" data-field="is_published" ${values.is_published ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--green)"> Published
            </label>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn-outline" data-close>Cancel</button>
        <button type="button" class="btn-primary" data-save>${existingId ? 'Save Changes' : 'Add Blog Post'}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  enhanceSelects(overlay);

  const coverSlot = overlay.querySelector('#blog-cover-slot');
  let cover = { path: values.cover_image_path, url: values.cover_image_url };
  renderCoverSlot();

  function renderCoverSlot() {
    if (cover.url) {
      coverSlot.innerHTML = `<div class="upload-thumb"><img src="${escapeHtml(cover.url)}"><span class="name">Cover image attached</span><button type="button" data-remove-cover>✕</button></div>`;
      coverSlot.querySelector('[data-remove-cover]').addEventListener('click', () => { cover = { path: null, url: null }; renderCoverSlot(); });
    } else {
      coverSlot.innerHTML = `<label class="upload-box">🖼️ Click to upload cover image<input type="file" accept="image/*"><span class="hint">${COVER_LIMITS.label}</span></label>`;
      coverSlot.querySelector('input[type=file]').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        if (file.size > COVER_LIMITS.maxBytes) { toast(`Too large. Max is ${(COVER_LIMITS.maxBytes / 1024 / 1024).toFixed(0)}MB.`, true); return; }
        if (!COVER_LIMITS.mimeTypes.includes(file.type)) { toast(`Unsupported file type. Allowed: ${COVER_LIMITS.label}.`, true); return; }
        coverSlot.innerHTML = `<div class="upload-box uploading">Uploading ${escapeHtml(file.name)}…</div>`;
        const safeName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        const path = `blog/${Date.now()}-${safeName}`;
        const { error } = await sb.storage.from(BUCKET).upload(path, file, { upsert: true });
        if (error) { toast(error.message, true); renderCoverSlot(); return; }
        cover = { path, url: sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl };
        renderCoverSlot();
        toast('Uploaded');
      });
    }
  }

  const titleInput = overlay.querySelector('[data-field="title"]');
  const slugInput = overlay.querySelector('[data-field="slug"]');
  slugInput.addEventListener('input', () => { slugTouched = true; });
  titleInput.addEventListener('input', () => {
    if (!slugTouched) slugInput.value = slugify(titleInput.value);
  });

  const close = () => { overlay.remove(); document.removeEventListener('keydown', escHandler); };
  const escHandler = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', escHandler);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));

  overlay.querySelector('[data-save]').addEventListener('click', async () => {
    const box = overlay.querySelector('.modal-box');
    const get = (key) => box.querySelector(`[data-field="${key}"]`);
    const payload = {
      project_id: get('project_id').value || null,
      title: get('title').value.trim(),
      slug: slugify(get('slug').value),
      excerpt: get('excerpt').value.trim() || null,
      body: get('body').value.trim(),
      author: get('author').value.trim() || null,
      tags: get('tags').value.split(',').map(t => t.trim()).filter(Boolean),
      meta_description: get('meta_description').value.trim() || null,
      published_at: get('published_at').value || null,
      is_published: get('is_published').checked,
      cover_image_path: cover.path,
      cover_image_url: cover.url
    };

    const missing = [];
    if (!payload.project_id) missing.push('Project');
    if (!payload.title) missing.push('Title');
    if (!payload.slug) missing.push('Slug');
    if (!payload.body) missing.push('Body');
    if (missing.length) { toast(`Please fill: ${missing.join(', ')}`, true); return; }

    const saveBtn = overlay.querySelector('[data-save]');
    saveBtn.disabled = true;
    const { error } = existingId
      ? await sb.from('residential_project_blogs').update({ ...payload, updated_by: currentUser.id }).eq('id', existingId)
      : await sb.from('residential_project_blogs').insert({ ...payload, created_by: currentUser.id });
    saveBtn.disabled = false;
    if (error) { toast(error.message, true); return; }

    toast(existingId ? 'Saved' : 'Added');
    close();
    onSaved();
  });
}

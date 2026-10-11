import { sb } from './supabase-client.js';
import { escapeHtml, toast, customConfirm, uploadBoxHead } from './utils.js';
import { enhanceSelects } from './custom-select.js';
import { prepareImageForUpload } from './image-compress.js';

// Image fields (type: 'image') upload to the public residential-media bucket under
// `directory/<folder>/` — every image compressed to WebP ≤ 100 KB first (CLAUDE.md) — and the
// field's value is the file's public URL.
const IMAGE_BUCKET = 'residential-media';
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'];
const PUBLIC_MARKER = `/storage/v1/object/public/${IMAGE_BUCKET}/`;
// Storage path of a URL this form uploaded (directory/…), or null for anything else.
function ownedPath(url) {
  const i = String(url || '').indexOf(PUBLIC_MARKER);
  if (i < 0) return null;
  const path = decodeURIComponent(url.slice(i + PUBLIC_MARKER.length).split(/[?#]/)[0]);
  return path.startsWith('directory/') ? path : null;
}
function removeOwned(urls) {
  const paths = [...new Set(urls.map(ownedPath).filter(Boolean))];
  if (paths.length) sb.storage.from(IMAGE_BUCKET).remove(paths).catch(() => {});
}

function imageBoxHtml(spec, url, busy) {
  if (busy) return `<div class="img-field-box ${spec.shape || 'wide'} busy"><div class="upload-spinner"></div><span>Optimizing &amp; uploading…</span></div>`;
  if (url) {
    return `<div class="img-field-box ${spec.shape || 'wide'} has-img">
      <img src="${escapeHtml(url)}" alt="">
      <div class="img-field-actions">
        <label class="btn-outline">Change<input type="file" accept="image/*" data-image-input="${spec.key}"></label>
        <button type="button" class="btn-outline danger" data-image-remove="${spec.key}">Remove</button>
      </div>
    </div>`;
  }
  return `<label class="upload-box img-field-empty ${spec.shape || 'wide'}">${uploadBoxHead(spec.shape === 'round' ? 'camera' : 'image', spec.cta || 'Upload image')}
    <input type="file" accept="image/*" data-image-input="${spec.key}">
    <span class="hint">${escapeHtml(spec.hint || 'JPG, PNG or WEBP · auto-compressed to WebP (max 100 KB)')}</span></label>`;
}

// A small generic modal for the simple, single-table add/edit forms (Developers, Agents,
// Cities) — these don't need the multi-step wizard machinery in project-form.js, just a
// handful of fields mapped straight onto one row.

function renderField(spec, value) {
  const req = spec.req ? '<span class="req">*</span>' : '';
  const attr = `data-field="${spec.key}"`;
  const fullCls = spec.full ? ' full' : '';
  let input;
  if (spec.type === 'image') {
    const label = spec.label ? `<label>${escapeHtml(spec.label)} ${req}</label>` : '';
    return `<div class="field full img-field" data-image-field="${spec.key}">${label}
      <input type="hidden" ${attr} value="${escapeHtml(value || '')}">
      <div data-image-slot="${spec.key}">${imageBoxHtml(spec, value || '')}</div></div>`;
  }
  if (spec.type === 'checkbox') {
    return `<div class="field${fullCls}"><label style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" ${attr} ${value ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--green)"> ${escapeHtml(spec.label)}</label></div>`;
  }
  if (spec.type === 'select') {
    input = `<select ${attr}>${spec.options.map(o => `<option value="${escapeHtml(o.value)}"${String(value ?? spec.default ?? '') === String(o.value) ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select>`;
  } else if (spec.type === 'textarea') {
    input = `<textarea ${attr} placeholder="${escapeHtml(spec.placeholder || '')}">${escapeHtml(value ?? '')}</textarea>`;
  } else {
    input = `<input ${attr} type="${spec.type || 'text'}" value="${value == null ? '' : escapeHtml(String(value))}" placeholder="${escapeHtml(spec.placeholder || '')}">`;
  }
  const label = spec.label ? `<label>${escapeHtml(spec.label)} ${req}</label>` : '';
  return `<div class="field${fullCls}">${label}${input}</div>`;
}

function readForm(box, fields) {
  const payload = {};
  for (const f of fields) {
    const el = box.querySelector(`[data-field="${f.key}"]`);
    if (f.type === 'checkbox') payload[f.key] = el.checked;
    else payload[f.key] = el.value.trim() === '' ? null : el.value.trim();
  }
  return payload;
}

// Wires the upload / change / remove controls of every image field in `box`. `state` tracks
// files uploaded while the form is open, so abandoned ones can be removed again.
function bindImageFields(box, fields, state) {
  fields.filter(f => f.type === 'image').forEach(spec => {
    const hidden = box.querySelector(`[data-field="${spec.key}"]`);
    const slot = box.querySelector(`[data-image-slot="${spec.key}"]`);
    const render = (busy) => {
      slot.innerHTML = imageBoxHtml(spec, hidden.value, busy);
      slot.querySelector('[data-image-input]')?.addEventListener('change', (e) => upload(e.target.files[0]));
      slot.querySelector('[data-image-remove]')?.addEventListener('click', () => { hidden.value = ''; render(false); });
    };
    async function upload(file) {
      if (!file) return;
      if (!IMAGE_TYPES.includes(file.type)) { toast('Unsupported image type. Use JPG, PNG, WEBP, AVIF or GIF.', true); return; }
      state.busy++; state.onBusy(); render(true);
      try {
        const out = await prepareImageForUpload(file);   // ≤ 100 KB WebP (CLAUDE.md)
        if (out.error) { toast(out.error, true); return; }
        const path = `directory/${spec.folder}/${Date.now()}-${out.file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
        const { error } = await sb.storage.from(IMAGE_BUCKET).upload(path, out.file, { upsert: false, contentType: out.file.type });
        if (error) { toast(error.message, true); return; }
        hidden.value = sb.storage.from(IMAGE_BUCKET).getPublicUrl(path).data.publicUrl;
        state.uploaded.push(hidden.value);
        toast(`Image uploaded${out.note}`);
      } finally {
        state.busy--; state.onBusy(); render(false);
      }
    }
    render(false);
  });
}

function closeModal(overlay) {
  removeOwned(overlay._imageState?.uploaded || []);   // uploaded but never saved
  overlay.remove();
  document.removeEventListener('keydown', overlay._escHandler);
}

// config: { title, subtitle, table, fields, existingId, onSaved }
// fields: [{ key, label, type: 'text'|'email'|'tel'|'url'|'textarea'|'checkbox'|'select', req, placeholder, options, default, full }]
export async function openEntityForm({ title, subtitle, table, fields, existingId, onSaved }) {
  let values = {};
  if (existingId) {
    const { data, error } = await sb.from(table).select('*').eq('id', existingId).single();
    if (error) { toast(error.message, true); return; }
    values = data;
  } else {
    for (const f of fields) if (f.default !== undefined) values[f.key] = f.default;
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-head">
        <div><h2>${escapeHtml(title)}</h2>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}</div>
        <button type="button" class="modal-close" data-close>✕</button>
      </div>
      <div class="modal-body">
        <div class="form-grid">${fields.map(f => renderField(f, values[f.key])).join('')}</div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn-outline" data-close>Cancel</button>
        <button type="button" class="btn-primary" data-save>${existingId ? 'Save Changes' : 'Add'}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  enhanceSelects(overlay);

  const saveBtnEl = overlay.querySelector('[data-save]');
  const imageState = overlay._imageState = { uploaded: [], busy: 0, onBusy: () => { saveBtnEl.disabled = imageState.busy > 0; } };
  bindImageFields(overlay.querySelector('.modal-box'), fields, imageState);
  const originalImages = Object.fromEntries(fields.filter(f => f.type === 'image').map(f => [f.key, values[f.key] || null]));

  const escHandler = (e) => { if (e.key === 'Escape') closeModal(overlay); };
  overlay._escHandler = escHandler;
  document.addEventListener('keydown', escHandler);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(overlay); });
  overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(overlay)));

  overlay.querySelector('[data-save]').addEventListener('click', async () => {
    const box = overlay.querySelector('.modal-box');
    const payload = readForm(box, fields);
    const missing = fields.filter(f => f.req && (payload[f.key] === null || payload[f.key] === undefined || payload[f.key] === ''));
    if (missing.length) { toast(`Please fill: ${missing.map(f => f.label).join(', ')}`, true); return; }

    const saveBtn = overlay.querySelector('[data-save]');
    saveBtn.disabled = true;
    const { error } = existingId
      ? await sb.from(table).update(payload).eq('id', existingId)
      : await sb.from(table).insert(payload);
    saveBtn.disabled = false;
    if (error) { toast(error.message, true); return; }

    // Saved: drop files no longer used — a replaced / removed original, and any image uploaded
    // in this form that isn't the one kept.
    const kept = new Set(fields.filter(f => f.type === 'image').map(f => payload[f.key]).filter(Boolean));
    removeOwned([...Object.values(originalImages), ...imageState.uploaded].filter(u => u && !kept.has(u)));
    imageState.uploaded = [];
    if (existingId) Object.keys(originalImages).forEach(k => { originalImages[k] = payload[k] || null; });

    onSaved && onSaved();

    if (existingId) {
      toast('Saved');
      closeModal(overlay);
      return;
    }

    // New record added — reset the fields back to blank and show a congratulations
    // banner above the form, instead of closing the modal, so another can be added right away.
    toast('Added');
    resetFormWithSuccess(box, fields, title);
    bindImageFields(box, fields, imageState);
  });
}

function resetFormWithSuccess(box, fields, title) {
  const grid = box.querySelector('.form-grid');
  const values = {};
  for (const f of fields) if (f.default !== undefined) values[f.key] = f.default;
  grid.innerHTML = fields.map(f => renderField(f, values[f.key])).join('');
  enhanceSelects(box);

  let banner = box.querySelector('.form-success-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'form-success-banner';
    grid.parentElement.insertBefore(banner, grid);
  }
  banner.innerHTML = `<span class="form-success-icon">🎉</span> Congratulations! ${escapeHtml(title)} added successfully.`;
  clearTimeout(banner._hideTimer);
  banner._hideTimer = setTimeout(() => banner.remove(), 4000);
}

export async function confirmDeleteEntity(table, id, label, onDeleted) {
  const ok = await customConfirm('This cannot be undone.', { title: `Delete ${label || 'this record'}?`, confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  const { error } = await sb.from(table).delete().eq('id', id);
  if (error) { toast(error.message, true); return; }
  toast('Deleted');
  onDeleted && onDeleted();
}

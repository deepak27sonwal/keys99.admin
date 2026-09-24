import { sb } from './supabase-client.js';
import { escapeHtml, toast, customConfirm } from './utils.js';
import { enhanceSelects } from './custom-select.js';

// A small generic modal for the simple, single-table add/edit forms (Developers, Agents,
// Cities) — these don't need the multi-step wizard machinery in project-form.js, just a
// handful of fields mapped straight onto one row.

function renderField(spec, value) {
  const req = spec.req ? '<span class="req">*</span>' : '';
  const attr = `data-field="${spec.key}"`;
  const fullCls = spec.full ? ' full' : '';
  let input;
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

function closeModal(overlay) {
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

    toast(existingId ? 'Saved' : 'Added');
    closeModal(overlay);
    onSaved && onSaved();
  });
}

export async function confirmDeleteEntity(table, id, label, onDeleted) {
  const ok = await customConfirm('This cannot be undone.', { title: `Delete ${label || 'this record'}?`, confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  const { error } = await sb.from(table).delete().eq('id', id);
  if (error) { toast(error.message, true); return; }
  toast('Deleted');
  onDeleted && onDeleted();
}

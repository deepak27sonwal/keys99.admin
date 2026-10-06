import { sb } from './supabase-client.js';
import { pageHead, escapeHtml, fmtDate, timeAgo, toast, customConfirm, icon } from './utils.js';
import { enhanceSelects } from './custom-select.js';
import { LOOKUP_LISTS } from './project-form.js';

// Settings page: site/contact defaults (app_settings), the project form's editable preset
// lists (lookup_options) and the signed-in admin's session controls. Editing defaults and
// lookup lists is super-admin only — RLS enforces that server-side; the read-only rendering
// here for everyone else is just UI on top of it.

const DEFAULT_FIELDS = [
  { key: 'enquiry_email', label: 'Enquiry Email', type: 'email', placeholder: 'e.g. sales@keys99.com' },
  { key: 'enquiry_phone', label: 'Enquiry Phone', type: 'tel', placeholder: 'e.g. +91 98765 43210' },
  { key: 'whatsapp_number', label: 'WhatsApp Number', type: 'tel', placeholder: 'e.g. +91 98765 43210' }
];

let lookupState = { listKey: LOOKUP_LISTS[0].key, groupKey: null };

export async function settingsPage(content, currentUser, isSuperAdmin) {
  content.innerHTML = pageHead('Settings', 'Site defaults, lookup lists and account security') + `<div class="empty">Loading…</div>`;

  const [settingsRes, citiesRes] = await Promise.all([
    sb.from('app_settings').select('*').eq('id', 1).maybeSingle(),
    sb.from('cities').select('id,name').order('name')
  ]);

  content.innerHTML = pageHead('Settings', 'Site defaults, lookup lists and account security') + `
    <div class="settings-stack">
      ${defaultsPanel(settingsRes, citiesRes.data || [], isSuperAdmin)}
      <div class="panel" id="lookup-panel"></div>
      ${securityPanel(currentUser)}
    </div>`;

  bindDefaults(content, currentUser, isSuperAdmin);
  bindSecurity(content);
  enhanceSelects(content.querySelector('#settings-defaults'));
  await renderLookupPanel(content.querySelector('#lookup-panel'), isSuperAdmin);
}

/* ---------------- site & contact defaults ---------------- */

function defaultsPanel({ data, error }, cities, isSuperAdmin) {
  if (error) return `<div class="panel"><div class="panel-head"><h2>Site &amp; Contact Defaults</h2></div><div class="notice">${escapeHtml(error.message)}</div></div>`;
  const s = data || {};
  const ro = isSuperAdmin ? '' : ' disabled';
  const inputs = DEFAULT_FIELDS.map(f => `
    <div class="field"><label>${escapeHtml(f.label)}</label>
      <input data-setting="${f.key}" type="${f.type}" value="${escapeHtml(s[f.key] ?? '')}" placeholder="${escapeHtml(f.placeholder)}"${ro}></div>`).join('');
  const cityOpts = `<option value="">— None —</option>` + cities.map(c =>
    `<option value="${c.id}"${c.id === s.default_city_id ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
  const updated = s.updated_by ? `<span class="hint">Last updated ${escapeHtml(timeAgo(s.updated_at))}</span>` : '';
  return `<div class="panel" id="settings-defaults">
    <div class="panel-head"><h2>Site &amp; Contact Defaults</h2>${updated}</div>
    <div class="settings-body">
      <div class="form-grid">${inputs}
        <div class="field"><label>Default City</label>
          <select data-setting="default_city_id"${ro}>${cityOpts}</select>
          <span class="hint">Pre-selected when adding a new project</span></div>
      </div>
      ${isSuperAdmin
        ? `<div class="settings-actions"><button type="button" class="btn-primary" id="save-defaults">Save Defaults</button></div>`
        : `<p class="hint settings-ro-note">Only super admins can change these defaults.</p>`}
    </div>
  </div>`;
}

function bindDefaults(content, currentUser, isSuperAdmin) {
  const btn = content.querySelector('#save-defaults');
  if (!btn || !isSuperAdmin) return;
  btn.addEventListener('click', async () => {
    const payload = { updated_at: new Date().toISOString(), updated_by: currentUser.id };
    content.querySelectorAll('[data-setting]').forEach(el => { payload[el.dataset.setting] = el.value.trim() || null; });
    if (payload.enquiry_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.enquiry_email)) { toast('Enter a valid enquiry email', true); return; }
    btn.disabled = true;
    const { error } = await sb.from('app_settings').update(payload).eq('id', 1);
    btn.disabled = false;
    if (error) { toast(error.message, true); return; }
    toast('Defaults saved');
  });
}

/* ---------------- lookup lists ---------------- */

async function renderLookupPanel(panel, isSuperAdmin) {
  const list = LOOKUP_LISTS.find(l => l.key === lookupState.listKey);
  if (list.groups && !list.groups.some(g => g.key === lookupState.groupKey)) lookupState.groupKey = list.groups[0].key;
  if (!list.groups) lookupState.groupKey = null;

  let q = sb.from('lookup_options').select('id,label,sort_order,is_active').eq('list_key', list.key).order('sort_order').order('label');
  q = lookupState.groupKey ? q.eq('group_key', lookupState.groupKey) : q.is('group_key', null);
  const { data: items, error } = await q;

  const listTabs = LOOKUP_LISTS.map(l =>
    `<button type="button" class="tab-pill${l.key === list.key ? ' active' : ''}" data-lookup-list="${l.key}">${escapeHtml(l.label)}</button>`).join('');
  const groupSelect = list.groups ? `<div class="field lookup-group"><label>Group</label><select id="lookup-group">${list.groups.map(g =>
    `<option value="${g.key}"${g.key === lookupState.groupKey ? ' selected' : ''}>${escapeHtml(g.label)}</option>`).join('')}</select></div>` : '';

  let rows;
  if (error) rows = `<div class="empty">${escapeHtml(error.message)}</div>`;
  else if (!items.length) rows = `<div class="empty">No items yet — the project form falls back to its built-in list.</div>`;
  else rows = items.map((it, i) => `
    <div class="lookup-row${it.is_active ? '' : ' inactive'}">
      <span class="lookup-label">${escapeHtml(it.label)}</span>
      ${isSuperAdmin ? `
        <label class="lookup-active"><input type="checkbox" data-lookup-toggle="${it.id}"${it.is_active ? ' checked' : ''}> Active</label>
        <button type="button" class="icon-btn" data-lookup-move="${i}" data-dir="-1" title="Move up"${i === 0 ? ' disabled' : ''}>↑</button>
        <button type="button" class="icon-btn" data-lookup-move="${i}" data-dir="1" title="Move down"${i === items.length - 1 ? ' disabled' : ''}>↓</button>
        <button type="button" class="icon-btn danger" data-lookup-delete="${it.id}" data-label="${escapeHtml(it.label)}" title="Delete">${icon('trash', 13)}</button>`
        : `<span class="hint">${it.is_active ? 'Active' : 'Hidden'}</span>`}
    </div>`).join('');

  const addRow = isSuperAdmin ? `
    <form class="lookup-add" id="lookup-add">
      <input type="text" id="lookup-new" placeholder="New item…" maxlength="120">
      <button type="submit" class="btn-primary">+ Add</button>
    </form>` : `<p class="hint settings-ro-note">Only super admins can edit lookup lists.</p>`;

  panel.innerHTML = `
    <div class="panel-head"><h2>Lookup Lists</h2><span class="hint">Preset options shown in the Add/Edit Project form</span></div>
    <div class="settings-body">
      <div class="tab-row">${listTabs}</div>
      ${groupSelect}
      <div class="lookup-list">${rows}</div>
      ${addRow}
    </div>`;

  const rerender = () => renderLookupPanel(panel, isSuperAdmin);

  panel.querySelectorAll('[data-lookup-list]').forEach(b => b.addEventListener('click', () => {
    lookupState = { listKey: b.dataset.lookupList, groupKey: null };
    rerender();
  }));
  const groupEl = panel.querySelector('#lookup-group');
  if (groupEl) {
    groupEl.addEventListener('change', () => { lookupState.groupKey = groupEl.value; rerender(); });
    enhanceSelects(panel);
  }
  if (!isSuperAdmin || error) return;

  panel.querySelector('#lookup-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = panel.querySelector('#lookup-new');
    const label = input.value.trim();
    if (!label) return;
    if (items.some(it => it.label.toLowerCase() === label.toLowerCase())) { toast('That item is already in this list', true); return; }
    const sort_order = items.length ? Math.max(...items.map(it => it.sort_order)) + 1 : 0;
    const { error: err } = await sb.from('lookup_options').insert({ list_key: list.key, group_key: lookupState.groupKey, label, sort_order });
    if (err) { toast(err.message, true); return; }
    toast('Item added');
    rerender();
  });

  panel.querySelectorAll('[data-lookup-toggle]').forEach(cb => cb.addEventListener('change', async () => {
    const { error: err } = await sb.from('lookup_options').update({ is_active: cb.checked }).eq('id', cb.dataset.lookupToggle);
    if (err) { toast(err.message, true); cb.checked = !cb.checked; return; }
    cb.closest('.lookup-row').classList.toggle('inactive', !cb.checked);
    toast(cb.checked ? 'Item shown in project form' : 'Item hidden from project form');
  }));

  panel.querySelectorAll('[data-lookup-move]').forEach(b => b.addEventListener('click', async () => {
    const i = Number(b.dataset.lookupMove);
    const j = i + Number(b.dataset.dir);
    if (j < 0 || j >= items.length) return;
    // Renumber the whole list so ties (e.g. two items both at 0) can't make a swap a no-op.
    const order = items.slice();
    [order[i], order[j]] = [order[j], order[i]];
    const changed = order.map((it, idx) => ({ it, idx })).filter(({ it, idx }) => it.sort_order !== idx);
    const results = await Promise.all(changed.map(({ it, idx }) => sb.from('lookup_options').update({ sort_order: idx }).eq('id', it.id)));
    const failed = results.find(r => r.error);
    if (failed) toast(failed.error.message, true);
    rerender();
  }));

  panel.querySelectorAll('[data-lookup-delete]').forEach(b => b.addEventListener('click', async () => {
    const ok = await customConfirm(`Delete "${b.dataset.label}" from this list? Projects that already use it keep their saved value.`, { title: 'Delete item', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    const { error: err } = await sb.from('lookup_options').delete().eq('id', b.dataset.lookupDelete);
    if (err) { toast(err.message, true); return; }
    toast('Item deleted');
    rerender();
  }));
}

/* ---------------- session & security ---------------- */

function securityPanel(user) {
  const provider = user?.app_metadata?.provider || 'email';
  const lastSignIn = user?.last_sign_in_at;
  return `<div class="panel">
    <div class="panel-head"><h2>Session &amp; Security</h2></div>
    <div class="settings-body">
      <div class="settings-facts">
        <div><span class="hint">Signed in as</span><strong>${escapeHtml(user?.email || '—')}</strong></div>
        <div><span class="hint">Sign-in method</span><strong>${escapeHtml(provider.replace(/^\w/, c => c.toUpperCase()))}</strong></div>
        <div><span class="hint">Last sign-in</span><strong>${lastSignIn ? `${escapeHtml(fmtDate(lastSignIn))} · ${escapeHtml(timeAgo(lastSignIn))}` : '—'}</strong></div>
      </div>
      <div class="settings-actions">
        <button type="button" class="btn-outline" id="signout-others">Sign out other devices</button>
        <button type="button" class="btn-primary danger" id="signout-all">Sign out everywhere</button>
      </div>
      <p class="hint settings-ro-note">Authentication and authorization are controlled by Supabase Auth and the <code>user_roles</code> table. No service-role key is stored in this frontend — access is enforced by database row-level security.</p>
    </div>
  </div>`;
}

function bindSecurity(content) {
  content.querySelector('#signout-others').addEventListener('click', async (e) => {
    const ok = await customConfirm('This ends your sessions on every other browser and device. You stay signed in here.', { title: 'Sign out other devices', confirmLabel: 'Sign out others' });
    if (!ok) return;
    e.target.disabled = true;
    const { error } = await sb.auth.signOut({ scope: 'others' });
    e.target.disabled = false;
    if (error) { toast(error.message, true); return; }
    toast('Signed out of all other devices');
  });
  content.querySelector('#signout-all').addEventListener('click', async () => {
    const ok = await customConfirm('This ends every session for your account, including this one. You will need to sign in again.', { title: 'Sign out everywhere', confirmLabel: 'Sign out everywhere', danger: true });
    if (!ok) return;
    const { error } = await sb.auth.signOut({ scope: 'global' });
    if (error) { toast(error.message, true); return; }
    location.replace('./login.html');
  });
}

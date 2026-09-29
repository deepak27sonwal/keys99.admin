import { sb } from './supabase-client.js';
import { pageHead, tablePanel, emptyRow, escapeHtml, fmtDate, toast, customConfirm, icon } from './utils.js';

// Super-admin-only: create/list/remove the panel's other admin accounts. All the actual
// authority lives server-side — the "manage-admins" Edge Function re-checks the caller is a
// super_admin itself (using a service-role client) before doing anything, and it's the only
// path that can create a Supabase Auth login, since that needs the service-role key, which
// never belongs in the browser. This page (and the sidebar link to it) is just UI gating on
// top of that; it's not the security boundary.
export async function adminsPage(content, navigate, isSuperAdmin) {
  if (!isSuperAdmin) {
    content.innerHTML = pageHead('Admins', 'Manage who can access this admin panel') +
      `<div class="empty">This page is restricted to super admins.</div>`;
    return;
  }

  content.innerHTML = pageHead('Admins', 'Manage who can access this admin panel') + `<div class="empty">Loading…</div>`;

  const { admins, error } = await callManageAdmins({ action: 'list' });
  if (error) {
    content.innerHTML = pageHead('Admins', 'Manage who can access this admin panel') + `<div class="empty">${escapeHtml(error)}</div>`;
    return;
  }

  const rows = admins.map(a => `
    <tr>
      <td>${escapeHtml(a.email || '—')}</td>
      <td><span class="pill ${a.role}">${a.role === 'super_admin' ? 'Super Admin' : 'Admin'}</span></td>
      <td>${fmtDate(a.created_at)}</td>
      <td>${a.role === 'admin' ? `<div class="row-actions"><button class="icon-btn danger" data-remove-admin="${a.user_id}" data-email="${escapeHtml(a.email || '')}">${icon('trash', 13)}</button></div>` : a.is_self ? '<span class="hint">You</span>' : ''}</td>
    </tr>`).join('');

  const toolbar = `<button type="button" class="btn-primary" id="add-admin-btn">+ Add Admin</button>`;

  content.innerHTML = pageHead('Admins', 'Manage who can access this admin panel') +
    tablePanel('Admin Accounts', toolbar, ['Email', 'Role', 'Added', 'Actions'], rows.length ? rows : emptyRow(4, 'No admins yet.'));

  content.querySelector('#add-admin-btn').addEventListener('click', () => openAddAdminForm(() => adminsPage(content, navigate, isSuperAdmin)));
  content.querySelectorAll('[data-remove-admin]').forEach(btn => btn.addEventListener('click', () =>
    removeAdmin(btn.dataset.removeAdmin, btn.dataset.email, () => adminsPage(content, navigate, isSuperAdmin))));
}

async function callManageAdmins(body) {
  const { data, error } = await sb.functions.invoke('manage-admins', { body });
  if (error) {
    // supabase-js only exposes the HTTP status on invoke() errors, not the JSON body — pull
    // the real message out of the response so a rejected non-super-admin call (or a bad
    // password, duplicate email, etc.) shows something useful instead of "Edge Function
    // returned a non-2xx status code".
    let message = error.message;
    try { message = (await error.context.json()).error || message; } catch { /* no JSON body */ }
    return { error: message };
  }
  return data;
}

function openAddAdminForm(onSaved) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box">
      <div class="modal-head">
        <div><h2>Add Admin</h2><p>They can sign in immediately with this email and password. They'll have full access except deleting projects or managing admins.</p></div>
        <button type="button" class="modal-close" data-close>✕</button>
      </div>
      <div class="modal-body">
        <div class="field full"><label>Full Name</label><input type="text" id="new-admin-name" placeholder="Jane Doe"></div>
        <div class="field full"><label>Email <span class="req">*</span></label><input type="email" id="new-admin-email" placeholder="jane@example.com"></div>
        <div class="field full"><label>Password <span class="req">*</span></label><input type="password" id="new-admin-password" placeholder="At least 8 characters"></div>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn-outline" data-close>Cancel</button>
        <button type="button" class="btn-primary" id="add-admin-submit">Add Admin</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => { overlay.remove(); document.removeEventListener('keydown', escHandler); };
  const escHandler = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', escHandler);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));

  overlay.querySelector('#add-admin-submit').addEventListener('click', async () => {
    const full_name = overlay.querySelector('#new-admin-name').value.trim();
    const email = overlay.querySelector('#new-admin-email').value.trim();
    const password = overlay.querySelector('#new-admin-password').value;
    if (!email || !password) { toast('Email and password are required', true); return; }
    if (password.length < 8) { toast('Password must be at least 8 characters', true); return; }

    const submitBtn = overlay.querySelector('#add-admin-submit');
    submitBtn.disabled = true;
    const { error } = await callManageAdmins({ action: 'create', email, password, full_name });
    submitBtn.disabled = false;
    if (error) { toast(error, true); return; }

    toast(`${email} added as admin`);
    close();
    onSaved();
  });
}

async function removeAdmin(userId, email, onRemoved) {
  const ok = await customConfirm(
    `"${email}" will lose access to this admin panel immediately. Their login isn't deleted — they can be re-added later.`,
    { title: 'Remove this admin?', confirmLabel: 'Remove', danger: true }
  );
  if (!ok) return;
  const { error } = await callManageAdmins({ action: 'remove', user_id: userId });
  if (error) { toast(error, true); return; }
  toast(`${email} removed`);
  onRemoved();
}

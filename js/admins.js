import { sb } from './supabase-client.js';
import { pageHead, tablePanel, emptyRow, escapeHtml, fmtDate, timeAgo, toast, customConfirm, icon } from './utils.js';

// Super-admin-only: create/list/remove the panel's other admin accounts, and see each one's
// live sign-in status (how many devices they're currently signed in on). All the actual
// authority lives server-side — the "manage-admins" Edge Function re-checks the caller is a
// super_admin itself (using a service-role client) before doing anything, and it's the only
// path that can create a Supabase Auth login or read session data, since both need the
// service-role key, which never belongs in the browser. This page (and the sidebar link to
// it) is just UI gating on top of that; it's not the security boundary.
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

  // A device is only counted while its auth.sessions row still exists, which Supabase drops
  // once the session's refresh token is revoked or fully expires — so "Signed in" here means
  // "has at least one still-valid session right now", the closest thing to real-time presence
  // this stack can show without a dedicated presence channel.
  const rows = admins.map(a => {
    const online = (a.session_count || 0) > 0;
    const status = online
      ? `<span class="pill verified">Signed in</span> <span class="hint">${a.session_count} device${a.session_count === 1 ? '' : 's'}${a.last_active ? ` · active ${escapeHtml(timeAgo(a.last_active))}` : ''}</span>`
      : `<span class="pill unverified">Signed out</span>${a.last_sign_in_at ? ` <span class="hint">last seen ${escapeHtml(timeAgo(a.last_sign_in_at))}</span>` : ''}`;
    return `
    <tr>
      <td>${escapeHtml(a.email || '—')}</td>
      <td><span class="pill ${escapeHtml(a.role)}">${a.role === 'super_admin' ? 'Super Admin' : 'Admin'}</span></td>
      <td>${status}</td>
      <td>${fmtDate(a.created_at)}</td>
      <td>${a.role === 'admin' || a.is_self ? `<div class="row-actions">
        <button class="icon-btn" data-set-password="${escapeHtml(a.user_id)}" data-email="${escapeHtml(a.email || '')}" data-self="${a.is_self ? '1' : ''}" title="Change password" aria-label="Change password for ${escapeHtml(a.email || 'this admin')}">${icon('key', 13)}</button>
        ${a.role === 'admin' ? `<button class="icon-btn danger" data-remove-admin="${escapeHtml(a.user_id)}" data-email="${escapeHtml(a.email || '')}" title="Remove admin" aria-label="Remove ${escapeHtml(a.email || 'this admin')}">${icon('trash', 13)}</button>` : '<span class="hint">You</span>'}
      </div>` : ''}</td>
    </tr>`;
  }).join('');

  const toolbar = `<button type="button" class="btn-primary" id="add-admin-btn">+ Add Admin</button>`;

  content.innerHTML = pageHead('Admins', 'Manage who can access this admin panel') +
    tablePanel('Admin Accounts', toolbar, ['Email', 'Role', 'Session', 'Added', 'Actions'], rows.length ? rows : emptyRow(5, 'No admins yet.'));

  content.querySelector('#add-admin-btn').addEventListener('click', () => openAddAdminForm(() => adminsPage(content, navigate, isSuperAdmin)));
  content.querySelectorAll('[data-remove-admin]').forEach(btn => btn.addEventListener('click', () =>
    removeAdmin(btn.dataset.removeAdmin, btn.dataset.email, () => adminsPage(content, navigate, isSuperAdmin))));
  content.querySelectorAll('[data-set-password]').forEach(btn => btn.addEventListener('click', () =>
    openSetPasswordForm(btn.dataset.setPassword, btn.dataset.email, !!btn.dataset.self)));
}

export async function callManageAdmins(body) {
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

// Same rule the manage-admins function enforces: 8–72 characters with a letter and a number.
function passwordProblem(pw) {
  if (pw.length < 8) return 'Password must be at least 8 characters.';
  if (new TextEncoder().encode(pw).length > 72) return 'Password must be at most 72 characters.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password must contain at least one letter and one number.';
  return null;
}

// 16 random characters from an unambiguous set (no 0/O, 1/l/I), always with a letter, a digit
// and a symbol.
function generatePassword() {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '!@#$%&*?'];
  const all = sets.join('');
  const pick = (chars) => chars[crypto.getRandomValues(new Uint32Array(1))[0] % chars.length];
  const out = sets.map(pick);
  while (out.length < 16) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}

// Super admins set a new password for an admin (or for themselves). The admin still needs the
// emailed code to sign in, so the password is only the first step.
function openSetPasswordForm(userId, email, isSelf) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="set-pw-title">
      <div class="modal-head">
        <div><h2 id="set-pw-title">Change password</h2><p>${isSelf ? 'Set a new password for your own account' : `Set a new password for <strong>${escapeHtml(email || 'this admin')}</strong>`}. Signing in still needs the code emailed to ${isSelf ? 'you' : 'them'}.</p></div>
        <button type="button" class="modal-close" data-close aria-label="Close">✕</button>
      </div>
      <form class="modal-body" id="set-pw-form" novalidate>
        <input type="text" name="username" autocomplete="username" value="${escapeHtml(email || '')}" hidden>
        <div class="field full"><label for="set-pw-new">New password <span class="req">*</span></label>
          <div class="pw-input"><input type="password" id="set-pw-new" autocomplete="new-password" placeholder="At least 8 characters, a letter and a number" maxlength="72">
            <button type="button" class="pw-toggle" data-toggle-pw aria-label="Show password">Show</button></div>
          <div class="pw-tools"><button type="button" class="link-btn" id="set-pw-generate">Generate a strong password</button><button type="button" class="link-btn" id="set-pw-copy" hidden>Copy</button></div>
        </div>
        <div class="field full"><label for="set-pw-confirm">Confirm new password <span class="req">*</span></label>
          <input type="password" id="set-pw-confirm" autocomplete="new-password" maxlength="72"></div>
        <div class="form-error" id="set-pw-error" role="alert" hidden></div>
      </form>
      <div class="modal-footer">
        <button type="button" class="btn-outline" data-close>Cancel</button>
        <button type="submit" form="set-pw-form" class="btn-primary" id="set-pw-submit">Change password</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const $ = (sel) => overlay.querySelector(sel);
  const newInput = $('#set-pw-new');
  const confirmInput = $('#set-pw-confirm');
  const errorBox = $('#set-pw-error');
  const showError = (msg) => { errorBox.textContent = msg; errorBox.hidden = !msg; };

  const close = () => { overlay.remove(); document.removeEventListener('keydown', escHandler); };
  const escHandler = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', escHandler);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  newInput.focus();

  const setVisible = (visible) => {
    newInput.type = confirmInput.type = visible ? 'text' : 'password';
    const t = $('[data-toggle-pw]');
    t.textContent = visible ? 'Hide' : 'Show';
    t.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
  };
  $('[data-toggle-pw]').addEventListener('click', () => setVisible(newInput.type === 'password'));
  $('#set-pw-generate').addEventListener('click', () => {
    const pw = generatePassword();
    newInput.value = confirmInput.value = pw;
    setVisible(true);
    $('#set-pw-copy').hidden = false;
    showError('');
  });
  $('#set-pw-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(newInput.value); toast('Password copied'); }
    catch { newInput.select(); toast('Copy failed — select the password and copy it', true); }
  });
  newInput.addEventListener('input', () => { $('#set-pw-copy').hidden = !newInput.value; showError(''); });
  confirmInput.addEventListener('input', () => showError(''));

  $('#set-pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = newInput.value;
    const problem = passwordProblem(pw);
    if (problem) { showError(problem); newInput.focus(); return; }
    if (pw !== confirmInput.value) { showError("The two passwords don't match."); confirmInput.focus(); return; }

    const submitBtn = $('#set-pw-submit');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';
    const { error } = await callManageAdmins({ action: 'set_password', user_id: userId, password: pw });
    submitBtn.disabled = false;
    submitBtn.textContent = 'Change password';
    if (error) { showError(error); return; }

    toast(isSelf ? 'Your password was changed' : `Password changed for ${email}. Share it with them privately.`);
    close();
  });
}

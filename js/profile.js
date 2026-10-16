import { sb } from './supabase-client.js';
import { pageHead, escapeHtml, fmtDate, timeAgo, toast, initials } from './utils.js';
import { passwordProblem, generatePassword } from './admins.js';

// Profile: the signed-in admin's own account.
//
// - Edit profile: full name and phone, saved to their public.profiles row (RLS lets anyone update
//   their own row; a trigger stops non-admins touching is_active / id / created_at) and the name
//   also to the auth user's metadata, so it shows wherever Supabase's user record is used.
// - Change password: like the sign-in itself, it is confirmed with a code emailed to the admin.
//   "Email me a code" calls auth.reauthenticate(), which sends a one-time code; the new password
//   is then saved with auth.updateUser({ password, nonce: code }). No current password is
//   needed (checking one would mean a password-only sign-in, which this panel doesn't accept),
//   and someone at an unattended, signed-in screen still can't change it without the inbox.
//   Supabase's own password rules (and leaked-password check, if on) apply on top of ours.

const PHONE_RE = /^\+?[0-9][0-9\s-]{6,18}[0-9]$/;

function friendlyAuthError(error) {
  const msg = String(error?.message || error || 'Something went wrong');
  const code = error?.code || '';
  if (code === 'same_password' || /different from the old/i.test(msg)) return 'Choose a password different from your current one.';
  if (code === 'reauthentication_not_valid' || /nonce|reauthentication|otp|expired|invalid/i.test(msg)) return 'That code is wrong or has expired. Request a new code and try again.';
  if (code === 'weak_password' || /weak|pwned|leaked/i.test(msg)) return msg.replace(/^AuthWeakPasswordError:\s*/, '');
  if (/rate limit|too many|security purposes/i.test(msg)) return 'Too many attempts. Please wait a minute and try again.';
  return msg;
}

export async function profilePage(content, { currentUser, currentRoles, onProfileChange }) {
  content.innerHTML = pageHead('Profile', 'Your account details, profile and password') + '<div class="empty">Loading…</div>';

  const [{ data: profile, error: profileError }, { data: userData }] = await Promise.all([
    sb.from('profiles').select('id,full_name,phone,created_at').eq('id', currentUser.id).maybeSingle(),
    sb.auth.getUser()
  ]);
  if (!content.isConnected) return;
  const user = userData?.user || currentUser;
  const fullName = profile?.full_name || user.user_metadata?.full_name || '';
  const roleLabel = currentRoles.includes('super_admin') ? 'Super Admin' : currentRoles.includes('admin') ? 'Admin' : (currentRoles[0] || 'Admin');

  content.innerHTML = pageHead('Profile', 'Your account details, profile and password') + `
    <section class="panel pf-card">
      <span class="pf-avatar" id="pf-avatar" aria-hidden="true">${escapeHtml(initials(fullName || user.email))}</span>
      <div class="pf-id">
        <h2 id="pf-name">${escapeHtml(fullName || user.email || 'Admin')}</h2>
        <div class="pf-email">${escapeHtml(user.email || '')}</div>
        <div class="pf-tags"><span class="pill ${currentRoles.includes('super_admin') ? 'super_admin' : 'admin'}">${escapeHtml(roleLabel)}</span></div>
      </div>
      <dl class="pf-facts">
        <div><dt>Member since</dt><dd>${escapeHtml(fmtDate(user.created_at || profile?.created_at))}</dd></div>
        <div><dt>Last sign-in</dt><dd>${user.last_sign_in_at ? escapeHtml(timeAgo(user.last_sign_in_at)) : '—'}</dd></div>
        <div><dt>Sign-in</dt><dd>Password + emailed code</dd></div>
      </dl>
    </section>

    <div class="pf-grid">
      <section class="panel">
        <div class="panel-head"><div><h2>Edit profile</h2><div class="an-sub">How you appear to other admins</div></div></div>
        <form class="pf-body" id="pf-form" novalidate>
          <div class="field"><label for="pf-full-name">Full name</label>
            <input type="text" id="pf-full-name" maxlength="80" autocomplete="name" value="${escapeHtml(fullName)}" placeholder="Your name"></div>
          <div class="field"><label for="pf-phone">Phone</label>
            <input type="tel" id="pf-phone" maxlength="20" autocomplete="tel" value="${escapeHtml(profile?.phone || '')}" placeholder="+91 98765 43210"></div>
          <div class="field"><label for="pf-email">Email</label>
            <input type="email" id="pf-email" value="${escapeHtml(user.email || '')}" disabled>
            <span class="hint">Your sign-in email. A super admin can change it from the Supabase dashboard.</span></div>
          ${profileError ? `<div class="form-error" role="alert">${escapeHtml(profileError.message)}</div>` : '<div class="form-error" id="pf-error" role="alert" hidden></div>'}
          <div class="pf-actions"><button type="submit" class="btn-primary" id="pf-save">Save changes</button></div>
        </form>
      </section>

      <section class="panel">
        <div class="panel-head"><div><h2>Change password</h2><div class="an-sub">Confirmed with a code sent to ${escapeHtml(user.email || 'your email')}</div></div></div>
        <div class="pf-body">
          <ol class="pf-steps" id="pw-steps"><li class="is-current">Get a code</li><li>Set new password</li></ol>
          <div id="pw-step-1">
            <p class="pf-help">We'll email you a one-time code to confirm it's you. It works once and expires after a few minutes.</p>
            <div class="form-error" id="pw-error-1" role="alert" hidden></div>
            <div class="pf-actions"><button type="button" class="btn-primary" id="pw-send">Email me a code</button></div>
          </div>
          <form id="pw-step-2" hidden novalidate>
            <input type="text" name="username" autocomplete="username" value="${escapeHtml(user.email || '')}" hidden>
            <div class="field"><label for="pw-code">Code from the email</label>
              <input type="text" id="pw-code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="123456"></div>
            <div class="field"><label for="pw-new">New password</label>
              <div class="pw-input"><input type="password" id="pw-new" autocomplete="new-password" maxlength="72" placeholder="At least 8 characters, a letter and a number">
                <button type="button" class="pw-toggle" id="pw-toggle" aria-label="Show password">Show</button></div>
              <div class="pw-tools"><button type="button" class="link-btn" id="pw-generate">Generate a strong password</button><button type="button" class="link-btn" id="pw-copy" hidden>Copy</button></div></div>
            <div class="field"><label for="pw-confirm">Confirm new password</label>
              <input type="password" id="pw-confirm" autocomplete="new-password" maxlength="72"></div>
            <div class="form-error" id="pw-error-2" role="alert" hidden></div>
            <div class="pf-actions">
              <button type="button" class="link-btn" id="pw-resend">Send a new code</button>
              <button type="submit" class="btn-primary" id="pw-save">Change password</button>
            </div>
          </form>
        </div>
      </section>
    </div>`;

  const $ = s => content.querySelector(s);
  const showError = (el, msg) => { if (!el) return; el.textContent = msg || ''; el.hidden = !msg; };
  const busy = (btn, on, label) => { btn.disabled = on; if (label) btn.textContent = label; };

  // ---- edit profile ----
  $('#pf-form').addEventListener('submit', async e => {
    e.preventDefault();
    const name = $('#pf-full-name').value.trim().replace(/\s+/g, ' ');
    const phone = $('#pf-phone').value.trim();
    const err = $('#pf-error');
    if (name.length > 80) { showError(err, 'Name must be at most 80 characters.'); return; }
    if (phone && !PHONE_RE.test(phone)) { showError(err, 'Enter a valid phone number (digits, spaces, an optional leading +).'); $('#pf-phone').focus(); return; }
    showError(err, '');
    const btn = $('#pf-save');
    busy(btn, true, 'Saving…');
    const row = { full_name: name || null, phone: phone || null };
    let { error } = await sb.from('profiles').update(row).eq('id', currentUser.id);
    if (!error && !profile) ({ error } = await sb.from('profiles').insert({ id: currentUser.id, ...row }));
    if (!error) {
      const res = await sb.auth.updateUser({ data: { full_name: name || null } });
      if (res.error) console.warn('auth metadata not updated', res.error);
    }
    busy(btn, false, 'Save changes');
    if (error) { showError(err, error.message); return; }
    $('#pf-name').textContent = name || user.email;
    $('#pf-avatar').textContent = initials(name || user.email);
    toast('Profile saved');
    onProfileChange?.({ full_name: name });
  });

  // ---- change password ----
  const step1 = $('#pw-step-1'), step2 = $('#pw-step-2');
  const steps = content.querySelectorAll('#pw-steps li');
  let cooldownTimer = null;

  async function sendCode(btn, errEl) {
    showError(errEl, '');
    const label = btn.textContent;
    busy(btn, true, 'Sending…');
    const { error } = await sb.auth.reauthenticate();
    if (error) { busy(btn, false, label); showError(errEl, friendlyAuthError(error)); return false; }
    // One code per minute (Supabase's limit too): count down on the resend button.
    let left = 60;
    const resend = $('#pw-resend');
    clearInterval(cooldownTimer);
    resend.disabled = true;
    resend.textContent = `Send a new code (${left}s)`;
    cooldownTimer = setInterval(() => {
      if (!resend.isConnected) { clearInterval(cooldownTimer); return; }
      left -= 1;
      if (left <= 0) { clearInterval(cooldownTimer); resend.disabled = false; resend.textContent = 'Send a new code'; }
      else resend.textContent = `Send a new code (${left}s)`;
    }, 1000);
    busy(btn, false, label);
    return true;
  }

  $('#pw-send').addEventListener('click', async () => {
    if (!(await sendCode($('#pw-send'), $('#pw-error-1')))) return;
    step1.hidden = true;
    step2.hidden = false;
    steps[0].classList.remove('is-current'); steps[0].classList.add('is-done');
    steps[1].classList.add('is-current');
    toast(`Code sent to ${user.email}`);
    $('#pw-code').focus();
  });
  $('#pw-resend').addEventListener('click', async () => {
    if (await sendCode($('#pw-resend'), $('#pw-error-2'))) toast(`New code sent to ${user.email}`);
  });

  const newInput = $('#pw-new'), confirmInput = $('#pw-confirm');
  const setVisible = visible => {
    newInput.type = confirmInput.type = visible ? 'text' : 'password';
    $('#pw-toggle').textContent = visible ? 'Hide' : 'Show';
    $('#pw-toggle').setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
  };
  $('#pw-toggle').addEventListener('click', () => setVisible(newInput.type === 'password'));
  $('#pw-generate').addEventListener('click', () => {
    newInput.value = confirmInput.value = generatePassword();
    setVisible(true);
    $('#pw-copy').hidden = false;
  });
  $('#pw-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(newInput.value); toast('Password copied'); }
    catch { newInput.select(); toast('Copy failed — select the password and copy it', true); }
  });
  newInput.addEventListener('input', () => { $('#pw-copy').hidden = !newInput.value; });
  [newInput, confirmInput, $('#pw-code')].forEach(i => i.addEventListener('input', () => showError($('#pw-error-2'), '')));

  step2.addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('#pw-error-2');
    const code = $('#pw-code').value.trim();
    const pw = newInput.value;
    if (!/^\d{6,10}$/.test(code)) { showError(err, 'Enter the code from the email.'); $('#pw-code').focus(); return; }
    const problem = passwordProblem(pw);
    if (problem) { showError(err, problem); newInput.focus(); return; }
    if (pw !== confirmInput.value) { showError(err, "The two passwords don't match."); confirmInput.focus(); return; }
    const btn = $('#pw-save');
    busy(btn, true, 'Saving…');
    const { error } = await sb.auth.updateUser({ password: pw, nonce: code });
    busy(btn, false, 'Change password');
    if (error) { showError(err, friendlyAuthError(error)); return; }
    clearInterval(cooldownTimer);
    sb.from('activity_log').insert({ actor_type: 'admin', actor_id: currentUser.id, action: 'admin_password_changed', entity_type: 'admin_account', entity_id: currentUser.id, metadata: { self: true, via: 'profile' } }).then(() => {}, () => {});
    toast('Password changed. Use it the next time you sign in.');
    step2.reset();
    setVisible(false);
    $('#pw-copy').hidden = true;
    step2.hidden = true;
    step1.hidden = false;
    steps.forEach(s => s.classList.remove('is-current', 'is-done'));
    steps[0].classList.add('is-current');
  });
}

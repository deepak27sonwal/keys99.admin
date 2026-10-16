import { emailCodeSignInTime } from './session-check.js';

// Automatic sign-out for the admin panel:
//   • after 1 hour with no activity (no click, key press, scroll or touch in any admin tab),
//     with a warning a minute before and a "Stay signed in" button;
//   • always 12 hours after the email-code sign-in, however active the admin is.
// The last activity time is kept in localStorage, so it is shared by every open admin tab and
// still counts when the panel is reopened later. Signing out sends the browser to
// login.html?signed_out=idle|max, which says why.

export const IDLE_LIMIT_MS = 60 * 60 * 1000;          // 1 hour
export const MAX_SESSION_MS = 12 * 60 * 60 * 1000;    // 12 hours
const WARN_BEFORE_MS = 60 * 1000;                     // warning shown 1 minute before
const CHECK_EVERY_MS = 15 * 1000;
const LAST_ACTIVE_KEY = 'k99-admin-last-active';

function readLastActive() {
  try { return Number(localStorage.getItem(LAST_ACTIVE_KEY)) || 0; } catch (_) { return 0; }
}
export function markActive(at = Date.now()) {
  try { localStorage.setItem(LAST_ACTIVE_KEY, String(at)); } catch (_) {}
}
export function clearActivity() {
  try { localStorage.removeItem(LAST_ACTIVE_KEY); } catch (_) {}
}

// Why this session must end now ('idle' | 'max'), or null if it may continue.
export function sessionExpiredReason(session, now = Date.now()) {
  const signedInAt = emailCodeSignInTime(session);
  if (signedInAt && now - signedInAt >= MAX_SESSION_MS) return 'max';
  const last = readLastActive();
  if (last && now - last >= IDLE_LIMIT_MS) return 'idle';
  return null;
}

// Starts the watch on the dashboard. `signOut(reason)` must sign out and leave the page.
export function startSessionTimeout(session, signOut) {
  const signedInAt = emailCodeSignInTime(session);
  if (!readLastActive()) markActive();

  // Activity: throttled so a busy page doesn't write to storage on every mouse move.
  let lastWrite = 0;
  const onActivity = () => {
    const now = Date.now();
    if (now - lastWrite < 20 * 1000) return;
    lastWrite = now;
    markActive(now);
    hideWarning();
  };
  ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach(type =>
    window.addEventListener(type, onActivity, { passive: true, capture: true }));

  let banner = null;
  let countdown = null;
  function showWarning(msLeft, reason) {
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'session-warning';
      banner.setAttribute('role', 'alertdialog');
      banner.innerHTML = '<span class="session-warning-text"></span><button type="button" class="btn-primary session-warning-stay">Stay signed in</button>';
      banner.querySelector('.session-warning-stay').addEventListener('click', () => { markActive(); hideWarning(); });
      document.body.appendChild(banner);
    }
    const stay = banner.querySelector('.session-warning-stay');
    stay.hidden = reason === 'max';   // the 12-hour limit can't be extended
    const secs = Math.max(0, Math.ceil(msLeft / 1000));
    banner.querySelector('.session-warning-text').textContent = reason === 'max'
      ? `Your 12-hour session ends in ${secs}s. Save your work - you'll need to sign in again.`
      : `You'll be signed out in ${secs}s because of inactivity.`;
  }
  function hideWarning() {
    if (banner) { banner.remove(); banner = null; }
  }

  let ended = false;
  function tick() {
    if (ended) return;
    const now = Date.now();
    const reason = sessionExpiredReason(session, now);
    if (reason) { ended = true; clearInterval(timer); clearInterval(countdown); hideWarning(); signOut(reason); return; }
    const idleLeft = readLastActive() + IDLE_LIMIT_MS - now;
    const maxLeft = signedInAt ? signedInAt + MAX_SESSION_MS - now : Infinity;
    const left = Math.min(idleLeft, maxLeft);
    if (left <= WARN_BEFORE_MS) {
      showWarning(left, maxLeft <= idleLeft ? 'max' : 'idle');
      if (!countdown) countdown = setInterval(tick, 1000);
    } else {
      hideWarning();
      if (countdown) { clearInterval(countdown); countdown = null; }
    }
  }
  const timer = setInterval(tick, CHECK_EVERY_MS);
  // Coming back to a tab that slept (phone locked, laptop closed): check straight away.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  window.addEventListener('focus', tick);
  // Another tab's activity resets this one's warning.
  window.addEventListener('storage', e => { if (e.key === LAST_ACTIVE_KEY) tick(); });
  tick();
}

// Admin sign-in is two steps (login.html): the password, then a code Supabase emails to the
// admin (the same email-code sign-in keys99.com uses). Only the session created by that code
// is kept, so the dashboard (js/app.js guard) and the login page only accept a session whose
// access token says it was made with an email code — a session from the password alone (or
// one left over from before this check existed) is signed out.
//
// Supabase records how a session was made in the access token's `amr` claim, e.g.
// [{ method: 'otp', timestamp }] for an email code / magic link, [{ method: 'password' }]
// for a password.

const EMAIL_CODE_METHODS = ['otp', 'magiclink'];

function tokenClaims(accessToken) {
  try {
    const part = String(accessToken || '').split('.')[1] || '';
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
    return JSON.parse(json);
  } catch (_) {
    return {};
  }
}

export function signedInWithEmailCode(session) {
  const amr = tokenClaims(session?.access_token).amr;
  return Array.isArray(amr) && amr.some(a => EMAIL_CODE_METHODS.includes(a && a.method));
}

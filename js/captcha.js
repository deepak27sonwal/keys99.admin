import { TURNSTILE_SITE_KEY } from './config.js';

// Cloudflare Turnstile (CAPTCHA) for the admin sign-in.
//
// Supabase has Authentication > Attack Protection > CAPTCHA switched on (the website uses
// the same Turnstile widget, keys99.com js/captcha.js), so every sign-in must send a fresh
// Turnstile token as options.captchaToken or Supabase refuses it with "no captcha_token
// found". The widget runs in Cloudflare's invisible mode: it only shows a box when it
// doubts the visitor. A token works once and for about five minutes.
//
// Phones on mobile data can take well over ten seconds to finish the invisible check, and a
// tab left in the background lets the check time out. So token() waits patiently (30 s by
// default) without restarting a check that is still running, reads the widget directly in
// case a callback was missed, and the widget resets itself whenever its token expires or its
// check times out, so a fresh token is always on the way.
//
// TURNSTILE_SITE_KEY (js/config.js) is the public site key; empty turns all of this off.
// The widget only works on hostnames listed for it in Cloudflare > Turnstile.

const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading = null;

export const captchaEnabled = () => !!TURNSTILE_SITE_KEY;

function load() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SRC;
      s.async = true;
      s.onload = () => resolve(window.turnstile);
      s.onerror = () => { loading = null; reject(new Error('Could not load the security check')); };
      document.head.appendChild(s);
    });
  }
  return loading;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// A Turnstile widget in `el` that keeps one usable token. token() waits (up to `waitMs`)
// for it and hands it out once; after that a new one is requested automatically.
export function createCaptcha(el) {
  let id = null;
  let current = null;
  let failed = false;
  let errorCode = null;
  let interactive = false;     // Cloudflare is showing a box the visitor has to tick

  const ts = () => window.turnstile;

  function reset() {
    current = null;
    failed = false;
    errorCode = null;
    interactive = false;
    if (id != null && ts()) { try { ts().reset(id); return; } catch (_) {} }
    render().catch(() => { failed = true; errorCode = 'script-blocked'; });
  }

  async function render() {
    if (!captchaEnabled() || !el) return;
    current = null;
    failed = false;
    errorCode = null;
    interactive = false;
    const t = await load();
    if (id != null) { try { t.remove(id); } catch (_) {} }
    el.innerHTML = '';
    id = t.render(el, {
      sitekey: TURNSTILE_SITE_KEY,
      appearance: 'interaction-only',
      'refresh-expired': 'auto',
      'refresh-timeout': 'auto',
      callback: tok => { current = tok; failed = false; interactive = false; },
      // An expired token or a timed-out check is replaced straight away.
      'expired-callback': () => { current = null; reset(); },
      'timeout-callback': () => { current = null; reset(); },
      'before-interactive-callback': () => { interactive = true; },
      'after-interactive-callback': () => { interactive = false; },
      // Cloudflare's error code, e.g. 110200 = this website's address isn't allowed for the
      // widget (Cloudflare > Turnstile > Hostname management). Returning true stops it retrying.
      'error-callback': code => { current = null; failed = true; errorCode = code || 'unknown'; return true; }
    });
  }

  // Reads a finished token straight from the widget, in case its callback was missed.
  function peek() {
    if (current) return current;
    if (id != null && ts()) {
      try { const r = ts().getResponse(id); if (r) current = r; } catch (_) {}
    }
    return current;
  }

  async function token(waitMs = 30000) {
    if (!captchaEnabled()) return null;
    if (id == null) await render().catch(() => { failed = true; errorCode = 'script-blocked'; });
    const started = Date.now();
    let restarted = false;
    while (!peek() && !failed) {
      const waited = Date.now() - started;
      if (waited >= waitMs) break;
      // Halfway with nothing to show and no box to tick: the check is probably stuck (e.g.
      // the page sat in the background), so start it once more.
      if (!restarted && !interactive && waited >= waitMs / 2) { restarted = true; reset(); }
      await sleep(250);
    }
    const t = current;
    if (t) { current = null; reset(); }   // single-use: get the next one ready
    return t;
  }

  render().catch(() => { failed = true; errorCode = 'script-blocked'; });
  return {
    token,
    // Only restarts a widget that failed; a check still in progress is left to finish.
    refresh: () => { if (failed || id == null) reset(); },
    error: () => errorCode,
    isInteractive: () => interactive
  };
}

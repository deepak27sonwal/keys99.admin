import { TURNSTILE_SITE_KEY } from './config.js';

// Cloudflare Turnstile (CAPTCHA) for the admin sign-in and password reset.
//
// Supabase has Authentication > Attack Protection > CAPTCHA switched on (the website uses
// the same Turnstile widget, keys99.com js/captcha.js), so every sign-in must send a fresh
// Turnstile token as options.captchaToken or Supabase refuses it with "no captcha_token
// found". The widget runs in Cloudflare's invisible mode: it only shows a box when it
// doubts the visitor. A token works once and for about five minutes.
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

// A Turnstile widget in `el` that keeps one usable token. token() waits (up to `waitMs`)
// for it and hands it out once; after that a new one is requested automatically.
export function createCaptcha(el) {
  let id = null;
  let current = null;
  let failed = false;

  async function render() {
    if (!captchaEnabled() || !el) return;
    current = null;
    failed = false;
    const ts = await load();
    if (id != null) { try { ts.remove(id); } catch (_) {} }
    el.innerHTML = '';
    id = ts.render(el, {
      sitekey: TURNSTILE_SITE_KEY,
      appearance: 'interaction-only',
      callback: t => { current = t; failed = false; },
      'expired-callback': () => { current = null; },
      'timeout-callback': () => { current = null; },
      'error-callback': () => { current = null; failed = true; }
    });
  }

  function refresh() {
    current = null;
    if (id != null && window.turnstile) { try { window.turnstile.reset(id); return; } catch (_) {} }
    render().catch(() => {});
  }

  async function token(waitMs = 10000) {
    if (!captchaEnabled()) return null;
    if (id == null) await render().catch(() => { failed = true; });
    for (let waited = 0; !current && !failed && waited < waitMs; waited += 250) {
      await new Promise(r => setTimeout(r, 250));
    }
    const t = current;
    if (t) refresh();          // single-use: get the next one ready
    return t;
  }

  render().catch(() => { failed = true; });
  return { token, refresh };
}

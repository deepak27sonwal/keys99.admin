import { sb } from './supabase-client.js';
import { pageHead, tablePanel, emptyRow, escapeHtml, fmtDate, toast, customConfirm, icon, pill } from './utils.js';
import { attachListFilters, titleCase } from './list-filters.js';
import { loadEditor, createEditor, sanitizeHtml, htmlForEditor, htmlToPlainText } from './rich-text.js';
import { prepareImageForUpload } from './image-compress.js';
import { buildEmailHtml, fillSampleMergeTags, MERGE_TAGS } from './email-template.js';

// Newsletter: write emails in a rich-text composer and send them to newsletter subscribers
// and registered website users (who are added to the subscriber list automatically — see
// the send-newsletter edge function's sync_users action). Sending happens server-side in
// the send-newsletter function through Brevo, in batches the page drives with a progress
// bar; every email carries a personal unsubscribe link (unsubscribe.html).
//
// Tables: newsletter_subscribers, newsletter_campaigns, newsletter_campaign_recipients.

const SOURCE_LABELS = { registered_user: 'Registered user', website: 'Website form', newsletter: 'Website form', admin: 'Added by admin', import: 'Imported' };
const AUDIENCES = [
  { key: 'all', label: 'Everyone subscribed', hint: 'Subscribers and registered users' },
  { key: 'website', label: 'Newsletter subscribers', hint: 'Signed up on the website or added here' },
  { key: 'registered_user', label: 'Registered users', hint: 'People with a keys99.com account' },
  { key: 'custom', label: 'Selected people', hint: 'Pick specific subscribers or users' }
];
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'];

let activeTab = 'campaigns';
let syncedThisSession = false;

const sourceLabel = s => SOURCE_LABELS[s] || titleCase(s || 'website');

async function callFn(action, payload = {}) {
  const { data, error } = await sb.functions.invoke('send-newsletter', { body: { action, ...payload } });
  if (error) {
    let msg = error.message;
    try { const j = await error.context?.json(); if (j?.error) msg = j.error; } catch { /* keep generic */ }
    throw new Error(msg);
  }
  return data;
}

// Every subscriber row (Supabase returns at most 1,000 per request).
async function loadAllSubscribers() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('newsletter_subscribers')
      .select('id,email,full_name,city,property_interest,source,is_subscribed,user_id,created_at,unsubscribed_at')
      .order('created_at', { ascending: false }).range(from, from + 999);
    if (error) return { data: rows, error };
    rows.push(...(data || []));
    if (!data || data.length < 1000) return { data: rows, error: null };
  }
}

export async function newsletterPage(content, currentUser) {
  const subtitle = 'Write and send emails to newsletter subscribers and registered users';
  content.innerHTML = pageHead('Newsletter', subtitle) + `<div class="empty">Loading…</div>`;

  // Registered website users count as subscribers — add any new sign-ups once per session.
  if (!syncedThisSession) {
    syncedThisSession = true;
    try { await callFn('sync_users'); } catch (e) { console.warn('Newsletter user sync failed', e); }
  }

  const [subsRes, campRes] = await Promise.all([
    loadAllSubscribers(),
    sb.from('newsletter_campaigns').select('id,subject,status,audience_filter,total_recipients,sent_count,failed_count,created_at,updated_at,sent_at,last_error').order('created_at', { ascending: false }).limit(200)
  ]);
  const error = subsRes.error || campRes.error;
  if (error) {
    const hint = /permission|policy|denied/i.test(error.message) ? ' Your role may not have access to the newsletter tables yet — see README → Newsletter.' : '';
    content.innerHTML = pageHead('Newsletter', subtitle) + `<div class="empty">${escapeHtml(error.message + hint)}</div>`;
    return;
  }
  const subscribers = subsRes.data;
  const campaigns = campRes.data || [];
  const reload = () => newsletterPage(content, currentUser);

  const subscribed = subscribers.filter(s => s.is_subscribed);
  const stat = (label, value, sub) => `<div class="nl-stat"><span>${label}</span><b>${value.toLocaleString('en-IN')}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const stats = `<div class="nl-stats">
    ${stat('Subscribed', subscribed.length, 'will receive emails')}
    ${stat('Registered users', subscribed.filter(s => s.source === 'registered_user').length, 'with a keys99.com account')}
    ${stat('Unsubscribed', subscribers.length - subscribed.length, '')}
    ${stat('Emails sent', campaigns.reduce((n, c) => n + (c.sent_count || 0), 0), `${campaigns.filter(c => c.status === 'sent').length} newsletters`)}
  </div>`;
  const tabs = `<div class="tab-row">
    <button type="button" class="tab-pill${activeTab === 'campaigns' ? ' active' : ''}" data-nl-tab="campaigns">Emails <span class="count">${campaigns.length}</span></button>
    <button type="button" class="tab-pill${activeTab === 'subscribers' ? ' active' : ''}" data-nl-tab="subscribers">Subscribers <span class="count">${subscribers.length}</span></button>
  </div>`;

  content.innerHTML = pageHead('Newsletter', subtitle) + stats + tabs + `<div id="nl-tab-body"></div>`;
  content.querySelectorAll('[data-nl-tab]').forEach(b => b.addEventListener('click', () => { activeTab = b.dataset.nlTab; reload(); }));
  const body = content.querySelector('#nl-tab-body');
  if (activeTab === 'subscribers') renderSubscribers(body, subscribers, reload);
  else renderCampaigns(body, campaigns, subscribers, currentUser, reload);
}

/* ---------------- Emails (campaigns) ---------------- */

function audienceSummary(f = {}, subscribers) {
  const a = AUDIENCES.find(x => x.key === (f.type || 'all')) || AUDIENCES[0];
  if (f.type === 'custom') {
    const n = (f.subscriber_ids || []).length;
    if (n === 1) {
      const s = subscribers.find(x => x.id === f.subscriber_ids[0]);
      if (s) return escapeHtml(s.full_name || s.email);
    }
    return `${n} selected ${n === 1 ? 'person' : 'people'}`;
  }
  const bits = [...(f.cities || []), ...(f.interests || []).map(titleCase)];
  return escapeHtml(a.label + (bits.length ? ` · ${bits.join(', ')}` : ''));
}

function renderCampaigns(el, campaigns, subscribers, currentUser, reload) {
  const statusPill = c => {
    if (c.status === 'sent' && c.failed_count) return `<span class="pill followup">sent · ${c.failed_count} failed</span>`;
    return pill(c.status);
  };
  const rows = campaigns.map(c => {
    const progress = c.total_recipients ? `${(c.sent_count || 0).toLocaleString('en-IN')} / ${c.total_recipients.toLocaleString('en-IN')}` : '—';
    const actions = [];
    if (c.status === 'draft' || c.status === 'failed') actions.push(`<button class="icon-btn" data-nl-edit="${c.id}" title="Edit">${icon('edit', 13)}</button>`);
    if (c.status === 'sending') actions.push(`<button class="icon-btn" data-nl-resume="${c.id}" title="Continue sending">${icon('refresh', 13)}</button>`);
    if (c.status !== 'draft') actions.push(`<button class="icon-btn" data-nl-report="${c.id}" title="Delivery report">${icon('eye', 13)}</button>`);
    actions.push(`<button class="icon-btn" data-nl-copy="${c.id}" title="Duplicate">${icon('layers', 13)}</button>`);
    if (c.status === 'draft') actions.push(`<button class="icon-btn danger" data-nl-delete="${c.id}" title="Delete draft">${icon('trash', 13)}</button>`);
    return `<tr>
      <td><strong>${escapeHtml(c.subject || '(no subject)')}</strong>${c.last_error && c.status !== 'draft' ? `<div class="proj-code nl-error" title="${escapeHtml(c.last_error)}">⚠ ${escapeHtml(c.last_error.slice(0, 80))}</div>` : ''}</td>
      <td>${audienceSummary(c.audience_filter, subscribers)}</td>
      <td>${statusPill(c)}</td>
      <td>${progress}</td>
      <td>${fmtDate(c.sent_at || c.updated_at || c.created_at)}</td>
      <td><div class="row-actions">${actions.join('')}</div></td>
    </tr>`;
  }).join('');
  el.innerHTML = tablePanel('Emails', `<div class="toolbar"><button type="button" class="btn-primary" id="nl-new">+ New Email</button></div>`,
    ['Subject', 'Audience', 'Status', 'Sent', 'Date', 'Actions'],
    rows || emptyRow(6, 'No emails yet. Click "+ New Email" to write the first one.'));

  if (campaigns.length) attachListFilters({
    panel: el.querySelector('.panel'), items: campaigns, rows: [...el.querySelectorAll('tbody tr')],
    stateKey: 'newsletter-campaigns', title: 'Filter Emails', noun: ['email', 'emails'],
    searchText: c => c.subject || '', searchPlaceholder: 'Search subject',
    filters: [{ key: 'status', label: 'Status', get: c => c.status }]
  });

  const byId = Object.fromEntries(campaigns.map(c => [c.id, c]));
  el.querySelector('#nl-new').addEventListener('click', () => openComposer({ subscribers, currentUser, onDone: reload }));
  el.querySelectorAll('[data-nl-edit]').forEach(b => b.addEventListener('click', () => openComposer({ subscribers, currentUser, campaignId: b.dataset.nlEdit, onDone: reload })));
  el.querySelectorAll('[data-nl-copy]').forEach(b => b.addEventListener('click', () => openComposer({ subscribers, currentUser, copyFromId: b.dataset.nlCopy, onDone: reload })));
  el.querySelectorAll('[data-nl-report]').forEach(b => b.addEventListener('click', () => openReport(byId[b.dataset.nlReport])));
  el.querySelectorAll('[data-nl-resume]').forEach(b => b.addEventListener('click', async () => { await runSending(byId[b.dataset.nlResume]); reload(); }));
  el.querySelectorAll('[data-nl-delete]').forEach(b => b.addEventListener('click', async () => {
    const c = byId[b.dataset.nlDelete];
    if (!(await customConfirm(`"${c.subject || 'Untitled'}" will be deleted.`, { title: 'Delete draft?', confirmLabel: 'Delete', danger: true }))) return;
    const { error } = await sb.from('newsletter_campaigns').delete().eq('id', c.id);
    if (error) { toast(error.message, true); return; }
    toast('Draft deleted');
    reload();
  }));
}

// Sends the queued recipients of a campaign in batches, showing progress. Safe to call again
// for a campaign left in 'sending' (e.g. the tab was closed mid-way) — it picks up where it
// stopped.
async function runSending(campaign) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:440px">
    <div class="modal-head"><div><h2>Sending “${escapeHtml(campaign.subject)}”</h2><p>Keep this tab open until it finishes.</p></div></div>
    <div class="modal-body">
      <div class="nl-progress"><div class="nl-progress-bar" id="nl-bar"></div></div>
      <div class="nl-progress-text" id="nl-progress-text">Starting…</div>
    </div>
    <div class="modal-footer"><button type="button" class="btn-primary" id="nl-progress-close" disabled>Close</button></div>
  </div>`;
  document.body.appendChild(overlay);
  const bar = overlay.querySelector('#nl-bar');
  const text = overlay.querySelector('#nl-progress-text');
  const closeBtn = overlay.querySelector('#nl-progress-close');
  const done = new Promise(resolve => closeBtn.addEventListener('click', () => { overlay.remove(); resolve(); }));
  const unsubscribePage = new URL('./unsubscribe.html', location.href).href;
  let result = null;
  try {
    for (let guard = 0; guard < 2000; guard++) {
      result = await callFn('send_batch', { campaign_id: campaign.id, unsubscribe_page: unsubscribePage });
      const total = result.sent + result.failed + result.remaining;
      bar.style.width = `${total ? Math.round(((result.sent + result.failed) / total) * 100) : 100}%`;
      text.textContent = `${result.sent.toLocaleString('en-IN')} sent${result.failed ? ` · ${result.failed} failed` : ''} · ${result.remaining.toLocaleString('en-IN')} to go`;
      if (!result.remaining) break;
    }
    if (result && !result.sent && result.failed) {
      text.innerHTML = `<b>Nothing was delivered.</b> ${escapeHtml(result.last_error || '')}`;
      overlay.querySelector('.modal-box').classList.add('nl-failed');
    } else {
      text.innerHTML = `<b>Done.</b> ${result.sent.toLocaleString('en-IN')} email${result.sent === 1 ? '' : 's'} sent${result.failed ? `, ${result.failed} failed — see the delivery report` : ''}.`;
    }
  } catch (e) {
    text.innerHTML = `<b>Sending paused:</b> ${escapeHtml(e.message)}<br>Use “Continue sending” on the Emails list to resume.`;
  }
  closeBtn.disabled = false;
  await done;
}

async function openReport(c) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:720px">
    <div class="modal-head"><div><h2>${escapeHtml(c.subject)}</h2><p>Delivery report · ${pill(c.status)}</p></div><button type="button" class="modal-close" data-close>✕</button></div>
    <div class="modal-body"><div class="empty">Loading…</div></div>
  </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay || e.target.closest('[data-close]')) close(); });

  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('newsletter_campaign_recipients')
      .select('status,error_message,sent_at,subscriber:newsletter_subscribers(email,full_name)')
      .eq('campaign_id', c.id).order('sent_at', { ascending: false, nullsFirst: false }).range(from, from + 999);
    if (error) { overlay.querySelector('.modal-body').innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`; return; }
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const count = st => rows.filter(r => r.status === st).length;
  overlay.querySelector('.modal-body').innerHTML = `
    <div class="nl-stats nl-stats-sm">
      <div class="nl-stat"><span>Recipients</span><b>${rows.length}</b></div>
      <div class="nl-stat"><span>Sent</span><b>${count('sent')}</b></div>
      <div class="nl-stat"><span>Failed</span><b>${count('failed')}</b></div>
      <div class="nl-stat"><span>Waiting</span><b>${count('queued')}</b></div>
    </div>
    <div class="table-wrap"><table><thead><tr><th>Recipient</th><th>Status</th><th>Time / reason</th></tr></thead><tbody>
      ${rows.map(r => `<tr><td>${escapeHtml(r.subscriber?.full_name || '')}<div class="proj-code">${escapeHtml(r.subscriber?.email || '(deleted)')}</div></td>
        <td>${pill(r.status)}</td><td>${r.status === 'failed' ? `<span class="nl-error">${escapeHtml(r.error_message || '')}</span>` : (r.sent_at ? fmtDate(r.sent_at) : '—')}</td></tr>`).join('') || emptyRow(3, 'No recipients.')}
    </tbody></table></div>`;
}

/* ---------------- Composer ---------------- */

async function openComposer({ subscribers, currentUser, campaignId, copyFromId, onDone }) {
  let campaign = { subject: '', preheader: '', body_html: '', audience_filter: { type: 'all', cities: [], interests: [], subscriber_ids: [] }, status: 'draft' };
  const sourceId = campaignId || copyFromId;
  const [loaded, settings] = await Promise.all([
    sourceId ? sb.from('newsletter_campaigns').select('*').eq('id', sourceId).single() : null,
    sb.from('app_settings').select('enquiry_email,enquiry_phone').eq('id', 1).maybeSingle(),
    loadEditor().catch(e => e)
  ]);
  if (loaded?.error) { toast(loaded.error.message, true); return; }
  if (!window.Quill) { toast('The text editor could not be loaded — check your connection and try again.', true); return; }
  if (loaded?.data) {
    const d = loaded.data;
    campaign = { ...campaign, subject: d.subject || '', preheader: d.preheader || '', body_html: d.body_html || '', audience_filter: { ...campaign.audience_filter, ...(d.audience_filter || {}) } };
    if (copyFromId) campaign.subject = `Copy of ${campaign.subject}`;
  }
  let id = campaignId || null;
  const audience = { ...campaign.audience_filter, cities: [...(campaign.audience_filter.cities || [])], interests: [...(campaign.audience_filter.interests || [])], subscriber_ids: [...(campaign.audience_filter.subscriber_ids || [])] };
  const contact = { email: settings?.data?.enquiry_email, phone: settings?.data?.enquiry_phone };
  const logoUrl = /^https:/.test(location.href) ? new URL('./assets/images/logo.png', location.href).href : null;

  const subscribed = subscribers.filter(s => s.is_subscribed);
  const distinct = key => [...new Set(subscribed.map(s => s[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const cities = distinct('city');
  const interests = distinct('property_interest');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay blog-editor-overlay';
  overlay.innerHTML = `
    <div class="modal-box blog-editor" role="dialog" aria-modal="true" aria-label="Newsletter email">
      <div class="modal-head">
        <div><h2>${campaignId ? 'Edit Email' : 'New Email'}</h2><p>Sent from Keys99 &lt;newsletter@keys99.com&gt;</p></div>
        <div class="blog-mode" role="tablist">
          <button type="button" class="active" data-mode="write">Write</button>
          <button type="button" data-mode="preview">Preview</button>
        </div>
        <button type="button" class="modal-close" data-close aria-label="Close">✕</button>
      </div>
      <div class="modal-body blog-editor-body">
        <div class="blog-main">
          <div data-pane="write">
            <div class="field full"><label>Subject <span class="req">*</span> <span class="hint" data-count="subject"></span></label>
              <input data-field="subject" type="text" value="${escapeHtml(campaign.subject)}" placeholder="e.g. New launch in Punawale — 2 & 3 BHK from ₹78 L" maxlength="150"></div>
            <div class="field full"><label>Preview text <span class="hint" data-count="preheader"></span></label>
              <input data-field="preheader" type="text" value="${escapeHtml(campaign.preheader)}" placeholder="Short line shown next to the subject in the inbox" maxlength="200"></div>
            <div class="field full">
              <label>Message <span class="req">*</span></label>
              <div class="nl-merge">Personalise: ${MERGE_TAGS.map(t => `<button type="button" class="chip" data-merge="${t.tag}">${t.label}</button>`).join('')}
                <span class="hint">e.g. “Hi {{first_name}},” becomes “Hi Rahul,”</span></div>
              <div class="blog-editor-wrap"><div id="nl-quill"></div></div>
            </div>
          </div>
          <div data-pane="preview" hidden>
            <div class="nl-preview-bar">
              <div class="nl-inbox"><b id="nl-pv-subject"></b><span id="nl-pv-pre"></span></div>
              <div class="blog-mode nl-device"><button type="button" class="active" data-device="desktop">Desktop</button><button type="button" data-device="mobile">Mobile</button></div>
            </div>
            <div class="nl-preview-frame-wrap"><iframe id="nl-preview" title="Email preview" sandbox="allow-same-origin"></iframe></div>
            <p class="hint" style="text-align:center;margin-top:8px">Shown for a sample recipient “Rahul Sharma”.</p>
          </div>
        </div>
        <aside class="blog-side">
          <section class="blog-card">
            <h3>Send to</h3>
            <div class="nl-audiences">${AUDIENCES.map(a => `
              <label class="nl-audience"><input type="radio" name="nl-audience" value="${a.key}"${audience.type === a.key ? ' checked' : ''}>
                <span><b>${a.label}</b><small>${a.hint}</small></span><em data-aud-count="${a.key}"></em></label>`).join('')}
            </div>
            <div id="nl-picker" hidden>
              <div class="tag-input" id="nl-picked"><input type="text" placeholder="Search name or email…" aria-label="Find people"></div>
              <div class="nl-suggest" id="nl-suggest"></div>
            </div>
            <div id="nl-segment">
              ${cities.length ? `<div class="field"><label>City <span class="hint">· optional</span></label><div class="chip-row">${cities.map(c => `<button type="button" class="chip${audience.cities.includes(c) ? ' active' : ''}" data-city="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join('')}</div></div>` : ''}
              ${interests.length ? `<div class="field"><label>Interested in <span class="hint">· optional</span></label><div class="chip-row">${interests.map(c => `<button type="button" class="chip${audience.interests.includes(c) ? ' active' : ''}" data-interest="${escapeHtml(c)}">${escapeHtml(titleCase(c))}</button>`).join('')}</div></div>` : ''}
            </div>
            <div class="nl-total" id="nl-total"></div>
          </section>
          <section class="blog-card">
            <h3>Send a test</h3>
            <div class="field"><input data-field="test_to" type="email" value="${escapeHtml(currentUser?.email || '')}" placeholder="you@example.com"></div>
            <button type="button" class="btn-outline" id="nl-test">Send test email</button>
            <span class="hint">Marked [TEST]; merge tags use sample values.</span>
          </section>
        </aside>
      </div>
      <div class="modal-footer">
        <span class="blog-footer-note" id="nl-footer-note"></span>
        <button type="button" class="btn-outline" data-close>Cancel</button>
        <button type="button" class="btn-outline" id="nl-save">Save draft</button>
        <button type="button" class="btn-primary" id="nl-send">Send…</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const box = overlay.querySelector('.modal-box');
  const get = k => box.querySelector(`[data-field="${k}"]`);
  let busy = 0;

  // ---- editor ----
  const quill = createEditor(overlay.querySelector('#nl-quill'), {
    placeholder: 'Hi {{first_name}},\n\nWrite your message… Use headings, lists, links and images.',
    onImage: insertImage
  });
  if (campaign.body_html) quill.clipboard.dangerouslyPasteHTML(htmlForEditor(campaign.body_html), 'silent');
  quill.history.clear();
  overlay.querySelectorAll('[data-merge]').forEach(b => b.addEventListener('click', () => {
    const range = quill.getSelection(true);
    const at = range ? range.index : quill.getLength() - 1;
    quill.insertText(at, b.dataset.merge, 'user');
    quill.setSelection(at + b.dataset.merge.length, 0);
  }));

  async function insertImage() {
    const file = await new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = 'image/*';
      input.addEventListener('change', () => resolve(input.files[0] || null), { once: true });
      input.click();
    });
    if (!file) return null;
    if (!IMAGE_TYPES.includes(file.type)) { toast('Unsupported image type. Use JPG, PNG, WEBP, AVIF or GIF.', true); return null; }
    busy++; footerNote();
    try {
      const out = await prepareImageForUpload(file);   // ≤ 100 KB (CLAUDE.md)
      if (out.error) { toast(out.error, true); return null; }
      const path = `newsletter/${Date.now()}-${out.file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
      const { error } = await sb.storage.from('residential-media').upload(path, out.file, { upsert: true });
      if (error) { toast(error.message, true); return null; }
      toast(`Image added${out.note}`);
      return { url: sb.storage.from('residential-media').getPublicUrl(path).data.publicUrl, alt: file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ') };
    } finally { busy--; footerNote(); }
  }
  function footerNote() {
    overlay.querySelector('#nl-footer-note').textContent = busy ? 'Optimizing & uploading image…' : '';
    ['#nl-save', '#nl-send', '#nl-test'].forEach(s => { overlay.querySelector(s).disabled = busy > 0; });
  }

  // ---- counters ----
  const LIMITS = { subject: 60, preheader: 100 };
  const refreshCounts = () => Object.entries(LIMITS).forEach(([k, max]) => {
    const el = overlay.querySelector(`[data-count="${k}"]`);
    const n = get(k).value.length;
    el.textContent = `${n} / ${max}`;
    el.classList.toggle('over', n > max);
  });
  ['subject', 'preheader'].forEach(k => get(k).addEventListener('input', refreshCounts));
  refreshCounts();

  // ---- audience ----
  const picked = overlay.querySelector('#nl-picked');
  const pickInput = picked.querySelector('input');
  const suggest = overlay.querySelector('#nl-suggest');
  const matchesSegment = s => (!audience.cities.length || audience.cities.includes(s.city)) && (!audience.interests.length || audience.interests.includes(s.property_interest));
  const inType = (s, type) => type === 'registered_user' ? s.source === 'registered_user' : type === 'website' ? s.source !== 'registered_user' : true;
  function recipients() {
    if (audience.type === 'custom') return subscribed.filter(s => audience.subscriber_ids.includes(s.id));
    return subscribed.filter(s => inType(s, audience.type) && matchesSegment(s));
  }
  function refreshAudience() {
    AUDIENCES.forEach(a => {
      overlay.querySelector(`[data-aud-count="${a.key}"]`).textContent = a.key === 'custom' ? (audience.subscriber_ids.length || '') : subscribed.filter(s => inType(s, a.key)).length;
    });
    overlay.querySelector('#nl-picker').hidden = audience.type !== 'custom';
    overlay.querySelector('#nl-segment').hidden = audience.type === 'custom';
    picked.querySelectorAll('.tag-chip').forEach(c => c.remove());
    audience.subscriber_ids.forEach(sid => {
      const s = subscribers.find(x => x.id === sid);
      if (s) pickInput.insertAdjacentHTML('beforebegin', `<span class="tag-chip" title="${escapeHtml(s.email)}">${escapeHtml(s.full_name || s.email)}<button type="button" data-unpick="${s.id}" aria-label="Remove">✕</button></span>`);
    });
    const n = recipients().length;
    overlay.querySelector('#nl-total').innerHTML = n ? `Will be sent to <b>${n.toLocaleString('en-IN')}</b> ${n === 1 ? 'person' : 'people'}` : `<span class="nl-error">No one matches this audience yet.</span>`;
    overlay.querySelector('#nl-send').textContent = n ? `Send to ${n.toLocaleString('en-IN')}…` : 'Send…';
  }
  overlay.querySelectorAll('input[name="nl-audience"]').forEach(r => r.addEventListener('change', () => { audience.type = r.value; refreshAudience(); if (r.value === 'custom') pickInput.focus(); }));
  overlay.querySelectorAll('[data-city]').forEach(b => b.addEventListener('click', () => {
    const v = b.dataset.city; const i = audience.cities.indexOf(v);
    if (i >= 0) audience.cities.splice(i, 1); else audience.cities.push(v);
    b.classList.toggle('active', i < 0); refreshAudience();
  }));
  overlay.querySelectorAll('[data-interest]').forEach(b => b.addEventListener('click', () => {
    const v = b.dataset.interest; const i = audience.interests.indexOf(v);
    if (i >= 0) audience.interests.splice(i, 1); else audience.interests.push(v);
    b.classList.toggle('active', i < 0); refreshAudience();
  }));
  function renderSuggest() {
    const q = pickInput.value.trim().toLowerCase();
    if (!q) { suggest.innerHTML = ''; return; }
    const hits = subscribed.filter(s => !audience.subscriber_ids.includes(s.id) && `${s.email} ${s.full_name || ''}`.toLowerCase().includes(q)).slice(0, 8);
    suggest.innerHTML = hits.map(s => `<button type="button" data-pick="${s.id}"><b>${escapeHtml(s.full_name || s.email)}</b><span>${escapeHtml(s.email)} · ${escapeHtml(sourceLabel(s.source))}</span></button>`).join('')
      || `<div class="hint">No subscribed person matches “${escapeHtml(q)}”. Add them under Subscribers first.</div>`;
  }
  pickInput.addEventListener('input', renderSuggest);
  pickInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); suggest.querySelector('[data-pick]')?.click(); }
    else if (e.key === 'Backspace' && !pickInput.value && audience.subscriber_ids.length) { audience.subscriber_ids.pop(); refreshAudience(); }
  });
  suggest.addEventListener('click', e => {
    const b = e.target.closest('[data-pick]'); if (!b) return;
    if (audience.subscriber_ids.length >= 500) { toast('Up to 500 people can be picked — use a group audience for more.', true); return; }
    audience.subscriber_ids.push(b.dataset.pick); pickInput.value = ''; renderSuggest(); refreshAudience(); pickInput.focus();
  });
  picked.addEventListener('click', e => {
    const b = e.target.closest('[data-unpick]');
    if (b) { audience.subscriber_ids = audience.subscriber_ids.filter(x => x !== b.dataset.unpick); refreshAudience(); } else pickInput.focus();
  });
  refreshAudience();

  // ---- email HTML + preview ----
  const bodyHtml = () => sanitizeHtml(quill.root.innerHTML);
  const emailHtml = () => buildEmailHtml({ subject: get('subject').value.trim(), preheader: get('preheader').value.trim(), bodyHtml: bodyHtml() }, { logoUrl, contact });
  function renderPreview() {
    overlay.querySelector('#nl-pv-subject').textContent = fillSampleMergeTags(get('subject').value.trim() || '(no subject)').replace(/&amp;/g, '&');
    overlay.querySelector('#nl-pv-pre').textContent = get('preheader').value.trim() ? ` — ${get('preheader').value.trim()}` : '';
    overlay.querySelector('#nl-preview').srcdoc = fillSampleMergeTags(emailHtml());
  }
  overlay.querySelectorAll('[data-mode]').forEach(btn => btn.addEventListener('click', () => {
    overlay.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('active', b === btn));
    overlay.querySelector('[data-pane="write"]').hidden = btn.dataset.mode !== 'write';
    overlay.querySelector('[data-pane="preview"]').hidden = btn.dataset.mode !== 'preview';
    if (btn.dataset.mode === 'preview') renderPreview();
  }));
  overlay.querySelectorAll('[data-device]').forEach(btn => btn.addEventListener('click', () => {
    overlay.querySelectorAll('[data-device]').forEach(b => b.classList.toggle('active', b === btn));
    overlay.querySelector('.nl-preview-frame-wrap').classList.toggle('mobile', btn.dataset.device === 'mobile');
  }));

  // ---- validation / save ----
  function validate(forSend) {
    const missing = [];
    if (!get('subject').value.trim()) missing.push('Subject');
    const html = bodyHtml();
    if (!htmlToPlainText(html).trim() && !/<img\b/i.test(html)) missing.push('Message');
    if (missing.length) { toast(`Please fill: ${missing.join(', ')}`, true); return false; }
    if (forSend && !recipients().length) { toast('No one matches this audience — choose who to send to.', true); return false; }
    return true;
  }
  async function save() {
    const payload = {
      subject: get('subject').value.trim(),
      preheader: get('preheader').value.trim() || null,
      body_html: bodyHtml(),
      content_html: emailHtml(),
      audience_filter: audience.type === 'custom'
        ? { type: 'custom', subscriber_ids: audience.subscriber_ids }
        : { type: audience.type, cities: audience.cities, interests: audience.interests },
      total_recipients: recipients().length,
      updated_at: new Date().toISOString()
    };
    const res = id
      ? await sb.from('newsletter_campaigns').update(payload).eq('id', id).select('id').single()
      : await sb.from('newsletter_campaigns').insert({ ...payload, status: 'draft', created_by: currentUser?.id || null }).select('id').single();
    if (res.error) { toast(res.error.message, true); return false; }
    id = res.data.id;
    dirty = false;
    return true;
  }

  overlay.querySelector('#nl-save').addEventListener('click', async () => {
    if (!validate(false)) return;
    if (await save()) { toast('Draft saved'); close(); onDone(); }
  });

  overlay.querySelector('#nl-test').addEventListener('click', async () => {
    if (!validate(false)) return;
    const to = get('test_to').value.trim();
    if (!/^\S+@\S+\.\S+$/.test(to)) { toast('Enter an email address for the test', true); get('test_to').focus(); return; }
    const btn = overlay.querySelector('#nl-test');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      await callFn('test', { to: [to], subject: get('subject').value.trim(), html: emailHtml(), unsubscribe_page: new URL('./unsubscribe.html', location.href).href });
      toast(`Test sent to ${to}`);
    } catch (e) {
      toast(e.message, true);
    } finally { btn.disabled = false; btn.textContent = 'Send test email'; }
  });

  overlay.querySelector('#nl-send').addEventListener('click', async () => {
    if (!validate(true)) return;
    const n = recipients().length;
    const ok = await customConfirm(`“${get('subject').value.trim()}” will be emailed to ${n.toLocaleString('en-IN')} ${n === 1 ? 'person' : 'people'} now. This can't be undone.`,
      { title: 'Send this email?', confirmLabel: `Send to ${n.toLocaleString('en-IN')}` });
    if (!ok) return;
    const sendBtn = overlay.querySelector('#nl-send');
    sendBtn.disabled = true;
    if (!(await save())) { sendBtn.disabled = false; return; }
    try {
      await callFn('queue', { campaign_id: id });
    } catch (e) {
      toast(e.message, true); sendBtn.disabled = false; return;
    }
    close();
    await runSending({ id, subject: get('subject').value.trim() });
    onDone();
  });

  // ---- close ----
  let dirty = false;
  quill.on('text-change', (_d, _o, source) => { if (source === 'user') dirty = true; });
  box.addEventListener('input', () => { dirty = true; });
  const close = () => { overlay.remove(); document.removeEventListener('keydown', escHandler); };
  const requestClose = async () => {
    if (dirty && !(await customConfirm('This email hasn\'t been saved.', { title: 'Discard changes?', confirmLabel: 'Discard', danger: true }))) return;
    close();
  };
  const escHandler = e => { if (e.key === 'Escape' && document.querySelectorAll('.modal-overlay').length === 1) requestClose(); };
  document.addEventListener('keydown', escHandler);
  overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', requestClose));
}

/* ---------------- Subscribers ---------------- */

function renderSubscribers(el, subscribers, reload) {
  const rows = subscribers.map(s => `<tr>
      <td><strong>${escapeHtml(s.full_name || '—')}</strong><div class="proj-code">${escapeHtml(s.email)}</div></td>
      <td>${escapeHtml(s.city || '—')}</td>
      <td>${escapeHtml(s.property_interest ? titleCase(s.property_interest) : '—')}</td>
      <td>${escapeHtml(sourceLabel(s.source))}</td>
      <td>${s.is_subscribed ? '<span class="pill active">subscribed</span>' : '<span class="pill archived">unsubscribed</span>'}</td>
      <td>${fmtDate(s.created_at)}</td>
      <td><div class="row-actions">
        <button class="icon-btn" data-sub-edit="${s.id}" title="Edit">${icon('edit', 13)}</button>
        <button class="icon-btn" data-sub-toggle="${s.id}" title="${s.is_subscribed ? 'Unsubscribe' : 'Subscribe again'}">${icon(s.is_subscribed ? 'pause' : 'refresh', 13)}</button>
        ${s.source === 'registered_user' ? '' : `<button class="icon-btn danger" data-sub-delete="${s.id}" title="Delete">${icon('trash', 13)}</button>`}
      </div></td>
    </tr>`).join('');
  el.innerHTML = tablePanel('Subscribers',
    `<div class="toolbar"><button type="button" class="btn-outline" id="sub-import">Import</button><button type="button" class="btn-outline" id="sub-export">Export CSV</button><button type="button" class="btn-primary" id="sub-add">+ Add Subscriber</button></div>`,
    ['Subscriber', 'City', 'Interested in', 'Source', 'Status', 'Joined', 'Actions'],
    rows || emptyRow(7, 'No subscribers yet. People who subscribe on keys99.com and registered users appear here.'));

  if (subscribers.length) attachListFilters({
    panel: el.querySelector('.panel'), items: subscribers, rows: [...el.querySelectorAll('tbody tr')],
    stateKey: 'newsletter-subscribers', title: 'Filter Subscribers', noun: ['subscriber', 'subscribers'],
    searchText: s => `${s.email} ${s.full_name || ''} ${s.city || ''}`, searchPlaceholder: 'Search name, email, city',
    filters: [
      { key: 'status', label: 'Status', get: s => (s.is_subscribed ? 'subscribed' : 'unsubscribed') },
      { key: 'source', label: 'Source', get: s => s.source || 'website', labels: SOURCE_LABELS },
      { key: 'city', label: 'City', get: s => s.city, raw: true },
      { key: 'interest', label: 'Interested in', get: s => s.property_interest }
    ]
  });

  const byId = Object.fromEntries(subscribers.map(s => [s.id, s]));
  el.querySelector('#sub-add').addEventListener('click', () => openSubscriberForm(null, subscribers, reload));
  el.querySelector('#sub-import').addEventListener('click', () => openImport(subscribers, reload));
  el.querySelector('#sub-export').addEventListener('click', () => exportCsv(subscribers));
  el.querySelectorAll('[data-sub-edit]').forEach(b => b.addEventListener('click', () => openSubscriberForm(byId[b.dataset.subEdit], subscribers, reload)));
  el.querySelectorAll('[data-sub-toggle]').forEach(b => b.addEventListener('click', async () => {
    const s = byId[b.dataset.subToggle];
    const now = new Date().toISOString();
    const { error } = await sb.from('newsletter_subscribers')
      .update(s.is_subscribed ? { is_subscribed: false, unsubscribed_at: now, updated_at: now } : { is_subscribed: true, unsubscribed_at: null, updated_at: now })
      .eq('id', s.id);
    if (error) { toast(error.message, true); return; }
    toast(s.is_subscribed ? `${s.email} unsubscribed` : `${s.email} subscribed again`);
    reload();
  }));
  el.querySelectorAll('[data-sub-delete]').forEach(b => b.addEventListener('click', async () => {
    const s = byId[b.dataset.subDelete];
    if (!(await customConfirm(`${s.email} will be removed from the list, along with their delivery history. To just stop emails, use Unsubscribe instead.`, { title: 'Delete subscriber?', confirmLabel: 'Delete', danger: true }))) return;
    const { error } = await sb.from('newsletter_subscribers').delete().eq('id', s.id);
    if (error) { toast(error.message, true); return; }
    toast('Subscriber deleted');
    reload();
  }));
}

function openSubscriberForm(s, subscribers, reload) {
  const v = s || { email: '', full_name: '', city: '', property_interest: '', is_subscribed: true };
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box">
    <div class="modal-head"><div><h2>${s ? 'Edit Subscriber' : 'Add Subscriber'}</h2>${s?.source === 'registered_user' ? '<p>Registered keys99.com user</p>' : ''}</div><button type="button" class="modal-close" data-close>✕</button></div>
    <div class="modal-body"><div class="form-grid">
      <div class="field full"><label>Email <span class="req">*</span></label><input data-f="email" type="email" value="${escapeHtml(v.email)}"${s?.source === 'registered_user' ? ' readonly' : ''}></div>
      <div class="field full"><label>Name</label><input data-f="full_name" type="text" value="${escapeHtml(v.full_name || '')}"></div>
      <div class="field"><label>City</label><input data-f="city" type="text" value="${escapeHtml(v.city || '')}" placeholder="e.g. Pune"></div>
      <div class="field"><label>Interested in</label>
        <select data-f="property_interest"><option value="">—</option>${['residential', 'commercial', 'both', 'investment'].map(o => `<option value="${o}"${v.property_interest === o ? ' selected' : ''}>${titleCase(o)}</option>`).join('')}${v.property_interest && !['residential', 'commercial', 'both', 'investment'].includes(v.property_interest) ? `<option value="${escapeHtml(v.property_interest)}" selected>${escapeHtml(titleCase(v.property_interest))}</option>` : ''}</select></div>
      <div class="field full"><label style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" data-f="is_subscribed" ${v.is_subscribed ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--green)"> Subscribed (receives newsletters)</label></div>
    </div></div>
    <div class="modal-footer"><button type="button" class="btn-outline" data-close>Cancel</button><button type="button" class="btn-primary" data-save>${s ? 'Save' : 'Add'}</button></div>
  </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  const f = k => overlay.querySelector(`[data-f="${k}"]`);
  f('email').focus();
  overlay.querySelector('[data-save]').addEventListener('click', async () => {
    const email = f('email').value.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) { toast('Enter a valid email address', true); return; }
    if (subscribers.some(x => x.email.toLowerCase() === email && x.id !== s?.id)) { toast(`${email} is already on the list.`, true); return; }
    const now = new Date().toISOString();
    const subscribedNow = f('is_subscribed').checked;
    const payload = {
      email, full_name: f('full_name').value.trim() || null, city: f('city').value.trim() || null,
      property_interest: f('property_interest').value || null, is_subscribed: subscribedNow,
      unsubscribed_at: subscribedNow ? null : (s?.unsubscribed_at || now), updated_at: now
    };
    const { error } = s
      ? await sb.from('newsletter_subscribers').update(payload).eq('id', s.id)
      : await sb.from('newsletter_subscribers').insert({ ...payload, source: 'admin' });
    if (error) { toast(/duplicate|unique/i.test(error.message) ? `${email} is already on the list.` : error.message, true); return; }
    toast(s ? 'Saved' : 'Subscriber added');
    close(); reload();
  });
}

function openImport(subscribers, reload) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box" style="max-width:600px">
    <div class="modal-head"><div><h2>Import Subscribers</h2><p>One person per line: <code>email, name, city</code> — name and city are optional. A CSV export works too.</p></div><button type="button" class="modal-close" data-close>✕</button></div>
    <div class="modal-body">
      <textarea id="imp-text" rows="10" style="width:100%;font-family:ui-monospace,monospace;font-size:12.5px" placeholder="rahul@example.com, Rahul Sharma, Pune&#10;priya@example.com, Priya Patil"></textarea>
      <label style="display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13px"><input type="checkbox" id="imp-consent" style="width:16px;height:16px;accent-color:var(--green)"> These people agreed to receive emails from Keys99.</label>
      <div class="hint" id="imp-summary" style="margin-top:8px"></div>
    </div>
    <div class="modal-footer"><button type="button" class="btn-outline" data-close>Cancel</button><button type="button" class="btn-primary" id="imp-go" disabled>Import</button></div>
  </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));
  const known = new Set(subscribers.map(s => s.email.toLowerCase()));
  const textEl = overlay.querySelector('#imp-text');
  const parse = () => {
    const seen = new Set(); const rows = []; let invalid = 0, existing = 0;
    textEl.value.split(/\r?\n/).forEach(line => {
      const cells = line.split(/[,;\t]/).map(c => c.trim().replace(/^"|"$/g, ''));
      const email = (cells.find(c => /^\S+@\S+\.\S+$/.test(c)) || '').toLowerCase();
      if (!line.trim() || /^email\b/i.test(line.trim())) return;
      if (!email) { invalid++; return; }
      if (known.has(email)) { existing++; return; }
      if (seen.has(email)) return;
      seen.add(email);
      const rest = cells.filter(c => c && c.toLowerCase() !== email);
      rows.push({ email, full_name: rest[0] || null, city: rest[1] || null, source: 'import', is_subscribed: true });
    });
    return { rows, invalid, existing };
  };
  const refresh = () => {
    const { rows, invalid, existing } = parse();
    overlay.querySelector('#imp-summary').textContent = textEl.value.trim() ? `${rows.length} new${existing ? ` · ${existing} already on the list` : ''}${invalid ? ` · ${invalid} line${invalid === 1 ? '' : 's'} without a valid email` : ''}` : '';
    overlay.querySelector('#imp-go').disabled = !rows.length || !overlay.querySelector('#imp-consent').checked;
  };
  textEl.addEventListener('input', refresh);
  overlay.querySelector('#imp-consent').addEventListener('change', refresh);
  overlay.querySelector('#imp-go').addEventListener('click', async () => {
    const { rows } = parse();
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await sb.from('newsletter_subscribers').upsert(rows.slice(i, i + 500), { onConflict: 'email', ignoreDuplicates: true });
      if (error) { toast(error.message, true); return; }
    }
    toast(`${rows.length} subscriber${rows.length === 1 ? '' : 's'} imported`);
    close(); reload();
  });
}

function exportCsv(subscribers) {
  // Leading = + - @ would be run as formulas by Excel / Sheets — prefix them with '.
  const cell = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [['Email', 'Name', 'City', 'Interested in', 'Source', 'Status', 'Joined'].join(',')]
    .concat(subscribers.map(s => [s.email, s.full_name, s.city, s.property_interest, sourceLabel(s.source), s.is_subscribed ? 'Subscribed' : 'Unsubscribed', (s.created_at || '').slice(0, 10)].map(cell).join(',')));
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `keys99-subscribers-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

import { sb } from './supabase-client.js';
import { pageHead, tablePanel, emptyRow, escapeHtml, pill, icon, toast } from './utils.js';
import { openEntityForm, confirmDeleteEntity } from './entity-form.js';

// Testimonials: buyer reviews shown on keys99.com, in the homepage's Testimonials section (the
// first 6) and on /testimonials (all), in the order set here. Only published ones appear, and
// one can only be published once the buyer has agreed (a database check enforces it). Every
// change queues a site rebuild (request_site_build trigger), so the site follows within minutes.
// Photos go through the shared image field: WebP ≤ 100 KB in residential-media/directory/testimonials.

const TABLE = 'testimonials';

const FIELDS = [
  { key: 'name', label: 'Buyer name', req: true, maxlength: 80, placeholder: 'e.g. Priya S.', hint: 'First name and initial is usual, e.g. "Priya S." or "Rahul & Sneha K."' },
  { key: 'role', label: 'Who they are', maxlength: 60, placeholder: 'e.g. First-time buyer' },
  { key: 'location', label: 'Home & location', maxlength: 80, placeholder: 'e.g. 2 BHK · Ravet, Pune' },
  { key: 'highlight', label: 'Highlight chip', maxlength: 40, placeholder: 'e.g. ✓ RERA verified', hint: 'A short tag shown at the top of the card (optional).' },
  { key: 'quote', label: 'What they said', type: 'textarea', req: true, full: true, maxlength: 600, placeholder: 'Their words, shortened if needed but not reworded (20–600 characters).' },
  { key: 'photo_url', label: 'Photo (optional)', type: 'image', folder: 'testimonials', shape: 'round', cta: 'Upload buyer photo', hint: 'Square photo works best · auto-compressed to WebP (max 100 KB). Without one, their initial is shown.' },
  { key: 'consent_confirmed', label: 'The buyer agreed to have this published on keys99.com', type: 'checkbox', full: true, hint: 'Required before publishing.' },
  { key: 'is_published', label: 'Published (show on keys99.com)', type: 'checkbox', full: true }
];

function validate(p) {
  const quote = (p.quote || '').trim();
  if (quote.length < 20) return 'The quote is too short — at least 20 characters.';
  if (p.is_published && !p.consent_confirmed) return 'Tick "The buyer agreed…" before publishing — only testimonials shared with permission can go on the site.';
  return null;
}

function friendlyError(error) {
  const m = String(error?.message || '');
  if (/testimonials_consent_chk/.test(m)) return 'Tick "The buyer agreed…" before publishing.';
  if (/testimonials_quote_chk/.test(m)) return 'The quote must be 20–600 characters.';
  if (/photo_url_safe_chk/.test(m)) return 'The photo must be an uploaded image.';
  return null;
}

// New testimonials go to the end of the list.
async function prepare(payload, isNew) {
  if (!isNew) return;
  const { data } = await sb.from(TABLE).select('display_order').order('display_order', { ascending: false }).limit(1);
  payload.display_order = ((data && data[0]?.display_order) ?? -1) + 1;
}

function avatar(t) {
  const initial = escapeHtml((String(t.name || '?').trim()[0] || '?').toUpperCase());
  const img = /^https?:\/\//i.test(t.photo_url || '') ? `<img src="${escapeHtml(t.photo_url)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  return `<span class="name-img-pic round">${initial}${img}</span>`;
}

export async function testimonialsPage(content) {
  const head = pageHead('Testimonials', 'Buyer reviews shown on keys99.com — the homepage shows the first 6, /testimonials shows all');
  content.innerHTML = head + '<div class="empty">Loading…</div>';
  const { data, error } = await sb.from(TABLE)
    .select('id,name,role,location,highlight,quote,photo_url,consent_confirmed,is_published,display_order,updated_at')
    .order('display_order', { ascending: true }).order('created_at', { ascending: true });
  if (!content.isConnected) return;
  const list = data || [];
  const published = list.filter(t => t.is_published).length;

  const rows = error ? emptyRow(6, error.message) : list.length ? list.map((t, i) => `
    <tr data-id="${escapeHtml(t.id)}">
      <td class="tm-order">
        <button type="button" class="icon-btn" data-move="-1" title="Move up" aria-label="Move ${escapeHtml(t.name)} up"${i === 0 ? ' disabled' : ''}>▲</button>
        <button type="button" class="icon-btn" data-move="1" title="Move down" aria-label="Move ${escapeHtml(t.name)} down"${i === list.length - 1 ? ' disabled' : ''}>▼</button>
      </td>
      <td><div class="name-img">${avatar(t)}<div><strong>${escapeHtml(t.name)}</strong>
        <div class="tm-sub">${escapeHtml([t.role, t.location].filter(Boolean).join(' · ') || '—')}</div></div></div></td>
      <td class="tm-quote">${t.highlight ? `<span class="tm-chip">${escapeHtml(t.highlight)}</span>` : ''}<span title="${escapeHtml(t.quote)}">“${escapeHtml(t.quote.length > 140 ? t.quote.slice(0, 137) + '…' : t.quote)}”</span></td>
      <td>${t.consent_confirmed ? '<span class="tm-ok">✓ Agreed</span>' : '<span class="tm-warn">Not yet</span>'}</td>
      <td>${t.is_published ? pill('published') : pill('draft')}${t.is_published && i < 6 ? '<div class="tm-sub">On homepage</div>' : ''}</td>
      <td><div class="row-actions">
        <button type="button" class="tm-pub${t.is_published ? '' : ' on'}" data-toggle-publish aria-label="${t.is_published ? 'Unpublish' : 'Publish'} ${escapeHtml(t.name)}">${t.is_published ? 'Unpublish' : 'Publish'}</button>
        <button type="button" class="icon-btn" data-edit title="Edit" aria-label="Edit ${escapeHtml(t.name)}">${icon('edit', 13)}</button>
        <button type="button" class="icon-btn danger" data-delete title="Delete" aria-label="Delete ${escapeHtml(t.name)}">${icon('trash', 13)}</button>
      </div></td>
    </tr>`).join('') : emptyRow(6, 'No testimonials yet. Add your first buyer review — until one is published, keys99.com keeps showing its sample reviews.');

  const toolbar = `<div class="toolbar"><span class="tm-count">${published} published · ${list.length - published} draft</span><button class="btn-primary" id="add-testimonial">+ Add Testimonial</button></div>`;
  content.innerHTML = head + tablePanel('All Testimonials', toolbar, ['Order', 'Buyer', 'Testimonial', 'Consent', 'Status', 'Actions'], rows);

  const reload = () => testimonialsPage(content);
  const openForm = id => openEntityForm({
    title: id ? 'Edit Testimonial' : 'Add Testimonial',
    subtitle: 'Use the buyer\'s own words, shared with their permission.',
    table: TABLE, fields: FIELDS, existingId: id, onSaved: reload,
    validate, prepare, friendlyError
  });

  content.querySelector('#add-testimonial').addEventListener('click', () => openForm(null));
  content.querySelectorAll('tr[data-id]').forEach(tr => {
    const id = tr.dataset.id;
    const t = list.find(x => x.id === id);
    tr.querySelector('[data-edit]').addEventListener('click', () => openForm(id));
    tr.querySelector('[data-delete]').addEventListener('click', () => confirmDeleteEntity(TABLE, id, `the testimonial from ${t.name}`, reload));
    tr.querySelector('[data-toggle-publish]').addEventListener('click', async () => {
      if (!t.is_published && !t.consent_confirmed) { toast('Open Edit and tick "The buyer agreed…" before publishing.', true); return; }
      const { error: e } = await sb.from(TABLE).update({ is_published: !t.is_published }).eq('id', id);
      if (e) { toast(friendlyError(e) || e.message, true); return; }
      toast(t.is_published ? 'Unpublished' : 'Published — keys99.com updates in a few minutes');
      reload();
    });
    tr.querySelectorAll('[data-move]').forEach(btn => btn.addEventListener('click', async () => {
      const i = list.indexOf(t), j = i + Number(btn.dataset.move);
      if (j < 0 || j >= list.length) return;
      // Renumber everything in the new order so ties never leave the order ambiguous.
      const order = list.slice();
      [order[i], order[j]] = [order[j], order[i]];
      const changed = order.map((x, k) => ({ id: x.id, k })).filter(({ id: xid, k }) => list.find(x => x.id === xid).display_order !== k);
      content.querySelectorAll('[data-move]').forEach(b => { b.disabled = true; });
      const results = await Promise.all(changed.map(({ id: xid, k }) => sb.from(TABLE).update({ display_order: k }).eq('id', xid)));
      const failed = results.find(r => r.error);
      if (failed) toast(failed.error.message, true);
      reload();
    }));
  });
}

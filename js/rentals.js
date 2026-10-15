import { sb } from './supabase-client.js';
import {
  escapeHtml, pill, fmtPrice, fmtDate, pageHead, tablePanel, emptyRow, icon, toast, customConfirm
} from './utils.js';
import { attachListFilters, dateRangeOptions, titleCase } from './list-filters.js';
import { projectThumbHtml, bindThumbFallbacks } from './project-thumbs.js';

// Rental Listings: approval queue for the rentals owners post from keys99.com
// (rental_properties + rental_residential_details / rental_commercial_details, photos in the
// public rental-property-media bucket, ownership documents in the private
// rental-property-documents bucket).
//
// The database does the gatekeeping: RLS lets admins / moderators read and change everything,
// and private.rental_guard stops owners touching approval fields or moving a listing past
// "pending". Owners' own steps (created / submitted / resubmitted) are logged by a trigger;
// the admin actions below log themselves into rental_property_moderation_history.

const MEDIA_BUCKET = 'rental-property-media';
const DOCS_BUCKET = 'rental-property-documents';

const TABS = [
  { key: 'pending', label: 'Pending Approval', statuses: ['pending'] },
  { key: 'approved', label: 'Approved', statuses: ['approved'] },
  { key: 'rejected', label: 'Rejected', statuses: ['rejected'] },
  { key: 'closed', label: 'Rented / Expired / Inactive', statuses: ['rented', 'expired', 'inactive'] },
  { key: 'all', label: 'All', statuses: null }
];

// `action` must be one of rental_property_moderation_history's allowed action values.
const ACTIONS = {
  approve: { label: 'Approve', icon: 'check', toStatus: 'approved', action: 'approved', primary: true },
  reject: { label: 'Reject', icon: 'close', toStatus: 'rejected', action: 'rejected', requireComment: true, danger: true },
  markRented: { label: 'Mark Rented', icon: 'home', toStatus: 'rented', action: 'marked_rented' },
  deactivate: { label: 'Deactivate', icon: 'pause', toStatus: 'inactive', action: 'deactivated', requireComment: true, danger: true },
  reactivate: { label: 'Reactivate', icon: 'refresh', toStatus: 'approved', action: 'reactivated' }
};

function actionKeysForStatus(status) {
  switch (status) {
    case 'pending': return ['approve', 'reject'];
    case 'approved': return ['markRented', 'deactivate'];
    case 'rented':
    case 'expired':
    case 'inactive': return ['reactivate'];
    default: return [];   // draft (owner still editing), rejected (waiting for the owner to resubmit)
  }
}

const mediaUrl = path => (path ? sb.storage.from(MEDIA_BUCKET).getPublicUrl(path).data.publicUrl : null);
const label = v => (v === null || v === undefined || v === '' ? '' : titleCase(String(v)));
const yesNo = v => (v === true ? 'Yes' : v === false ? 'No' : '');
const area = v => (v ? `${Number(v).toLocaleString('en-IN')} sq ft` : '');
const months = v => (v || v === 0 ? `${v} month${Number(v) === 1 ? '' : 's'}` : '');
const rent = v => (v || v === 0 ? `${fmtPrice(v)} / month` : '');

/* ---------------- pending count (sidebar badge, bell) ---------------- */

export async function pendingRentalCount() {
  const { count, error } = await sb.from('rental_properties').select('id', { count: 'exact', head: true }).eq('status', 'pending');
  return error ? 0 : (count || 0);
}

/* ---------------- list page ---------------- */

export async function rentalsPage(content, { currentUser, onCountChange } = {}) {
  let activeTab = 'pending';

  async function render() {
    const tabsHtml = `<div class="tab-row">${TABS.map(t =>
      `<button type="button" class="tab-pill${t.key === activeTab ? ' active' : ''}" data-rental-tab="${t.key}">${t.label}</button>`
    ).join('')}</div>`;
    const head = pageHead('Rental Listings', 'Review and approve rental properties posted by owners on keys99.com');
    content.innerHTML = head + tabsHtml + `<div class="empty">Loading…</div>`;

    const tab = TABS.find(t => t.key === activeTab);
    let q = sb.from('rental_properties')
      .select('id,owner_id,property_category,property_type,listing_title,monthly_rent,status,rejection_reason,created_at,updated_at,cities(name),localities!rental_properties_city_locality_fk(name)')
      .order('updated_at', { ascending: false }).limit(300);
    if (tab.statuses) q = q.in('status', tab.statuses);
    const { data, error } = await q;
    const rows = data || [];

    // Owners' names / phones and cover photos, fetched for just the listings shown.
    const ids = rows.map(r => r.id);
    const ownerIds = [...new Set(rows.map(r => r.owner_id).filter(Boolean))];
    const [{ data: owners }, { data: images }] = await Promise.all([
      ownerIds.length ? sb.from('profiles').select('id,full_name,phone').in('id', ownerIds) : { data: [] },
      ids.length ? sb.from('rental_property_images').select('listing_id,storage_path,is_cover,sort_order').in('listing_id', ids) : { data: [] }
    ]);
    const ownerById = new Map((owners || []).map(o => [o.id, o]));
    const coverById = new Map();
    [...(images || [])].sort((a, b) => (b.is_cover - a.is_cover) || (a.sort_order - b.sort_order))
      .forEach(img => { if (!coverById.has(img.listing_id)) coverById.set(img.listing_id, mediaUrl(img.storage_path)); });
    rows.forEach(r => { r._owner = ownerById.get(r.owner_id) || null; r._cover = coverById.get(r.id) || null; });

    const body = error
      ? emptyRow(7, error.message)
      : (rows.length ? rows.map(r => {
        const actions = actionKeysForStatus(r.status).map(key =>
          `<button class="icon-btn${ACTIONS[key].danger ? ' danger' : ''}" data-rental-action="${key}" data-id="${escapeHtml(r.id)}" title="${escapeHtml(ACTIONS[key].label)}">${icon(ACTIONS[key].icon, 13)}</button>`
        ).join('');
        const place = [r.localities?.name, r.cities?.name].filter(Boolean).join(', ');
        return `
      <tr>
        <td><div class="proj-cell">
          <span class="proj-thumb">${projectThumbHtml(r._cover, r.property_category === 'commercial' ? 'building' : 'home')}</span>
          <div><div class="proj-name">${escapeHtml(r.listing_title)}</div>
            <div class="proj-code"><span class="pill kind-${r.property_category === 'commercial' ? 'commercial' : 'residential'}">${escapeHtml(label(r.property_category))}</span> ${escapeHtml(label(r.property_type))}</div></div>
        </div></td>
        <td>${escapeHtml(place || '—')}</td>
        <td>${escapeHtml(rent(r.monthly_rent) || '—')}</td>
        <td><div>${escapeHtml(r._owner?.full_name || '—')}</div><div class="proj-code">${escapeHtml(r._owner?.phone || '')}</div></td>
        <td>${pill(r.status)}</td>
        <td>${fmtDate(r.updated_at)}</td>
        <td><div class="row-actions">
          <button class="icon-btn" data-rental-review="${escapeHtml(r.id)}" title="Review">${icon('eye', 13)}</button>
          ${actions}
        </div></td>
      </tr>`;
      }).join('') : emptyRow(7, activeTab === 'pending' ? 'No rental listings are waiting for approval.' : 'Nothing here.'));

    content.innerHTML = head + tabsHtml +
      tablePanel(tab.label, '', ['Listing', 'Location', 'Rent', 'Owner', 'Status', 'Updated', 'Actions'], body);
    bindThumbFallbacks(content);

    if (!error) attachListFilters({
      panel: content.querySelector('.panel'), items: rows, rows: [...content.querySelectorAll('tbody tr')],
      stateKey: 'rentals', title: 'Filter Rental Listings', noun: ['listing', 'listings'],
      searchText: r => `${r.listing_title} ${r._owner?.full_name || ''} ${r._owner?.phone || ''} ${r.localities?.name || ''} ${r.cities?.name || ''}`,
      searchPlaceholder: 'Search listings, owners, localities',
      filters: [
        { key: 'property_category', label: 'Category', get: r => r.property_category },
        { key: 'city', label: 'City', get: r => r.cities?.name },
        { key: 'status', label: 'Status', get: r => r.status },
        { key: 'updated', label: 'Updated', options: dateRangeOptions(r => r.updated_at) }
      ]
    });

    const byId = Object.fromEntries(rows.map(r => [r.id, r]));
    const afterChange = async () => { await render(); onCountChange && onCountChange(); };
    content.querySelectorAll('[data-rental-tab]').forEach(btn => btn.addEventListener('click', () => { activeTab = btn.dataset.rentalTab; render(); }));
    content.querySelectorAll('[data-rental-action]').forEach(btn => btn.addEventListener('click', () =>
      runAction(byId[btn.dataset.id], btn.dataset.rentalAction, currentUser, afterChange)));
    content.querySelectorAll('[data-rental-review]').forEach(btn => btn.addEventListener('click', () =>
      openReview(byId[btn.dataset.rentalReview], currentUser, afterChange)));
  }

  await render();
}

/* ---------------- actions ---------------- */

// Reason box for Reject / Deactivate — resolves with the trimmed text, or null if cancelled.
function promptReason(title, subtitle, hint) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box">
        <div class="modal-head">
          <div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(subtitle)}</p></div>
          <button type="button" class="modal-close" data-close>✕</button>
        </div>
        <div class="modal-body">
          <div class="field full">
            <label>Reason <span class="req">*</span></label>
            <textarea id="rental-reason" placeholder="${escapeHtml(hint)}"></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn-outline" data-close>Cancel</button>
          <button type="button" class="btn-primary" id="rental-reason-submit">${escapeHtml(title)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const finish = (value) => { overlay.remove(); document.removeEventListener('keydown', escHandler); resolve(value); };
    const escHandler = (e) => { if (e.key === 'Escape') finish(null); };
    document.addEventListener('keydown', escHandler);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null); });
    overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => finish(null)));
    overlay.querySelector('#rental-reason-submit').addEventListener('click', () => {
      const val = overlay.querySelector('#rental-reason').value.trim();
      if (!val) { toast('Please enter a reason', true); return; }
      finish(val);
    });
    overlay.querySelector('#rental-reason').focus();
  });
}

// Runs one action on a listing. Resolves true when the status changed.
async function runAction(listing, key, currentUser, after) {
  const cfg = ACTIONS[key];
  if (!listing || !cfg) return false;
  let comment = null;
  if (cfg.requireComment) {
    comment = await promptReason(cfg.label, listing.listing_title, key === 'reject'
      ? 'Tell the owner what to fix — they see this and can resubmit.'
      : 'Why is this listing being taken down?');
    if (comment === null) return false;
  } else {
    let message = listing.listing_title;
    if (key === 'approve') {
      const { data: docs } = await sb.from('rental_property_documents').select('verification_status').eq('listing_id', listing.id);
      if (!(docs || []).some(d => d.verification_status === 'verified')) {
        message += '\n\nNo ownership document has been marked verified yet — open Review to check them first.';
      }
    }
    if (!(await customConfirm(message, { title: `${cfg.label} this listing?`, confirmLabel: cfg.label }))) return false;
  }

  const now = new Date().toISOString();
  const payload = { status: cfg.toStatus };
  if (key === 'approve' || key === 'reactivate') Object.assign(payload, { approved_at: now, approved_by: currentUser?.id || null, rejection_reason: null });
  if (key === 'reject') payload.rejection_reason = comment;

  const { error } = await sb.from('rental_properties').update(payload).eq('id', listing.id);
  if (error) { toast(error.message, true); return false; }

  const { error: histError } = await sb.from('rental_property_moderation_history').insert({
    listing_id: listing.id, from_status: listing.status, to_status: cfg.toStatus,
    action: cfg.action, comment, changed_by: currentUser?.id || null
  });
  if (histError) console.error('rental moderation history insert failed', histError);

  toast(`${cfg.label} — done`);
  listing.status = cfg.toStatus;
  after && await after();
  return true;
}

/* ---------------- review modal ---------------- */

const kv = (k, v) => (v ? `<div><b>${escapeHtml(k)}</b><div>${escapeHtml(v)}</div></div>` : '');

async function openReview(listing, currentUser, after) {
  if (!listing) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box rental-review">
      <div class="modal-head">
        <div><h2>${escapeHtml(listing.listing_title)}</h2><p>${escapeHtml(label(listing.property_category))} rental · ${pill(listing.status)}</p></div>
        <button type="button" class="modal-close" data-close>✕</button>
      </div>
      <div class="modal-body" id="rental-review-body"><div class="empty">Loading…</div></div>
      <div class="modal-footer" id="rental-review-footer"><button type="button" class="btn-outline" data-close>Close</button></div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', escHandler); };
  const escHandler = (e) => { if (e.key === 'Escape' && !document.querySelector('.rental-lightbox')) close(); };
  document.addEventListener('keydown', escHandler);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', close));

  const id = listing.id;
  const detailsTable = listing.property_category === 'commercial' ? 'rental_commercial_details' : 'rental_residential_details';
  const [pRes, dRes, imgRes, docRes, amRes, histRes] = await Promise.all([
    sb.from('rental_properties').select('*,cities(name),localities!rental_properties_city_locality_fk(name)').eq('id', id).maybeSingle(),
    sb.from(detailsTable).select('*').eq('listing_id', id).maybeSingle(),
    sb.from('rental_property_images').select('id,storage_path,caption,image_type,is_cover,sort_order').eq('listing_id', id).order('sort_order'),
    sb.from('rental_property_documents').select('id,storage_path,document_type,verification_status,review_notes,reviewed_at').eq('listing_id', id).order('created_at'),
    sb.from('rental_property_amenities').select('amenity_name,amenity_category').eq('listing_id', id).order('amenity_name'),
    sb.from('rental_property_moderation_history').select('from_status,to_status,action,comment,changed_at').eq('listing_id', id).order('changed_at', { ascending: false })
  ]);
  const bodyEl = overlay.querySelector('#rental-review-body');
  const p = pRes.data;
  if (pRes.error || !p) { bodyEl.innerHTML = `<div class="empty">${escapeHtml(pRes.error?.message || 'Listing not found.')}</div>`; return; }
  const [{ data: owner }, { data: contact }] = await Promise.all([
    p.owner_id ? sb.from('profiles').select('full_name,phone').eq('id', p.owner_id).maybeSingle() : { data: null },
    // The number tenants reach through Call / WhatsApp on the listing page (private; see
    // keys99.com supabase/27-rental-contacts.sql). Missing table or row → shown as not set.
    sb.from('rental_listing_contacts').select('phone,whatsapp').eq('listing_id', id).maybeSingle()
  ]);
  const contactText = contact?.phone
    ? `+91 ${contact.phone}${contact.whatsapp && contact.whatsapp !== contact.phone ? ` · WhatsApp +91 ${contact.whatsapp}` : ' (calls & WhatsApp)'}`
    : 'Not set — falls back to the profile phone';
  const d = dRes.data || {};
  const images = imgRes.data || [];
  const docs = docRes.data || [];

  const gallery = images.length
    ? `<div class="rental-gallery">${images.map((img, i) => `
        <button type="button" class="rental-photo" data-photo="${i}" title="${escapeHtml(img.caption || label(img.image_type))}">
          <img src="${escapeHtml(mediaUrl(img.storage_path))}" alt="${escapeHtml(img.caption || '')}" loading="lazy">
          ${img.is_cover ? '<span class="pill featured">Cover</span>' : ''}
        </button>`).join('')}</div>`
    : '<p class="hint">No photos uploaded.</p>';

  const place = [p.sub_locality, p.localities?.name, p.cities?.name].filter(Boolean).join(', ');
  const basics = [
    kv('Property type', label(p.property_type)), kv('Location', place), kv('Society / building', p.society_name),
    kv('Address', [p.address, p.pincode].filter(Boolean).join(' – ')),
    kv('Monthly rent', rent(p.monthly_rent) + (p.rent_negotiable ? ' (negotiable)' : '')),
    kv('Security deposit', p.security_deposit || p.security_deposit === 0 ? fmtPrice(p.security_deposit) : ''),
    kv('Maintenance', p.maintenance_included ? 'Included in rent' : (p.maintenance_charges ? `${fmtPrice(p.maintenance_charges)} / month` : '')),
    kv('Carpet area', area(p.carpet_area_sqft)), kv('Built-up area', area(p.built_up_area_sqft)),
    kv('Available from', p.available_from ? fmtDate(p.available_from) : ''),
    kv('Minimum lease', months(p.minimum_lease_months)), kv('Notice period', months(p.notice_period_months))
  ].join('');
  const specifics = listing.property_category === 'commercial' ? [
    kv('Commercial type', label(d.commercial_subtype)), kv('Chargeable area', area(d.chargeable_area_sqft)),
    kv('Floor', d.floor_number != null ? `${d.floor_number}${d.total_floors ? ` of ${d.total_floors}` : ''}` : ''),
    kv('Furnishing', label(d.furnishing_status)), kv('Washrooms', d.washroom_count != null ? String(d.washroom_count) : ''),
    kv('Cabins', d.cabins_count != null ? String(d.cabins_count) : ''), kv('Workstations', d.workstation_count != null ? String(d.workstation_count) : ''),
    kv('Parking spaces', d.parking_spaces != null ? String(d.parking_spaces) : ''), kv('Power load', d.power_load_kw ? `${d.power_load_kw} kW` : ''),
    kv('Frontage', d.frontage_feet ? `${d.frontage_feet} ft` : ''), kv('Ceiling height', d.ceiling_height_feet ? `${d.ceiling_height_feet} ft` : ''),
    kv('Loading access', yesNo(d.loading_access)), kv('Fire safety', yesNo(d.fire_safety_available)),
    kv('Business usage', (d.business_usage || []).map(label).join(', ')), kv('Permitted usage', d.permitted_usage_notes)
  ].join('') : [
    kv('BHK', d.bhk), kv('Bedrooms', d.bedrooms != null ? String(d.bedrooms) : ''), kv('Bathrooms', d.bathrooms != null ? String(d.bathrooms) : ''),
    kv('Balconies', d.balconies != null ? String(d.balconies) : ''),
    kv('Floor', d.floor_number != null ? `${d.floor_number}${d.total_floors ? ` of ${d.total_floors}` : ''}` : ''),
    kv('Furnishing', label(d.furnishing_status)), kv('Parking', label(d.parking_type)),
    kv('Property age', d.property_age_years != null ? `${d.property_age_years} yrs` : ''), kv('Facing', label(d.facing_direction)),
    kv('Preferred tenants', (d.preferred_tenants || []).map(label).join(', ')), kv('Pets allowed', yesNo(d.pets_allowed)),
    kv('Gated community', yesNo(d.gated_community)), kv('Water supply', label(d.water_supply)), kv('Power backup', yesNo(d.power_backup))
  ].join('');
  const amenities = (amRes.data || []).map(a => `<span class="chip">${escapeHtml(a.amenity_name)}</span>`).join('');

  const docRow = doc => `
    <div class="modal-list-row rental-doc" data-doc="${escapeHtml(doc.id)}">
      <div>
        <strong>${escapeHtml(label(doc.document_type) || 'Document')}</strong> ${pill(doc.verification_status)}
        ${doc.review_notes ? `<div class="hint">${escapeHtml(doc.review_notes)}</div>` : ''}
      </div>
      <div class="row-actions">
        <button type="button" class="btn-outline btn-sm" data-doc-open="${escapeHtml(doc.id)}">${icon('eye', 13)} Open</button>
        <button type="button" class="icon-btn" data-doc-verify="${escapeHtml(doc.id)}" title="Mark verified">${icon('check', 13)}</button>
        <button type="button" class="icon-btn danger" data-doc-reject="${escapeHtml(doc.id)}" title="Mark rejected">${icon('close', 13)}</button>
      </div>
    </div>`;

  const history = (histRes.data || []).map(h => `
    <div class="modal-list-row" style="align-items:flex-start;flex-direction:column;gap:6px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        ${h.from_status ? pill(h.from_status) + ' →' : ''} ${pill(h.to_status)}
        <span class="hint">${escapeHtml(label(h.action))} · ${fmtDate(h.changed_at)}</span>
      </div>
      ${h.comment ? `<div style="font-size:12.5px;color:var(--ink-soft)">${escapeHtml(h.comment)}</div>` : ''}
    </div>`).join('');

  bodyEl.innerHTML = `
    ${p.status === 'rejected' && p.rejection_reason ? `<div class="notice danger"><b>Rejected:</b> ${escapeHtml(p.rejection_reason)}</div>` : ''}
    <h3 class="rental-h">Photos (${images.length})</h3>${gallery}
    <h3 class="rental-h">Owner</h3>
    <div class="detail-grid">${kv('Name', owner?.full_name || '—')}${kv('Profile phone', owner?.phone || '—')}
      ${kv('Contact for tenants', contactText)}
      ${kv('Owner declaration', p.owner_declaration ? 'Confirmed' : 'Not confirmed')}${kv('Submitted', fmtDate(p.created_at))}</div>
    <h3 class="rental-h">Property</h3><div class="detail-grid">${basics}</div>
    ${specifics ? `<h3 class="rental-h">${listing.property_category === 'commercial' ? 'Commercial details' : 'Home details'}</h3><div class="detail-grid">${specifics}</div>` : ''}
    ${p.description ? `<h3 class="rental-h">Description</h3><p class="rental-desc">${escapeHtml(p.description)}</p>` : ''}
    ${amenities ? `<h3 class="rental-h">Amenities</h3><div class="chip-row">${amenities}</div>` : ''}
    <h3 class="rental-h">Ownership documents (${docs.length})</h3>
    <div class="modal-list" id="rental-docs">${docs.length ? docs.map(docRow).join('') : '<div class="modal-list-empty">No documents uploaded.</div>'}</div>
    <h3 class="rental-h">History</h3>
    <div class="modal-list">${history || '<div class="modal-list-empty">No history yet.</div>'}</div>`;

  // Footer: the actions allowed for this status.
  const footer = overlay.querySelector('#rental-review-footer');
  footer.innerHTML = `<button type="button" class="btn-outline" data-close>Close</button>` +
    actionKeysForStatus(p.status).map(k => `<button type="button" class="${ACTIONS[k].primary ? 'btn-primary' : 'btn-outline'}${ACTIONS[k].danger ? ' danger' : ''}" data-review-action="${k}">${escapeHtml(ACTIONS[k].label)}</button>`).join('');
  footer.querySelector('[data-close]').addEventListener('click', close);
  footer.querySelectorAll('[data-review-action]').forEach(btn => btn.addEventListener('click', async () => {
    const done = await runAction({ ...listing, status: p.status }, btn.dataset.reviewAction, currentUser, after);
    if (done) close();
  }));

  // Photos open full size.
  bodyEl.querySelectorAll('[data-photo]').forEach(btn => btn.addEventListener('click', () => {
    const img = images[Number(btn.dataset.photo)];
    const box = document.createElement('div');
    box.className = 'rental-lightbox';
    box.innerHTML = `<img src="${escapeHtml(mediaUrl(img.storage_path))}" alt="">${img.caption ? `<div>${escapeHtml(img.caption)}</div>` : ''}`;
    const shut = (e) => { if (e.type === 'click' || e.key === 'Escape') { box.remove(); document.removeEventListener('keydown', shut); } };
    box.addEventListener('click', shut);
    document.addEventListener('keydown', shut);
    document.body.appendChild(box);
  }));

  // Documents: private bucket, so open through a short-lived signed link. One delegated
  // handler, since a row is re-rendered after it's verified / rejected.
  const docById = Object.fromEntries(docs.map(x => [x.id, x]));
  const openDoc = async (doc) => {
    const tab = window.open('', '_blank');
    const { data, error } = await sb.storage.from(DOCS_BUCKET).createSignedUrl(doc.storage_path, 600);
    if (error || !data?.signedUrl) { tab?.close(); toast(error?.message || "Couldn't open this document.", true); return; }
    if (tab) { tab.opener = null; tab.location.href = data.signedUrl; } else window.location.assign(data.signedUrl);
  };
  const reviewDoc = async (doc, status) => {
    let notes = null;
    if (status === 'rejected') {
      notes = await promptReason('Reject document', label(doc.document_type) || 'Document', 'What is wrong with this document?');
      if (notes === null) return;
    }
    const patch = { verification_status: status, reviewed_by: currentUser?.id || null, reviewed_at: new Date().toISOString(), review_notes: notes };
    const { error } = await sb.from('rental_property_documents').update(patch).eq('id', doc.id);
    if (error) { toast(error.message, true); return; }
    Object.assign(doc, patch);
    bodyEl.querySelector(`[data-doc="${CSS.escape(doc.id)}"]`).outerHTML = docRow(doc);
    toast(status === 'verified' ? 'Document marked verified' : 'Document marked rejected');
  };
  bodyEl.querySelector('#rental-docs').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-doc-open], [data-doc-verify], [data-doc-reject]');
    if (!btn) return;
    const doc = docById[btn.dataset.docOpen || btn.dataset.docVerify || btn.dataset.docReject];
    if (!doc) return;
    if (btn.dataset.docOpen) openDoc(doc);
    else reviewDoc(doc, btn.dataset.docVerify ? 'verified' : 'rejected');
  });
}

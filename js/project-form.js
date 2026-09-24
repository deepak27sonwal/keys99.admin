import { sb } from './supabase-client.js';
import { toast } from './utils.js';

/* ============ small utils ============ */

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function enumOpts(values) {
  return values.map(v => ({ value: v, label: v.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) }));
}
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur[k] === undefined || cur[k] === null) cur[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}
function slugify(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
function uid() { return Math.random().toString(36).slice(2, 9); }

/* ============ module state ============ */

let content, currentUser, onExit;
let state, projectId, stepIndex, isEdit;
let lookups = { developers: [], cities: [], localities: [], agents: [] };
let touched = false;
let historyPushCount = 0;
let intentionalExit = false;

const STEP_NAMES = [
  'Basic Information', 'Project Location', 'Size & Scale', 'Status & Construction',
  'Residential Configurations', 'Apartment Specifications', 'Tower / Building Details',
  'Amenities & Features', 'Nearby Locations', 'Project Media', 'Pros & Cons',
  'Project Documents', 'Litigation & Legal', 'Construction Updates', 'Project FAQ',
  'Contact / Enquiry', 'SEO', 'Review & Submit'
];
const STEP_SUB = [
  'Core identity of the project — this becomes the basis for the URL and SEO.',
  'Where the project is located.',
  'Land, towers, floors and unit scale of the project.',
  'Construction progress and possession timelines.',
  'One BHK can have multiple price/area configurations — add each as a separate record.',
  'Standard specifications used across the project.',
  'Add one record per tower/building in the project.',
  'Group amenities by category — check the ones available, or add custom ones.',
  'Points of interest around the project, grouped by category.',
  'Main image, gallery, master plan, videos and reels.',
  'Short, factual pros and cons for the public listing.',
  'RERA certificate, brochure and other project documents.',
  'Legal/litigation disclosure for the project.',
  'Dated construction progress updates with optional photos.',
  'Frequently asked questions shown on the public listing.',
  'Agent assigned to handle enquiries for this project.',
  'Search engine metadata for the public project page.',
  'Review every section before saving as draft or submitting for verification.'
];
const TOTAL_STEPS = STEP_NAMES.length;
// index into which core-save happens on "Next" (after this step, the project row can be created)
const FIRST_SAVE_AFTER_STEP = 4;

/* ============ shared enum option lists (avoid re-declaring the same DB check-constraint values per step) ============ */

const CONSTRUCTION_STAGE_OPTIONS = enumOpts(['pre_launch', 'excavation', 'foundation', 'structure', 'brickwork', 'finishing', 'final_completion', 'ready_to_move', 'other']);
const POSSESSION_STATUS_OPTIONS = enumOpts(['not_started', 'under_construction', 'possession_started', 'ready_to_move', 'completed']);
const AREA_UNIT_OPTIONS = enumOpts(['sq_ft', 'sq_m']);

/* ============ field defs (map 1:1 to residential_projects columns) ============ */

const FIELDS = {
  basic: [
    { key: 'project_name', label: 'Project Name', req: true, placeholder: 'e.g. Emerald Heights' },
    { key: 'developer_id', label: 'Developer / Builder', req: true, type: 'select', options: () => lookups.developers.map(d => ({ value: d.id, label: d.name })), quickAdd: 'developer' },
    { key: 'project_type', label: 'Project Type', req: true, type: 'select', options: enumOpts(['apartment', 'villa', 'row_house', 'townhouse', 'residential_plot', 'independent_house', 'mixed_residential', 'other']) },
    { key: 'launch_date', label: 'Project Launch Date', type: 'date' },
    { key: 'rera_number', label: 'RERA Number', placeholder: 'e.g. P52100012345' },
    { key: 'overview', label: 'Project Overview', req: true, type: 'textarea', full: true, placeholder: 'Detailed project description for the public project page…' }
  ],
  location: [
    { key: 'city_id', label: 'City', req: true, type: 'select', options: () => lookups.cities.map(c => ({ value: c.id, label: c.name })), quickAdd: 'city' },
    { key: 'locality_id', label: 'Locality', req: true, type: 'select', options: () => lookups.localities.filter(l => l.city_id === state.project.city_id).map(l => ({ value: l.id, label: l.name })), hint: 'Options depend on the selected city', quickAdd: 'locality' },
    { key: 'address', label: 'Full Address', req: true, full: true, placeholder: 'Street, area, landmark' },
    { key: 'pincode', label: 'Pincode', req: true, placeholder: '6-digit pincode' },
    { key: 'latitude', label: 'Latitude', type: 'number', placeholder: 'e.g. 18.5590' },
    { key: 'longitude', label: 'Longitude', type: 'number', placeholder: 'e.g. 73.7868' }
  ],
  size: [
    { key: 'total_land_area', label: 'Total Land Area', type: 'number' },
    { key: 'land_area_unit', label: 'Land Area Unit', type: 'select', options: enumOpts(['acre', 'sq_ft', 'sq_m']) },
    { key: 'total_towers_buildings', label: 'Total Towers / Buildings', type: 'number' },
    { key: 'total_floors', label: 'Total Floors', type: 'number' },
    { key: 'total_residential_units', label: 'Total Residential Units', type: 'number' },
    { key: 'units_per_floor', label: 'Units per Floor', type: 'number' },
    { key: 'number_of_phases', label: 'Number of Phases', type: 'number' },
    { key: 'units_per_phase', label: 'Units per Phase', type: 'number' },
    { key: 'open_green_area_value', label: 'Open / Green Area', type: 'number' },
    { key: 'open_green_area_unit', label: 'Open / Green Area Unit', type: 'select', options: enumOpts(['acre', 'sq_ft', 'sq_m', 'percent']) },
    { key: 'built_up_project_area', label: 'Built-up Project Area', type: 'number' },
    { key: 'built_up_project_area_unit', label: 'Built-up Area Unit', type: 'select', options: AREA_UNIT_OPTIONS }
  ],
  status: [
    { key: 'status', label: 'Project Status', req: true, type: 'select', options: enumOpts(['upcoming', 'under_construction', 'ready_to_move', 'completed']) },
    { key: 'construction_stage', label: 'Construction Stage', type: 'select', options: CONSTRUCTION_STAGE_OPTIONS },
    { key: 'possession_status', label: 'Possession Status', type: 'select', options: POSSESSION_STATUS_OPTIONS },
    { key: 'project_phase', label: 'Project Phase', placeholder: 'e.g. Phase 1' },
    { key: 'construction_start_date', label: 'Construction Start Date', type: 'date' },
    { key: 'expected_completion_date', label: 'Expected Completion Date', type: 'date' },
    { key: 'rera_possession_date', label: 'RERA Possession Date', type: 'date' },
    { key: 'target_possession_date', label: 'Target Possession Date', type: 'date' }
  ],
  specs: [
    { key: 'flooring', label: 'Flooring', type: 'textarea' },
    { key: 'doors', label: 'Doors', type: 'textarea' },
    { key: 'windows', label: 'Windows', type: 'textarea' },
    { key: 'kitchen', label: 'Kitchen', type: 'textarea' },
    { key: 'bathroom', label: 'Bathroom', type: 'textarea' },
    { key: 'electrical', label: 'Electrical', type: 'textarea' },
    { key: 'walls_paint', label: 'Walls / Paint', type: 'textarea' },
    { key: 'balcony', label: 'Balcony', type: 'textarea' },
    { key: 'other_specifications', label: 'Other Specifications', type: 'textarea', full: true }
  ],
  contact: [
    { key: 'agent_id', label: 'Assigned Agent', type: 'select', options: () => lookups.agents.map(a => ({ value: a.id, label: a.full_name })), full: true, quickAdd: 'agent', hint: 'Leads for this project will be routed to this agent' }
  ],
  seo: [
    { key: 'slug', label: 'URL Slug', req: true, full: true },
    { key: 'seo_title', label: 'SEO Title', full: true },
    { key: 'seo_description', label: 'SEO Description', type: 'textarea', full: true },
    { key: 'canonical_url', label: 'Canonical URL', full: true }
  ]
};

const AMENITY_CATEGORIES = [
  { key: 'clubhouse_community', label: 'Clubhouse & Community', preset: ['Clubhouse', 'Community Hall', 'Amphitheatre', 'Multipurpose Hall'] },
  { key: 'sports_fitness', label: 'Sports & Fitness', preset: ['Gymnasium', 'Swimming Pool', 'Tennis Court', 'Badminton Court', 'Jogging Track', 'Yoga Deck'] },
  { key: 'recreation_outdoors', label: 'Recreation & Outdoors', preset: ['Landscaped Garden', "Children's Play Area", 'Senior Citizen Area', 'Party Lawn'] },
  { key: 'security_safety', label: 'Security & Safety', preset: ['24x7 Security', 'CCTV Surveillance', 'Intercom', 'Fire Safety'] },
  { key: 'parking_mobility', label: 'Parking & Mobility', preset: ['Visitor Parking', 'Covered Parking', 'EV Charging'] },
  { key: 'utilities_power', label: 'Utilities & Power', preset: ['Power Backup', 'Water Softener', 'Rainwater Harvesting', 'STP'] },
  { key: 'building_facilities', label: 'Building Facilities', preset: ['High-Speed Elevators', 'Service Lift', 'Waste Management', 'Fire NOC'] },
  { key: 'family_children', label: 'Family & Children', preset: ["Kids' Pool", 'Day Care', 'Play School'] },
  { key: 'lifestyle', label: 'Lifestyle', preset: ['Cafeteria', 'Co-working Space', 'Mini Theatre', 'Library'] },
  { key: 'eco_friendly', label: 'Eco-Friendly Features', preset: ['Solar Panels', 'Organic Waste Composting', 'EV Charging Points', 'Green Building Certified'] }
];
const NEARBY_CATEGORIES = enumOpts(['transport', 'education', 'healthcare', 'shopping_retail', 'business_employment', 'lifestyle_entertainment']);

/* ============ default row factories ============ */

const DEFAULTS = {
  configuration: () => ({ _k: uid(), bhk_type: '1 BHK', area_unit: 'sq_ft', carpet_area: '', built_up_area: '', super_built_up_area: '', number_of_units: '', starting_price: '', maximum_price: '', price_type: 'total_price', price_on_request: false, availability: 'available', parking_included: 'not_available', parking_type: [], description: '' }),
  tower: () => ({ _k: uid(), tower_name: '', tower_number: '', number_of_floors: '', number_of_units: '', configurations: [], tower_status: 'under_construction', construction_stage: '', construction_start_date: '', expected_completion_date: '', possession_status: '', construction_details: '' }),
  amenity: (category, name) => ({ _k: uid(), category, amenity_name: name, amenity_type: name, description: '', is_available: true }),
  nearby: () => ({ _k: uid(), category: 'transport', location_type: '', name: '', distance: '', distance_unit: 'km', description: '' }),
  prosCons: (item_type) => ({ _k: uid(), item_type, content: '' }),
  document: () => ({ _k: uid(), document_type: 'rera_certificate', title: '', visibility: 'public', description: '', file_path: null, file_url: null, file_name: null }),
  litigation: () => ({ _k: uid(), status: 'no_known_litigation', case_title: '', court_tribunal: '', case_type: '', filing_date: '', current_status: '', case_description: '', supporting_document_path: null, supporting_document_url: null, supporting_document_name: null }),
  update: () => ({ _k: uid(), update_title: '', update_date: '', construction_stage: '', description: '', is_published: true, media: [] }),
  faq: () => ({ _k: uid(), question: '', answer: '', is_published: true }),
  galleryItem: () => ({ _k: uid(), category: 'exterior', title: '', image_path: null, image_url: null }),
  video: () => ({ _k: uid(), media_type: 'video', platform: 'youtube', title: '', media_url: '' })
};

function freshState() {
  return {
    project: {
      project_name: '', developer_id: '', project_type: 'apartment', launch_date: '', rera_number: '', overview: '', highlights: [],
      city_id: '', locality_id: '', address: '', pincode: '', latitude: '', longitude: '',
      total_land_area: '', land_area_unit: 'acre', total_towers_buildings: '', total_floors: '', total_residential_units: '', units_per_floor: '', number_of_phases: '', units_per_phase: '', open_green_area_value: '', open_green_area_unit: 'acre', built_up_project_area: '', built_up_project_area_unit: 'sq_ft',
      status: 'upcoming', construction_stage: '', possession_status: '', project_phase: '', construction_start_date: '', expected_completion_date: '', rera_possession_date: '', target_possession_date: '',
      starting_price: '', maximum_price: '', price_on_request: false, base_price: '', floor_rise_charges: '', parking_charges: '', clubhouse_charges: '', maintenance_charges: '', other_charges: '', gst_applicable: false, price_disclaimer: '', registration_stamp_duty_disclaimer: '',
      flooring: '', doors: '', windows: '', kitchen: '', bathroom: '', electrical: '', walls_paint: '', balcony: '', other_specifications: '',
      agent_id: '',
      slug: '', seo_title: '', seo_description: '', canonical_url: ''
    },
    configurations: [], towers: [], amenities: [], nearby: [], prosCons: [], documents: [], litigation: [], updates: [], faqs: [],
    media: { main: {}, masterPlan: {}, gallery: [], videos: [] }
  };
}

/* ============ entry point ============ */

let wizardOpen = false;

export async function openProjectForm(rootEl, user, existingId, exitCb) {
  content = rootEl;
  currentUser = user;
  onExit = exitCb;
  projectId = existingId || null;
  isEdit = !!existingId;
  stepIndex = 1;
  touched = false;
  historyPushCount = 0;
  intentionalExit = false;
  wizardOpen = true;

  content.innerHTML = `<div class="empty">Loading project form…</div>`;
  await loadLookups();

  if (isEdit) {
    state = await loadProject(existingId);
    if (!state) { content.innerHTML = `<div class="empty">Project not found.</div>`; return; }
  } else {
    state = freshState();
  }

  renderShell();
  pushWizardState();
}

// Every step change (Next, stepper/Edit jump) pushes one browser history entry, so the
// phone/browser back button steps back through the wizard one step at a time — and, once
// past the first step, exits the wizard back to whichever page opened it (also via back).
function pushWizardState() {
  historyPushCount++;
  history.pushState({ pfWizard: true, step: stepIndex }, '', location.hash);
}

// Whether project-form.js currently owns #content — app.js's single popstate listener
// checks this before deciding whether to route the event here or handle it itself.
export function isWizardOpen() {
  return wizardOpen;
}

// Called by app.js's popstate listener (never registers its own — see below for why: two
// independent listeners on the same event raced, with app.js's listener free to repaint
// #content with the target page before this module got a chance to "cancel" an exit).
// Returns true if this event was fully handled here (app.js should do nothing further),
// false if this was a real exit and app.js should go on to render whatever page the
// history entry landed on.
export function handleWizardPopState(e) {
  const st = e.state;
  if (st && st.pfWizard) {
    stepIndex = st.step;
    renderStepBody();
    window.scrollTo(0, 0);
    return true;
  }
  if (!intentionalExit && touched && !confirm('Leave this form? Unsaved changes on the current step may be lost.')) {
    pushWizardState();
    return true;
  }
  content.removeEventListener('input', onFieldInput);
  content.removeEventListener('change', onFieldChange);
  content.removeEventListener('click', onFieldClick);
  wizardOpen = false;
  intentionalExit = false;
  return false;
}

async function loadLookups() {
  const [dev, city, loc, agt] = await Promise.all([
    sb.from('developers').select('id,name').order('name'),
    sb.from('cities').select('id,name').order('name'),
    sb.from('localities').select('id,name,city_id').order('name'),
    sb.from('agents').select('id,full_name').order('full_name')
  ]);
  lookups.developers = dev.data || [];
  lookups.cities = city.data || [];
  lookups.localities = loc.data || [];
  lookups.agents = agt.data || [];
}

async function loadProject(id) {
  const s = freshState();
  const { data: p, error } = await sb.from('residential_projects').select('*').eq('id', id).single();
  if (error || !p) { console.error(error); return null; }
  Object.keys(s.project).forEach(k => { if (k in p && p[k] !== null) s.project[k] = p[k]; });
  s.project.highlights = p.highlights || [];

  const [cfg, tow, ame, near, pc, docs, lit, upd, faqs] = await Promise.all([
    sb.from('residential_configurations').select('*').eq('project_id', id).order('display_order'),
    sb.from('residential_towers').select('*').eq('project_id', id).order('display_order'),
    sb.from('residential_amenities').select('*').eq('project_id', id).order('display_order'),
    sb.from('residential_nearby_locations').select('*').eq('project_id', id).order('display_order'),
    sb.from('residential_project_pros_cons').select('*').eq('project_id', id).order('display_order'),
    sb.from('residential_documents').select('*').eq('project_id', id),
    sb.from('residential_litigation').select('*').eq('project_id', id),
    sb.from('residential_construction_updates').select('*,residential_construction_update_media(*)').eq('project_id', id).order('display_order'),
    sb.from('residential_faqs').select('*').eq('project_id', id).order('display_order')
  ]);
  s.configurations = (cfg.data || []).map(r => ({ ...r, _k: r.id, parking_type: r.parking_type || [] }));
  s.towers = (tow.data || []).map(r => ({ ...r, _k: r.id, configurations: r.configurations || [] }));
  s.amenities = (ame.data || []).map(r => ({ ...r, _k: r.id }));
  s.nearby = (near.data || []).map(r => ({ ...r, _k: r.id }));
  s.prosCons = (pc.data || []).map(r => ({ ...r, _k: r.id }));
  s.documents = (docs.data || []).map(r => ({ ...r, _k: r.id, file_name: (r.file_path || '').split('/').pop() }));
  s.litigation = (lit.data || []).map(r => ({ ...r, _k: r.id, supporting_document_name: (r.supporting_document_path || '').split('/').pop() }));
  s.updates = (upd.data || []).map(r => ({ ...r, _k: r.id, media: (r.residential_construction_update_media || []).map(m => ({ ...m, _k: m.id })) }));
  s.faqs = (faqs.data || []).map(r => ({ ...r, _k: r.id }));

  const { data: media } = await sb.from('residential_media').select('*').eq('project_id', id);
  s.media = { main: {}, masterPlan: {}, gallery: [], videos: [] };
  (media || []).forEach(m => {
    if (m.media_type === 'main_image') s.media.main = m;
    else if (m.media_type === 'master_plan') s.media.masterPlan = m;
    else if (m.media_type === 'gallery') s.media.gallery.push({ ...m, _k: m.id });
    else s.media.videos.push({ ...m, _k: m.id });
  });
  return s;
}

/* ============ shell + step render ============ */

function renderShell() {
  const pct = Math.round((stepIndex / TOTAL_STEPS) * 100);
  content.innerHTML = `<div class="wrap">
    <div class="form-head">
      <div class="form-head-left">
        <button class="back-btn" id="pf-close" title="${stepIndex > 1 ? 'Back' : 'Close'}">←</button>
        <div><h1>${isEdit ? 'Edit' : 'Add'} Residential Project</h1><p id="pf-step-label">Step ${stepIndex} of ${TOTAL_STEPS} · ${STEP_NAMES[stepIndex - 1]}</p></div>
      </div>
      <div class="form-head-right">
        <button class="btn-ghost" id="pf-save-draft">Save as Draft</button>
      </div>
    </div>
    <div class="progress-track"><div class="progress-fill" id="pf-progress" style="width:${pct}%"></div></div>
    <div class="form-shell">
      <div class="stepper" id="pf-stepper"></div>
      <div class="form-panel">
        <div class="form-panel-head" id="pf-panel-head"></div>
        <div class="form-panel-body" id="pf-panel-body"></div>
        <div class="form-footer">
          <span class="footer-step-label" id="pf-footer-label"></span>
          <div class="footer-actions">
            <button class="btn-outline" id="pf-back">← Back</button>
            <button class="btn-next" id="pf-next"></button>
          </div>
        </div>
      </div>
    </div>
  </div>`;

  $('#pf-close').addEventListener('click', () => history.back());
  $('#pf-save-draft').addEventListener('click', () => saveCurrentAndDraft());
  $('#pf-back').addEventListener('click', goBack);
  $('#pf-next').addEventListener('click', goNext);
  content.addEventListener('input', onFieldInput);
  content.addEventListener('change', onFieldChange);
  content.addEventListener('click', onFieldClick);

  renderStepBody();
}

function $(sel) { return content.querySelector(sel); }

function renderStepper() {
  const html = STEP_NAMES.map((name, i) => {
    const n = i + 1;
    const cls = n === stepIndex ? 'active' : (n < stepIndex ? 'done' : '');
    return `<button type="button" class="step ${cls}" data-goto="${n}"><span class="num"><span>${n}</span></span>${esc(name)}</button>`;
  }).join('');
  $('#pf-stepper').innerHTML = html;
}

// Handles both the left stepper's step buttons and the Review page's per-section "Edit"
// buttons — both carry [data-goto]. Delegated on `content` (see onFieldClick) so it keeps
// working after renderStepBody() replaces the panel body, unlike a direct per-render bind.
function gotoStep(n) {
  if (n <= stepIndex || projectId) {
    stepIndex = n;
    pushWizardState();
    renderStepBody();
    window.scrollTo(0, 0);
  }
}

function renderStepBody() {
  renderStepper();
  const pct = Math.round((stepIndex / TOTAL_STEPS) * 100);
  $('#pf-progress').style.width = pct + '%';
  $('#pf-step-label').textContent = `Step ${stepIndex} of ${TOTAL_STEPS} · ${STEP_NAMES[stepIndex - 1]}`;
  $('#pf-panel-head').innerHTML = `<h2>${esc(STEP_NAMES[stepIndex - 1])}</h2><p>${esc(STEP_SUB[stepIndex - 1])}</p>`;
  $('#pf-panel-body').innerHTML = renderBody(stepIndex);
  $('#pf-footer-label').textContent = `${pct}% complete`;
  $('#pf-back').disabled = stepIndex === 1;
  $('#pf-next').textContent = stepIndex === TOTAL_STEPS ? 'Submit for Verification →' : `Next: ${STEP_NAMES[stepIndex] || ''} →`;
  $('#pf-close').title = stepIndex > 1 ? 'Back' : 'Close';
  handleSpecialBindings();
  // No scrollTo here on purpose — renderStepBody() is also called for in-place updates on
  // the current step (toggling an amenity chip, adding/removing a repeat-card row, an
  // upload finishing, etc.), and jumping the page to the top on every one of those was the
  // "page moves up when clicking amenities" bug. Only an actual step change should scroll;
  // see goNext(), gotoStep() and handleWizardPopState() below, which call it explicitly.
}

/* ============ generic field rendering ============ */

function renderField(spec, value, attr) {
  const req = spec.req ? '<span class="req">*</span>' : '';
  const hint = spec.hint ? `<span class="hint">${esc(spec.hint)}</span>` : '';
  const fullCls = spec.full ? ' full' : '';
  if (spec.type === 'checkbox') {
    return `<div class="field${fullCls}"><label style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" ${attr} ${value ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--green)"> ${esc(spec.label)}</label>${hint}</div>`;
  }
  let input;
  if (spec.type === 'select') {
    const opts = typeof spec.options === 'function' ? spec.options() : spec.options;
    input = `<select ${attr}><option value="">Select…</option>${opts.map(o => `<option value="${esc(o.value)}"${String(value ?? '') === String(o.value) ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    if (spec.quickAdd) input = `<div style="display:flex;gap:6px">${input}<button type="button" class="btn-outline" style="padding:8px 10px;white-space:nowrap" data-quickadd="${spec.quickAdd}">+ New</button></div>`;
  } else if (spec.type === 'textarea') {
    input = `<textarea ${attr} placeholder="${esc(spec.placeholder || '')}">${esc(value ?? '')}</textarea>`;
  } else if (spec.unit) {
    input = `<div class="field-suffix"><input ${attr} type="${spec.type || 'text'}" value="${value == null ? '' : esc(String(value))}" placeholder="${esc(spec.placeholder || '')}"><span>${esc(spec.unit)}</span></div>`;
  } else {
    input = `<input ${attr} type="${spec.type || 'text'}" value="${value == null ? '' : esc(String(value))}" placeholder="${esc(spec.placeholder || '')}">`;
  }
  const label = spec.label ? `<label>${esc(spec.label)} ${req}</label>` : '';
  return `<div class="field${fullCls}">${label}${input}${hint}</div>`;
}

function renderFieldsGrid(specs, values, bindPrefix) {
  return `<div class="form-grid">${specs.map(s => renderField(s, values[s.key], `data-bind="${bindPrefix}.${s.key}"`)).join('')}</div>`;
}

function validateFields(specs, values) {
  const missing = [];
  for (const s of specs) {
    if (!s.req) continue;
    const v = values[s.key];
    if (v === null || v === undefined || v === '') missing.push(s.label);
  }
  return missing;
}

function chipRowHtml(label, hint, values, bindPath, inputId) {
  const chips = (values || []).map((v, i) => `<span class="chip active">${esc(v)}<span style="cursor:pointer;margin-left:6px" data-remove-chip="${bindPath}" data-idx="${i}">✕</span></span>`).join('');
  return `<div class="field full">
    <label>${esc(label)}</label>${hint ? `<span class="hint">${esc(hint)}</span>` : ''}
    <div class="chip-row">${chips}<input type="text" id="${inputId}" placeholder="Type and press Add…" style="border:1px solid #d5dfde;border-radius:20px;padding:7px 12px;font-size:12px;width:180px">
    <span class="chip chip-add" data-add-chip="${bindPath}" data-input="${inputId}">+ Add</span></div>
  </div>`;
}

/* ============ delegated event handlers ============ */

function onFieldInput(e) {
  const el = e.target.closest('[data-bind]');
  if (!el || el.tagName === 'SELECT') return;
  applyBind(el);
}
function onFieldChange(e) {
  const el = e.target.closest('[data-bind]');
  if (!el) return;
  applyBind(el);
  if (el.dataset.bind === 'project.city_id') { state.project.locality_id = ''; renderStepBody(); }
}
function applyBind(el) {
  touched = true;
  const path = el.dataset.bind;
  let value;
  if (el.type === 'checkbox') value = el.checked;
  else if (el.type === 'number') value = el.value === '' ? '' : Number(el.value);
  else value = el.value;
  setPath(state, path, value);
}

function onFieldClick(e) {
  const goto = e.target.closest('[data-goto]');
  if (goto) { gotoStep(Number(goto.dataset.goto)); return; }
  const addItem = e.target.closest('[data-add-item]');
  if (addItem) { addRepeatItem(addItem.dataset.addItem, addItem.dataset.arg); return; }
  const rmItem = e.target.closest('[data-remove-item]');
  if (rmItem) { removeRepeatItem(rmItem.dataset.removeItem, Number(rmItem.dataset.idx)); return; }
  const addChip = e.target.closest('[data-add-chip]');
  if (addChip) { addChipValue(addChip.dataset.addChip, addChip.dataset.input); return; }
  const rmChip = e.target.closest('[data-remove-chip]');
  if (rmChip) { removeChipValue(rmChip.dataset.removeChip, Number(rmChip.dataset.idx)); return; }
  const quickAdd = e.target.closest('[data-quickadd]');
  if (quickAdd) { openQuickAdd(quickAdd.dataset.quickadd); return; }
  const upload = e.target.closest('[data-remove-upload]');
  if (upload) { setPath(state, upload.dataset.removeUpload + '_path', null); setPath(state, upload.dataset.removeUpload + '_url', null); setPath(state, upload.dataset.removeUpload + '_name', null); renderStepBody(); return; }
}

function addRepeatItem(key, arg) {
  touched = true;
  const arr = getPath(state, key) || [];
  let item;
  if (key === 'amenities') item = DEFAULTS.amenity(arg, '');
  else if (key === 'prosCons') item = DEFAULTS.prosCons(arg);
  else {
    const factoryName = key.endsWith('s') ? key.slice(0, -1) : key;
    const map = { configurations: 'configuration', towers: 'tower', nearby: 'nearby', documents: 'document', litigation: 'litigation', updates: 'update', faqs: 'faq' };
    item = DEFAULTS[map[key] || factoryName] ? DEFAULTS[map[key] || factoryName]() : { _k: uid() };
  }
  arr.push(item);
  setPath(state, key, arr);
  renderStepBody();
}
function removeRepeatItem(key, idx) {
  touched = true;
  const arr = getPath(state, key) || [];
  arr.splice(idx, 1);
  renderStepBody();
}
function addChipValue(path, inputId) {
  const input = document.getElementById(inputId);
  const v = (input?.value || '').trim();
  if (!v) return;
  const arr = getPath(state, path) || [];
  arr.push(v);
  setPath(state, path, arr);
  touched = true;
  renderStepBody();
}
function removeChipValue(path, idx) {
  const arr = getPath(state, path) || [];
  arr.splice(idx, 1);
  touched = true;
  renderStepBody();
}

/* ============ quick-add master data ============ */

async function openQuickAdd(kind) {
  if (kind === 'developer') {
    const name = prompt('New developer name:');
    if (!name) return;
    const { data, error } = await sb.from('developers').insert({ name }).select('id,name').single();
    if (error) { toast(error.message, true); return; }
    lookups.developers.push(data);
    state.project.developer_id = data.id;
    renderStepBody();
  } else if (kind === 'city') {
    const name = prompt('New city name:');
    if (!name) return;
    const stateName = prompt('State:');
    if (!stateName) return;
    const { data, error } = await sb.from('cities').insert({ name, state: stateName }).select('id,name').single();
    if (error) { toast(error.message, true); return; }
    lookups.cities.push(data);
    state.project.city_id = data.id;
    renderStepBody();
  } else if (kind === 'locality') {
    if (!state.project.city_id) { toast('Select a city first', true); return; }
    const name = prompt('New locality name:');
    if (!name) return;
    const { data, error } = await sb.from('localities').insert({ name, city_id: state.project.city_id }).select('id,name,city_id').single();
    if (error) { toast(error.message, true); return; }
    lookups.localities.push(data);
    state.project.locality_id = data.id;
    renderStepBody();
  } else if (kind === 'agent') {
    const name = prompt('New agent full name:');
    if (!name) return;
    const { data, error } = await sb.from('agents').insert({ full_name: name }).select('id,full_name').single();
    if (error) { toast(error.message, true); return; }
    lookups.agents.push(data);
    state.project.agent_id = data.id;
    renderStepBody();
  }
}

/* ============ step body renderers ============ */

function renderBody(i) {
  switch (i) {
    case 1: return renderBasic();
    case 2: return renderFieldsGrid(FIELDS.location, state.project, 'project');
    case 3: return renderFieldsGrid(FIELDS.size, state.project, 'project');
    case 4: return renderFieldsGrid(FIELDS.status, state.project, 'project');
    case 5: return renderConfigurations();
    case 6: return renderFieldsGrid(FIELDS.specs, state.project, 'project');
    case 7: return renderTowers();
    case 8: return renderAmenities();
    case 9: return renderNearby();
    case 10: return renderMedia();
    case 11: return renderProsCons();
    case 12: return renderDocuments();
    case 13: return renderLitigation();
    case 14: return renderUpdates();
    case 15: return renderFaqs();
    case 16: return renderFieldsGrid(FIELDS.contact, state.project, 'project');
    case 17: return renderSeo();
    case 18: return renderReview();
    default: return '';
  }
}

function renderBasic() {
  const specs = FIELDS.basic.filter(s => s.key !== 'overview');
  const overview = FIELDS.basic.find(s => s.key === 'overview');
  return `<div class="form-grid">${specs.map(s => renderField(s, state.project[s.key], `data-bind="project.${s.key}"`)).join('')}
    ${renderField(overview, state.project.overview, `data-bind="project.overview"`)}
    ${chipRowHtml('Project Highlights', 'Short, factual highlights — separate from Pros & Cons', state.project.highlights, 'project.highlights', 'pf-highlight-input')}
    <div class="field full"><div class="hint">Project Status, RERA Possession Date and Target Possession Date are set together in "Status &amp; Construction" — kept in one place so they can't fall out of sync.</div></div>
  </div>`;
}

// Project-level starting/maximum price shown on the public listing card — derived from the
// BHK configurations added in Step 5 rather than typed in separately (there's no dedicated
// pricing step; see projectPayload()).
function priceRangeFromConfigs() {
  const starts = state.configurations.map(c => Number(c.starting_price)).filter(n => n > 0);
  const maxes = state.configurations.map(c => Number(c.maximum_price || c.starting_price)).filter(n => n > 0);
  if (!starts.length) return { min: null, max: null };
  return { min: Math.min(...starts), max: maxes.length ? Math.max(...maxes) : Math.min(...starts) };
}

function renderSeo() {
  if (!state.project.slug) state.project.slug = slugify([state.project.project_name, lookups.localities.find(l => l.id === state.project.locality_id)?.name, lookups.cities.find(c => c.id === state.project.city_id)?.name].filter(Boolean).join('-'));
  return `<div class="form-grid">${FIELDS.seo.map(s => renderField(s, state.project[s.key], `data-bind="project.${s.key}"`)).join('')}
    <div class="field full"><div class="hint">🔒 Indexing is controlled automatically by publishing status — draft, pending, under-review and rejected projects are never indexable, regardless of this content.</div></div>
  </div>`;
}

function repeatCard(title, idx, bodyHtml, key) {
  return `<div class="repeat-card"><div class="repeat-card-head"><b>${esc(title)}</b><button type="button" class="repeat-remove" data-remove-item="${key}" data-idx="${idx}">✕</button></div>${bodyHtml}</div>`;
}

// Shared renderer for the repeat-card steps (Configurations, Towers, Nearby, FAQs, Documents, Litigation, Construction Updates) —
// they all follow the same map/repeatCard/add-button shape and only differ in fields, title and any extra per-item HTML.
function renderRepeatStep(key, fields, opts) {
  const items = getPath(state, key) || [];
  const list = items.map((item, i) => {
    const fieldsHtml = fields.map(s => renderField(s, item[s.key], `data-bind="${key}.${i}.${s.key}"`)).join('');
    const extra = opts.extraHtml ? opts.extraHtml(item, i) : '';
    const title = (opts.titleOf && opts.titleOf(item, i)) || `${opts.singular} ${i + 1}`;
    return repeatCard(title, i, `<div class="form-grid">${fieldsHtml}${extra}</div>`, key);
  }).join('');
  return `<div class="repeat-list">${list || `<div class="empty">${esc(opts.emptyText)}</div>`}</div>
    <button type="button" class="add-repeat" data-add-item="${key}">+ ${esc(opts.addLabel)}</button>`;
}

const CONFIG_FIELDS = [
  { key: 'bhk_type', label: 'BHK', req: true },
  { key: 'area_unit', label: 'Area Unit', type: 'select', options: AREA_UNIT_OPTIONS },
  { key: 'number_of_units', label: 'Number of Units', type: 'number' },
  { key: 'carpet_area', label: 'Carpet Area', type: 'number', unit: 'area' },
  { key: 'built_up_area', label: 'Built-up Area', type: 'number', unit: 'area' },
  { key: 'super_built_up_area', label: 'Super Built-up Area', type: 'number', unit: 'area' },
  { key: 'starting_price', label: 'Starting Price', type: 'number', unit: '₹', req: true },
  { key: 'maximum_price', label: 'Maximum Price', type: 'number', unit: '₹' },
  { key: 'price_type', label: 'Price Type', type: 'select', options: enumOpts(['total_price', 'price_per_sq_ft', 'price_per_sq_m']) },
  { key: 'availability', label: 'Availability', type: 'select', options: enumOpts(['available', 'sold_out', 'on_request']) },
  { key: 'parking_included', label: 'Parking', type: 'select', options: enumOpts(['included', 'additional', 'not_available']) }
];
function renderConfigurations() {
  return renderRepeatStep('configurations', CONFIG_FIELDS, {
    singular: 'BHK Configuration', emptyText: 'No configurations added yet.', addLabel: 'Add BHK Configuration',
    extraHtml: (c, i) => {
      const parkTypes = ['covered', 'open', 'mechanical', 'ev', 'other'];
      const parkChips = parkTypes.map(t => `<span class="chip${(c.parking_type || []).includes(t) ? ' active' : ''}" data-toggle-parktype="${i}" data-val="${t}" style="cursor:pointer">${esc(t)}</span>`).join('');
      return `<div class="field full"><label>Parking Type</label><div class="chip-row">${parkChips}</div></div>`;
    }
  });
}

const TOWER_FIELDS = [
  { key: 'tower_name', label: 'Tower Name', req: true, placeholder: 'e.g. Tower A' },
  { key: 'tower_number', label: 'Tower Number' },
  { key: 'number_of_floors', label: 'Number of Floors', type: 'number' },
  { key: 'number_of_units', label: 'Number of Units', type: 'number' },
  { key: 'tower_status', label: 'Tower Status', type: 'select', options: enumOpts(['upcoming', 'under_construction', 'ready_to_move', 'completed', 'other']) },
  { key: 'construction_stage', label: 'Construction Stage', type: 'select', options: CONSTRUCTION_STAGE_OPTIONS },
  { key: 'possession_status', label: 'Possession Status', type: 'select', options: POSSESSION_STATUS_OPTIONS },
  { key: 'construction_start_date', label: 'Construction Start Date', type: 'date' },
  { key: 'expected_completion_date', label: 'Expected Completion Date', type: 'date' },
  { key: 'construction_details', label: 'Construction Details', type: 'textarea', full: true }
];
function renderTowers() {
  return renderRepeatStep('towers', TOWER_FIELDS, {
    titleOf: t => t.tower_name, singular: 'Tower', emptyText: 'No towers added yet.', addLabel: 'Add Tower / Building',
    extraHtml: (t, i) => chipRowHtml('Configurations in this tower', '', t.configurations, `towers.${i}.configurations`, `pf-tower-cfg-${i}`)
  });
}

function renderAmenities() {
  const sections = AMENITY_CATEGORIES.map(cat => {
    const existing = state.amenities.filter(a => a.category === cat.key);
    const presetChips = cat.preset.map(name => {
      const on = existing.some(a => a.amenity_name === name);
      return `<span class="chip${on ? ' active' : ''}" data-toggle-amenity="${cat.key}" data-name="${esc(name)}" style="cursor:pointer">${esc(name)}</span>`;
    }).join('');
    const customExtra = existing.filter(a => !cat.preset.includes(a.amenity_name));
    const customChips = customExtra.map(a => {
      const idx = state.amenities.indexOf(a);
      return `<span class="chip active">${esc(a.amenity_name)}<span style="cursor:pointer;margin-left:6px" data-remove-item="amenities" data-idx="${idx}">✕</span></span>`;
    }).join('');
    return `<div class="field full" style="margin-bottom:6px"><label>${esc(cat.label)}</label>
      <div class="chip-row">${presetChips}${customChips}
        <input type="text" id="pf-custom-${cat.key}" placeholder="Custom amenity…" style="border:1px solid #d5dfde;border-radius:20px;padding:7px 12px;font-size:12px;width:160px">
        <span class="chip chip-add" data-add-custom-amenity="${cat.key}" data-input="pf-custom-${cat.key}">+ Add custom</span>
      </div></div>`;
  }).join('');
  return `<div class="form-grid">${sections}</div>`;
}

const NEARBY_FIELDS = [
  { key: 'category', label: 'Category', req: true, type: 'select', options: NEARBY_CATEGORIES },
  { key: 'location_type', label: 'Type', placeholder: 'e.g. Metro Station' },
  { key: 'name', label: 'Name', req: true, placeholder: 'e.g. Baner Metro Station' },
  { key: 'distance', label: 'Distance', type: 'number' },
  { key: 'distance_unit', label: 'Distance Unit', type: 'select', options: enumOpts(['m', 'km']) },
  { key: 'description', label: 'Description', type: 'textarea', full: true }
];
function renderNearby() {
  return renderRepeatStep('nearby', NEARBY_FIELDS, {
    titleOf: n => n.name, singular: 'Location', emptyText: 'No nearby locations added yet.', addLabel: 'Add Nearby Landmark'
  });
}

const PROSCONS_FIELDS = [{ key: 'content', label: '', full: true, placeholder: 'Describe this point…' }];
function renderProsCons() {
  const pros = state.prosCons.filter(p => p.item_type === 'pro');
  const cons = state.prosCons.filter(p => p.item_type === 'con');
  const block = (title, items, type) => {
    const list = items.map(p => {
      const idx = state.prosCons.indexOf(p);
      return `<div class="repeat-card"><div class="repeat-card-head"><b>${type === 'pro' ? 'Pro' : 'Con'}</b><button type="button" class="repeat-remove" data-remove-item="prosCons" data-idx="${idx}">✕</button></div>
        <div class="form-grid">${renderField(PROSCONS_FIELDS[0], p.content, `data-bind="prosCons.${idx}.content"`)}</div></div>`;
    }).join('');
    return `<div class="field full"><label>${esc(title)}</label></div>
      <div class="repeat-list">${list || '<div class="empty">None added yet.</div>'}</div>
      <button type="button" class="add-repeat" data-add-item="prosCons" data-arg="${type}">+ Add ${type === 'pro' ? 'Pro' : 'Con'}</button>`;
  };
  return `<div style="margin-bottom:24px">${block('Pros', pros, 'pro')}</div><div>${block('Cons', cons, 'con')}</div>`;
}

const FAQ_FIELDS = [
  { key: 'question', label: 'Question', req: true, full: true },
  { key: 'answer', label: 'Answer', req: true, type: 'textarea', full: true },
  { key: 'is_published', label: 'Published', type: 'checkbox' }
];
function renderFaqs() {
  return renderRepeatStep('faqs', FAQ_FIELDS, {
    titleOf: f => f.question, singular: 'FAQ', emptyText: 'No FAQs added yet.', addLabel: 'Add FAQ'
  });
}

const UPDATE_FIELDS = [
  { key: 'update_title', label: 'Update Title', req: true },
  { key: 'update_date', label: 'Update Date', req: true, type: 'date' },
  { key: 'construction_stage', label: 'Construction Stage', type: 'select', options: CONSTRUCTION_STAGE_OPTIONS },
  { key: 'is_published', label: 'Published', type: 'checkbox' },
  { key: 'description', label: 'Description', type: 'textarea', full: true }
];
function renderUpdates() {
  return renderRepeatStep('updates', UPDATE_FIELDS, {
    titleOf: u => u.update_title, singular: 'Update', emptyText: 'No construction updates added yet.', addLabel: 'Add Construction Update',
    extraHtml: (u, i) => {
      const media = (u.media || []).map(m => `<div class="upload-thumb"><span class="name">${esc(m.media_path?.split('/').pop() || 'photo')}</span></div>`).join('');
      const uploadHtml = projectId ? `<label class="upload-box">📷 Add site photo<input type="file" accept="image/*" data-update-upload="${i}"></label>${media}` : `<div class="hint">Save the project first to attach photos.</div>`;
      return `<div class="field full">${uploadHtml}</div>`;
    }
  });
}

const DOC_FIELDS = [
  { key: 'document_type', label: 'Document Type', req: true, type: 'select', options: enumOpts(['rera_certificate', 'project_brochure', 'price_sheet', 'floor_plan_pdf', 'approvals', 'noc', 'other']) },
  { key: 'title', label: 'Title', req: true },
  { key: 'visibility', label: 'Visibility', type: 'select', options: enumOpts(['public', 'restricted', 'internal']) },
  { key: 'description', label: 'Description', type: 'textarea', full: true }
];
function renderDocuments() {
  return renderRepeatStep('documents', DOC_FIELDS, {
    titleOf: d => d.title, singular: 'Document', emptyText: 'No documents added yet.', addLabel: 'Add Document',
    extraHtml: (d, i) => {
      const uploadHtml = d.file_name
        ? `<div class="upload-thumb"><span class="name">${esc(d.file_name)}</span><button type="button" data-remove-upload="documents.${i}.file">✕</button></div>`
        : (projectId ? `<label class="upload-box">📄 Click to upload file<input type="file" data-doc-upload="${i}"></label>` : `<div class="hint">Save the project first (through Status &amp; Construction) to upload files.</div>`);
      return `<div class="field full">${uploadHtml}</div>`;
    }
  });
}

const LIT_FIELDS = [
  { key: 'status', label: 'Status', req: true, type: 'select', options: enumOpts(['no_known_litigation', 'litigation_reported', 'litigation_resolved', 'under_legal_review', 'information_not_available']) },
  { key: 'case_title', label: 'Case Title' },
  { key: 'court_tribunal', label: 'Court / Tribunal' },
  { key: 'case_type', label: 'Case Type' },
  { key: 'filing_date', label: 'Filing Date', type: 'date' },
  { key: 'current_status', label: 'Current Status' },
  { key: 'case_description', label: 'Case Description', type: 'textarea', full: true }
];
function renderLitigation() {
  return renderRepeatStep('litigation', LIT_FIELDS, {
    titleOf: l => l.case_title, singular: 'Litigation Entry',
    emptyText: 'No litigation entries. Default is "No Known Litigation" if left empty.', addLabel: 'Add Litigation Entry',
    extraHtml: (l, i) => {
      const uploadHtml = l.supporting_document_name
        ? `<div class="upload-thumb"><span class="name">${esc(l.supporting_document_name)}</span><button type="button" data-remove-upload="litigation.${i}.supporting_document">✕</button></div>`
        : (projectId ? `<label class="upload-box">📄 Attach supporting document<input type="file" data-lit-upload="${i}"></label>` : `<div class="hint">Save the project first to attach a document.</div>`);
      return `<div class="field full">${uploadHtml}</div>`;
    }
  });
}

function renderMedia() {
  if (!projectId) {
    return `<div class="empty">Save the project first (complete through Status &amp; Construction, then Save as Draft) to upload media.</div>`;
  }
  const main = state.media.main;
  const mp = state.media.masterPlan;
  const galleryItems = state.media.gallery.map((g, i) => `<div class="upload-thumb"><img src="${esc(g.media_url || '')}"><span class="name">${esc(g.category || '')}</span><button type="button" data-remove-gallery="${i}">✕</button></div>`).join('');
  const videos = state.media.videos.map((v, i) => `<div class="form-grid" style="margin-bottom:10px">
      ${renderField({ label: 'Platform', type: 'select', options: enumOpts(['youtube', 'facebook', 'instagram', 'other']) }, v.platform, `data-bind="media.videos.${i}.platform"`)}
      ${renderField({ label: v.media_type === 'reel' ? 'Reel Title' : 'Video Title' }, v.title, `data-bind="media.videos.${i}.title"`)}
      ${renderField({ label: 'URL', full: true }, v.media_url, `data-bind="media.videos.${i}.media_url"`)}
    </div>`).join('');
  return `
    <div class="field full"><label>Main Image</label>
      ${main.media_url ? `<div class="upload-thumb"><img src="${esc(main.media_url)}"><span class="name">Main image set</span><button type="button" data-remove-upload="media.main">✕</button></div>` : `<label class="upload-box">📷 Click to upload main image<input type="file" accept="image/*" data-main-upload="1"></label>`}
    </div>
    <div class="field full"><label>Master Plan</label>
      ${mp.media_url ? `<div class="upload-thumb"><img src="${esc(mp.media_url)}"><span class="name">Master plan set</span><button type="button" data-remove-upload="media.masterPlan">✕</button></div>` : `<label class="upload-box">🗺️ Click to upload master plan<input type="file" accept="image/*" data-masterplan-upload="1"></label>`}
    </div>
    <div class="field full"><label>Gallery</label>
      ${galleryItems}
      <label class="upload-box">🖼️ Add gallery photo<input type="file" accept="image/*" data-gallery-upload="1"></label>
    </div>
    <div class="field full"><label>Videos / Virtual Tour / Reels</label>${videos}
      <button type="button" class="add-repeat" data-add-item="media.videos">+ Add Video Link</button>
    </div>`;
}

/* ============ review ============ */

function renderReview() {
  const p = state.project;
  const dev = lookups.developers.find(d => d.id === p.developer_id)?.name || '—';
  const city = lookups.cities.find(c => c.id === p.city_id)?.name || '—';
  const loc = lookups.localities.find(l => l.id === p.locality_id)?.name || '—';
  const agent = lookups.agents.find(a => a.id === p.agent_id)?.full_name || '—';
  const section = (title, rows, stepNum) => `<div class="review-card">
    <div class="review-card-head"><b>${esc(title)}</b><button type="button" data-goto="${stepNum}">Edit</button></div>
    <dl>${rows.map(([k, v]) => `<div><dt>${esc(k)}:</dt> <dd>${esc(v || '—')}</dd></div>`).join('')}</dl>
  </div>`;
  const range = priceRangeFromConfigs();
  const priceText = range.min == null ? 'Not set' : (range.min === range.max ? `₹${range.min.toLocaleString('en-IN')}` : `₹${range.min.toLocaleString('en-IN')} – ₹${range.max.toLocaleString('en-IN')}`);
  const html = `<div class="review-grid">
    ${section('1. Basic Information', [['Project', p.project_name], ['Developer', dev], ['Type', p.project_type], ['Highlights', `${p.highlights.length} added`]], 1)}
    ${section('2. Project Location', [['Address', p.address], ['City / Locality', `${loc}, ${city}`], ['Pincode', p.pincode]], 2)}
    ${section('3. Size & Scale', [['Land Area', p.total_land_area ? `${p.total_land_area} ${p.land_area_unit}` : '—'], ['Towers', p.total_towers_buildings], ['Total Units', p.total_residential_units]], 3)}
    ${section('4. Status & Construction', [['Status', p.status], ['Construction Stage', p.construction_stage], ['Target Possession', p.target_possession_date]], 4)}
    ${section('5. Configurations', [['Variants', `${state.configurations.length} added`], ['Price Range', priceText]], 5)}
    ${section('6. Apartment Specifications', [['Flooring', p.flooring], ['Kitchen', p.kitchen]], 6)}
    ${section('7. Tower / Building Details', [['Towers added', `${state.towers.length}`]], 7)}
    ${section('8. Amenities & Features', [['Selected', `${state.amenities.length} amenities`]], 8)}
    ${section('9. Nearby Locations', [['Added', `${state.nearby.length} landmarks`]], 9)}
    ${section('10. Project Media', [['Main image', state.media.main.media_url ? 'Uploaded' : 'Not set'], ['Gallery', `${state.media.gallery.length} images`], ['Videos', `${state.media.videos.length} added`]], 10)}
    ${section('11. Pros & Cons', [['Pros', `${state.prosCons.filter(x => x.item_type === 'pro').length}`], ['Cons', `${state.prosCons.filter(x => x.item_type === 'con').length}`]], 11)}
    ${section('12. Project Documents', [['Documents', `${state.documents.length} added`]], 12)}
    ${section('13. Litigation & Legal', [['Entries', `${state.litigation.length}`]], 13)}
    ${section('14. Construction Updates', [['Updates', `${state.updates.length}`]], 14)}
    ${section('15. Project FAQ', [['FAQs added', `${state.faqs.length}`]], 15)}
    ${section('16. Contact / Enquiry', [['Assigned Agent', agent]], 16)}
    ${section('17. SEO', [['Slug', p.slug], ['SEO Title', p.seo_title]], 17)}
  </div>
  <div class="confirm-row"><input type="checkbox" id="pf-confirm"><label for="pf-confirm">I confirm this information is accurate and ready for verification. <span class="req">*</span></label></div>`;
  return html;
}

/* ============ toast ============ */

/* ============ navigation / persistence ============ */

function goBack() {
  history.back();
}

async function goNext() {
  handleSpecialBindings();
  const specs = stepFieldSpecs(stepIndex);
  if (specs) {
    const missing = validateFields(specs, state.project);
    if (missing.length) { toast(`Please fill: ${missing.join(', ')}`, true); return; }
  }
  const repeatSpec = repeatStepSpecs(stepIndex);
  if (repeatSpec) {
    const [arrayKey, fields] = repeatSpec;
    const missing = validateRepeatStep(getPath(state, arrayKey) || [], fields);
    if (missing.length) { toast(`Please fill: ${missing.join(', ')}`, true); return; }
  }
  if (stepIndex === TOTAL_STEPS) {
    if (!$('#pf-confirm')?.checked) { toast('Please confirm the information is accurate before submitting.', true); return; }
    await submitForVerification();
    return;
  }

  $('#pf-next').disabled = true;
  try {
    const ok = await persistStep(stepIndex);
    if (!ok) return;
  } finally {
    $('#pf-next').disabled = false;
  }
  stepIndex++;
  pushWizardState();
  renderStepBody();
  window.scrollTo(0, 0);
}

function stepFieldSpecs(i) {
  const map = { 1: FIELDS.basic, 2: FIELDS.location, 3: FIELDS.size, 4: FIELDS.status, 6: FIELDS.specs, 16: FIELDS.contact, 17: FIELDS.seo };
  return map[i] || null;
}

// Repeatable steps' required fields aren't covered by stepFieldSpecs() above (that only
// validates the single-record FIELDS.* steps) — without this, a required field left blank
// on a repeat-card step (e.g. a Construction Update with no date) would pass validation,
// then fail at the database with a NOT NULL / invalid-date error, and Next would silently
// do nothing.
function repeatStepSpecs(i) {
  const map = {
    5: ['configurations', CONFIG_FIELDS], 7: ['towers', TOWER_FIELDS], 9: ['nearby', NEARBY_FIELDS],
    12: ['documents', DOC_FIELDS], 14: ['updates', UPDATE_FIELDS], 15: ['faqs', FAQ_FIELDS]
  };
  return map[i] || null;
}

function validateRepeatStep(items, fields) {
  const missing = [];
  items.forEach((item, idx) => {
    for (const f of fields) {
      if (f.req && (item[f.key] === null || item[f.key] === undefined || item[f.key] === '')) {
        missing.push(`${f.label} (#${idx + 1})`);
      }
    }
  });
  return missing;
}

// wires up handlers that need live DOM access not covered by data-bind (toggles, uploads)
function handleSpecialBindings() {
  content.querySelectorAll('[data-toggle-parktype]').forEach(el => {
    el.onclick = () => {
      const i = Number(el.dataset.toggleParktype), val = el.dataset.val;
      const arr = state.configurations[i].parking_type || [];
      const idx = arr.indexOf(val);
      if (idx >= 0) arr.splice(idx, 1); else arr.push(val);
      state.configurations[i].parking_type = arr;
      touched = true;
      renderStepBody();
    };
  });
  content.querySelectorAll('[data-toggle-amenity]').forEach(el => {
    el.onclick = () => {
      const category = el.dataset.toggleAmenity, name = el.dataset.name;
      const idx = state.amenities.findIndex(a => a.category === category && a.amenity_name === name);
      if (idx >= 0) state.amenities.splice(idx, 1);
      else state.amenities.push(DEFAULTS.amenity(category, name));
      touched = true;
      renderStepBody();
    };
  });
  content.querySelectorAll('[data-add-custom-amenity]').forEach(el => {
    el.onclick = () => {
      const category = el.dataset.addCustomAmenity;
      const input = document.getElementById(el.dataset.input);
      const name = (input?.value || '').trim();
      if (!name) return;
      state.amenities.push(DEFAULTS.amenity(category, name));
      touched = true;
      renderStepBody();
    };
  });
  content.querySelectorAll('[data-remove-gallery]').forEach(el => {
    el.onclick = () => { state.media.gallery.splice(Number(el.dataset.removeGallery), 1); touched = true; renderStepBody(); };
  });
  content.querySelectorAll('input[type=file][data-main-upload]').forEach(el => { el.onchange = () => handleUpload(el.files[0], 'residential-media', 'media/main', r => { state.media.main = { media_type: 'main_image', ...r }; renderStepBody(); }); });
  content.querySelectorAll('input[type=file][data-masterplan-upload]').forEach(el => { el.onchange = () => handleUpload(el.files[0], 'residential-media', 'media/master-plan', r => { state.media.masterPlan = { media_type: 'master_plan', ...r }; renderStepBody(); }); });
  content.querySelectorAll('input[type=file][data-gallery-upload]').forEach(el => { el.onchange = () => handleUpload(el.files[0], 'residential-media', 'media/gallery', r => { state.media.gallery.push({ _k: uid(), media_type: 'gallery', category: 'exterior', ...r }); renderStepBody(); }); });
  content.querySelectorAll('input[type=file][data-doc-upload]').forEach(el => {
    el.onchange = () => { const i = Number(el.dataset.docUpload); handleUpload(el.files[0], 'residential-documents', 'documents', r => { state.documents[i].file_path = r.media_path; state.documents[i].file_url = r.media_url || null; state.documents[i].file_name = el.files[0].name; renderStepBody(); }); };
  });
  content.querySelectorAll('input[type=file][data-lit-upload]').forEach(el => {
    el.onchange = () => { const i = Number(el.dataset.litUpload); handleUpload(el.files[0], 'residential-documents', 'litigation', r => { state.litigation[i].supporting_document_path = r.media_path; state.litigation[i].supporting_document_url = r.media_url || null; state.litigation[i].supporting_document_name = el.files[0].name; renderStepBody(); }); };
  });
  content.querySelectorAll('input[type=file][data-update-upload]').forEach(el => {
    el.onchange = () => { const i = Number(el.dataset.updateUpload); handleUpload(el.files[0], 'residential-media', 'construction-updates', r => { state.updates[i].media = state.updates[i].media || []; state.updates[i].media.push({ _k: uid(), media_path: r.media_path, media_url: r.media_url }); renderStepBody(); }); };
  });
}

async function handleUpload(file, bucket, folder, cb) {
  if (!file || !projectId) return;
  toast('Uploading…');
  const safeName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const path = `${projectId}/${folder}/${Date.now()}-${safeName}`;
  const { error } = await sb.storage.from(bucket).upload(path, file, { upsert: true });
  if (error) { toast(error.message, true); return; }
  let url = null;
  if (bucket !== 'residential-documents') {
    url = sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  }
  cb({ media_path: path, media_url: url });
  toast('Uploaded');
}

/* ============ save logic ============ */

async function ensureProjectCode() {
  const cityName = lookups.cities.find(c => c.id === state.project.city_id)?.name || 'GEN';
  const cityCode = cityName.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'GEN';
  return `RES-${cityCode}-${Date.now().toString(36).toUpperCase().slice(-6)}`;
}
async function ensureUniqueSlug(base) {
  let slug = base || 'project';
  let n = 1;
  for (;;) {
    let q = sb.from('residential_projects').select('id').eq('slug', slug);
    if (projectId) q = q.neq('id', projectId);
    const { data } = await q.limit(1);
    if (!data || !data.length) return slug;
    n++;
    slug = `${base}-${n}`;
  }
}

function projectPayload() {
  const p = state.project;
  const num = v => (v === '' || v === null || v === undefined ? null : Number(v));
  const str = v => (v === '' ? null : v);
  return {
    project_name: p.project_name, developer_id: p.developer_id, project_type: p.project_type,
    launch_date: str(p.launch_date), rera_number: str(p.rera_number), overview: p.overview, highlights: p.highlights || [],
    city_id: p.city_id, locality_id: p.locality_id, address: p.address, pincode: p.pincode,
    latitude: num(p.latitude), longitude: num(p.longitude),
    total_land_area: num(p.total_land_area), land_area_unit: str(p.land_area_unit),
    total_towers_buildings: num(p.total_towers_buildings), total_floors: num(p.total_floors),
    total_residential_units: num(p.total_residential_units), units_per_floor: num(p.units_per_floor),
    number_of_phases: num(p.number_of_phases), units_per_phase: num(p.units_per_phase),
    open_green_area_value: num(p.open_green_area_value), open_green_area_unit: str(p.open_green_area_unit),
    built_up_project_area: num(p.built_up_project_area), built_up_project_area_unit: str(p.built_up_project_area_unit),
    status: p.status, construction_stage: str(p.construction_stage), possession_status: str(p.possession_status),
    project_phase: str(p.project_phase), construction_start_date: str(p.construction_start_date),
    expected_completion_date: str(p.expected_completion_date), rera_possession_date: str(p.rera_possession_date),
    target_possession_date: str(p.target_possession_date),
    starting_price: priceRangeFromConfigs().min, maximum_price: priceRangeFromConfigs().max, price_on_request: !!p.price_on_request,
    base_price: num(p.base_price), floor_rise_charges: num(p.floor_rise_charges), parking_charges: num(p.parking_charges),
    clubhouse_charges: num(p.clubhouse_charges), maintenance_charges: num(p.maintenance_charges), other_charges: num(p.other_charges),
    gst_applicable: !!p.gst_applicable, price_disclaimer: str(p.price_disclaimer), registration_stamp_duty_disclaimer: str(p.registration_stamp_duty_disclaimer),
    flooring: str(p.flooring), doors: str(p.doors), windows: str(p.windows), kitchen: str(p.kitchen), bathroom: str(p.bathroom),
    electrical: str(p.electrical), walls_paint: str(p.walls_paint), balcony: str(p.balcony), other_specifications: str(p.other_specifications),
    agent_id: str(p.agent_id),
    seo_title: str(p.seo_title), seo_description: str(p.seo_description), canonical_url: str(p.canonical_url),
    updated_by: currentUser.id
  };
}

async function saveProjectCore() {
  const payload = projectPayload();
  const missingCore = ['project_name', 'developer_id', 'project_type', 'overview', 'city_id', 'locality_id', 'address', 'pincode', 'status']
    .filter(k => !payload[k]);
  if (missingCore.length) return { error: `Complete Basic Info, Location and Status steps first (missing: ${missingCore.join(', ')})` };

  if (!projectId) {
    payload.project_code = await ensureProjectCode();
    payload.slug = await ensureUniqueSlug(slugify(payload.project_name));
    payload.created_by = currentUser.id;
    payload.moderation_status = 'draft';
    const { data, error } = await sb.from('residential_projects').insert(payload).select('id,project_code,slug').single();
    if (error) return { error: error.message };
    projectId = data.id;
    state.project.slug = data.slug;
    await sb.from('residential_project_moderation_history').insert({ project_id: projectId, to_status: 'draft', action: 'created', changed_by: currentUser.id });
  } else {
    if (state.project.slug) payload.slug = await ensureUniqueSlug(slugify(state.project.slug));
    const { error } = await sb.from('residential_projects').update(payload).eq('id', projectId);
    if (error) return { error: error.message };
  }
  return { error: null };
}

async function replaceChildRows(table, rows) {
  await sb.from(table).delete().eq('project_id', projectId);
  if (!rows.length) return null;
  const { error } = await sb.from(table).insert(rows.map(({ _k, id, ...r }) => ({ ...r, project_id: projectId })));
  return error ? error.message : null;
}

async function persistStep(i) {
  // steps 1-4 (and the core-required set) must exist locally until step 4 completes; only then create the row
  if (i < FIRST_SAVE_AFTER_STEP) return true;

  const { error: coreErr } = await saveProjectCore();
  if (coreErr) { toast(coreErr, true); return false; }

  const num = v => (v === '' || v === null || v === undefined ? null : Number(v));
  try {
    if (i === 5) {
      const err = await replaceChildRows('residential_configurations', state.configurations.map((c, idx) => ({
        bhk_type: c.bhk_type, area_unit: c.area_unit,
        carpet_area: num(c.carpet_area), built_up_area: num(c.built_up_area), super_built_up_area: num(c.super_built_up_area),
        starting_price: num(c.starting_price), maximum_price: num(c.maximum_price), price_type: c.price_type,
        price_on_request: !!c.price_on_request, availability: c.availability, number_of_units: num(c.number_of_units),
        parking_included: c.parking_included, parking_type: c.parking_type?.length ? c.parking_type : null,
        description: c.description || null, display_order: idx
      })));
      if (err) throw new Error(err);
    } else if (i === 7) {
      const err = await replaceChildRows('residential_towers', state.towers.map((t, idx) => ({
        tower_name: t.tower_name, tower_number: t.tower_number || null, number_of_floors: num(t.number_of_floors),
        number_of_units: num(t.number_of_units), configurations: t.configurations || [], tower_status: t.tower_status,
        construction_stage: t.construction_stage || null, construction_start_date: t.construction_start_date || null,
        expected_completion_date: t.expected_completion_date || null, possession_status: t.possession_status || null,
        construction_details: t.construction_details || null, display_order: idx
      })));
      if (err) throw new Error(err);
    } else if (i === 8) {
      const err = await replaceChildRows('residential_amenities', state.amenities.map((a, idx) => ({
        category: a.category, amenity_type: a.amenity_type || a.amenity_name, amenity_name: a.amenity_name,
        description: a.description || null, is_available: a.is_available !== false, display_order: idx
      })));
      if (err) throw new Error(err);
    } else if (i === 9) {
      // location_type is NOT NULL in the database but optional in the UI — must default to
      // '' (not null) here, or the insert fails whenever a landmark's "Type" is left blank.
      const err = await replaceChildRows('residential_nearby_locations', state.nearby.map((n, idx) => ({
        category: n.category, location_type: n.location_type || '', name: n.name, distance: num(n.distance),
        distance_unit: n.distance_unit, description: n.description || null, display_order: idx
      })));
      if (err) throw new Error(err);
    } else if (i === 10) {
      const err = await replaceChildRows('residential_media', mediaRows());
      if (err) throw new Error(err);
    } else if (i === 11) {
      const err = await replaceChildRows('residential_project_pros_cons', state.prosCons.map((p, idx) => ({
        item_type: p.item_type, content: p.content, display_order: idx, created_by: currentUser.id
      })));
      if (err) throw new Error(err);
    } else if (i === 12) {
      const err = await replaceChildRows('residential_documents', state.documents.filter(d => d.file_path).map(d => ({
        document_type: d.document_type, title: d.title, file_path: d.file_path, file_url: d.file_url,
        visibility: d.visibility, description: d.description || null, uploaded_by: currentUser.id
      })));
      if (err) throw new Error(err);
    } else if (i === 13) {
      const err = await replaceChildRows('residential_litigation', state.litigation.map(l => ({
        status: l.status, case_title: l.case_title || null, court_tribunal: l.court_tribunal || null,
        case_type: l.case_type || null, filing_date: l.filing_date || null, current_status: l.current_status || null,
        case_description: l.case_description || null, supporting_document_path: l.supporting_document_path || null,
        supporting_document_url: l.supporting_document_url || null, created_by: currentUser.id
      })));
      if (err) throw new Error(err);
    } else if (i === 14) {
      await sb.from('residential_construction_updates').delete().eq('project_id', projectId);
      for (const u of state.updates) {
        const { data, error } = await sb.from('residential_construction_updates').insert({
          project_id: projectId, update_title: u.update_title, update_date: u.update_date,
          construction_stage: u.construction_stage || null, description: u.description || null,
          is_published: !!u.is_published, created_by: currentUser.id
        }).select('id').single();
        if (error) throw new Error(error.message);
        if (u.media?.length) {
          await sb.from('residential_construction_update_media').insert(u.media.map(m => ({ update_id: data.id, media_path: m.media_path, media_url: m.media_url })));
        }
      }
    } else if (i === 15) {
      const err = await replaceChildRows('residential_faqs', state.faqs.map((f, idx) => ({
        question: f.question, answer: f.answer, display_order: idx, is_published: f.is_published !== false, created_by: currentUser.id
      })));
      if (err) throw new Error(err);
    }
  } catch (e) {
    toast(e.message, true);
    return false;
  }
  return true;
}

function mediaRows() {
  const rows = [];
  if (state.media.main.media_path) rows.push({ media_type: 'main_image', media_path: state.media.main.media_path, media_url: state.media.main.media_url, is_primary: true });
  if (state.media.masterPlan.media_path) rows.push({ media_type: 'master_plan', media_path: state.media.masterPlan.media_path, media_url: state.media.masterPlan.media_url });
  state.media.gallery.forEach((g, i) => rows.push({ media_type: 'gallery', category: g.category || 'exterior', media_path: g.media_path, media_url: g.media_url, display_order: i }));
  state.media.videos.forEach((v, i) => rows.push({ media_type: v.media_type || 'video', platform: v.platform, title: v.title || null, media_url: v.media_url, display_order: i }));
  return rows;
}

async function saveCurrentAndDraft() {
  handleSpecialBindings();
  $('#pf-save-draft').disabled = true;
  try {
    const ok = await persistStep(Math.max(stepIndex, stepIndex < FIRST_SAVE_AFTER_STEP ? FIRST_SAVE_AFTER_STEP - 1 : stepIndex));
    if (stepIndex < FIRST_SAVE_AFTER_STEP) {
      toast('Fill Basic Info, Location and Status & Construction to save — kept locally for now.');
    } else if (ok !== false) {
      const { error } = await saveProjectCore();
      if (error) toast(error, true);
      else { toast('Saved as draft'); renderStepBody(); }
    }
  } finally {
    $('#pf-save-draft').disabled = false;
  }
}

async function submitForVerification() {
  $('#pf-next').disabled = true;
  try {
    for (let i = FIRST_SAVE_AFTER_STEP; i <= 15; i++) {
      const ok = await persistStep(i);
      if (!ok) return;
    }
    const { error } = await sb.from('residential_projects').update({
      moderation_status: 'pending_verification', submitted_at: new Date().toISOString(), updated_by: currentUser.id
    }).eq('id', projectId);
    if (error) { toast(error.message, true); return; }
    await sb.from('residential_project_moderation_history').insert({
      project_id: projectId, from_status: 'draft', to_status: 'pending_verification', action: 'submitted', changed_by: currentUser.id
    });
    toast('Submitted for verification');
    setTimeout(() => closeForm(), 600);
  } finally {
    $('#pf-next').disabled = false;
  }
}

// Used after a successful submit — exits immediately (no confirm) and unwinds every
// history entry the wizard pushed in one go, so the back button lands on whatever page
// was open before the wizard, not back inside the now-submitted form.
function closeForm() {
  if (!historyPushCount) {
    content.removeEventListener('input', onFieldInput);
    content.removeEventListener('change', onFieldChange);
    content.removeEventListener('click', onFieldClick);
    wizardOpen = false;
    onExit?.();
    return;
  }
  intentionalExit = true;
  history.go(-historyPushCount);
}

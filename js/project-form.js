import { sb } from './supabase-client.js';
import { toast, fmtPriceWords } from './utils.js';
import { enhanceSelects } from './custom-select.js';
import { PROJECT_KINDS } from './project-kinds.js';

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
// The active project kind's config (KINDS.residential / KINDS.commercial, below) — set by
// openProjectForm(); everything kind-specific (tables, buckets, fields, presets) reads it.
let K;
let state, projectId, stepIndex, isEdit;
// The project's moderation_status as it was when the wizard opened for an edit (null for a
// brand-new project) — lets submitForVerification() tell an edit of an already-published
// listing apart from a first-time submission, so saving changes to a live listing doesn't
// knock it back into the moderation queue (see submitForVerification()).
let originalModerationStatus = null;
let lookups = { developers: [], cities: [], localities: [], agents: [], relationshipManagers: [], projects: [], presets: null, settings: null };
let touched = false;
let historyPushCount = 0;
let intentionalExit = false;

// In-flight/failed upload state, keyed by a slot id ('media.main', 'documents.2', …).
// Kept outside `state` since it's session-only UI state, never sent to Supabase.
let uploads = {};

// Mirrors the actual Supabase Storage bucket config (file_size_limit / allowed_mime_types)
// so bad files are rejected instantly client-side instead of round-tripping to the server.
const UPLOAD_LIMITS = {
  'residential-media': {
    maxBytes: 10 * 1024 * 1024,
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'],
    label: 'JPG, PNG, WEBP, AVIF or GIF · up to 10MB'
  },
  'residential-documents': {
    maxBytes: 20 * 1024 * 1024,
    mimeTypes: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
    label: 'PDF, JPG, PNG or WEBP · up to 20MB'
  }
};
UPLOAD_LIMITS['commercial-media'] = UPLOAD_LIMITS['residential-media'];
UPLOAD_LIMITS['commercial-documents'] = UPLOAD_LIMITS['residential-documents'];

function fmtBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

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
  'Agent and relationship manager assigned to this project.',
  'Search engine metadata for the public project page.',
  'Review every section before saving as draft or submitting for verification.'
];
// Both kinds share the same 18-step skeleton (only each step's content differs), so step
// numbers mean the same thing everywhere below.
const TOTAL_STEPS = STEP_NAMES.length;
// index into which core-save happens on "Next" (after this step, the project row can be created)
const FIRST_SAVE_AFTER_STEP = 4;

/* ============ shared enum option lists (avoid re-declaring the same DB check-constraint values per step) ============ */

// Must match the DB's residential_towers_construction_stage_check / residential_construction_updates_construction_stage_check constraints (still used by Towers and Construction Updates steps).
const CONSTRUCTION_STAGE_OPTIONS = enumOpts(['pre_launch', 'excavation', 'foundation', 'structure', 'brickwork', 'finishing', 'final_completion', 'ready_to_move', 'other']);
// Must match the DB's residential_projects_possession_status_check constraint exactly.
const POSSESSION_STATUS_OPTIONS = enumOpts(['new_launch', 'under_construction', 'nearing_possession', 'possession_started', 'ready_to_move', 'completed']);
const AREA_UNIT_OPTIONS = enumOpts(['sq_ft', 'sq_m']);
// Project-level built-up area can be quoted in acres for large projects — kept separate
// from AREA_UNIT_OPTIONS since that one's also used for per-configuration carpet/built-up
// area (a single apartment's area), where acres never makes sense.
const PROJECT_AREA_UNIT_OPTIONS = enumOpts(['sq_ft', 'sq_m', 'acre']);

/* ============ field defs (map 1:1 to residential_projects columns) ============ */

const FIELDS = {
  basic: [
    { key: 'developer_id', label: 'Developer / Builder', req: true, type: 'select', options: () => lookups.developers.map(d => ({ value: d.id, label: d.name })), quickAdd: 'developer' },
    // Options depend on the selected developer (same dependent-select pattern as
    // city_id → locality_id below): pick one of that developer's existing projects to open
    // it for editing, or use "+ New" to type a brand-new project name. allowCustomValue
    // keeps a freshly typed name visible/selected even though it has no matching <option>
    // yet (it only becomes a real project row once this wizard is saved).
    { key: 'project_name', label: 'Project Name', req: true, type: 'select', allowCustomValue: true, forceSearch: true,
      options: () => lookups.projects.filter(p => p.developer_id === state.project.developer_id).map(p => ({ value: p.project_name, label: p.project_name })),
      hint: 'Pick an existing project of this developer to edit it, or use "+ New" to add one.',
      quickAdd: 'project_name' },
    { key: 'project_type', label: 'Project Type', req: true, type: 'select', options: enumOpts(['apartment', 'villa', 'row_house', 'townhouse', 'residential_plot', 'independent_house', 'mixed_residential', 'other']) },
    { key: 'launch_date', label: 'Project Launch Date', type: 'date' },
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
    { key: 'total_floors', label: 'Total Floors', type: 'text', placeholder: 'e.g. 18 or G+12' },
    { key: 'total_residential_units', label: 'Total Residential Units', type: 'number' },
    { key: 'number_of_phases', label: 'Number of Phases', type: 'number' },
    { key: 'open_green_area_value', label: 'Open / Green Area', type: 'number' },
    { key: 'open_green_area_unit', label: 'Open / Green Area Unit', type: 'select', options: enumOpts(['acre', 'sq_ft', 'sq_m', 'percent']) },
    { key: 'built_up_project_area', label: 'Built-up Project Area', type: 'number' },
    { key: 'built_up_project_area_unit', label: 'Built-up Area Unit', type: 'select', options: PROJECT_AREA_UNIT_OPTIONS }
  ],
  status: [
    { key: 'status', label: 'Project Status', req: true, type: 'select', options: enumOpts(['upcoming', 'new_launch', 'under_construction', 'nearing_possession', 'ready_to_move', 'completed', 'resale']) }
  ],
  specs: [
    { key: 'flooring', label: 'Flooring', type: 'textarea', full: true },
    { key: 'doors', label: 'Doors', type: 'textarea', full: true },
    { key: 'windows', label: 'Windows', type: 'textarea', full: true },
    { key: 'kitchen', label: 'Kitchen', type: 'textarea', full: true },
    { key: 'bathroom', label: 'Bathroom', type: 'textarea', full: true },
    { key: 'electrical', label: 'Electrical', type: 'textarea', full: true },
    { key: 'walls_paint', label: 'Walls / Paint', type: 'textarea', full: true },
    { key: 'balcony', label: 'Balcony', type: 'textarea', full: true },
    { key: 'other_specifications', label: 'Other Specifications', type: 'textarea', full: true }
  ],
  contact: [
    { key: 'agent_id', label: 'Assigned Agent', type: 'select', options: () => lookups.agents.map(a => ({ value: a.id, label: a.full_name })), full: true, quickAdd: 'agent', hint: 'Leads for this project will be routed to this agent' },
    { key: 'relationship_manager_id', label: 'Relationship Manager', type: 'select', options: () => lookups.relationshipManagers.map(r => ({ value: r.id, label: `${r.full_name} (${r.rm_code})` })), full: true, quickAdd: 'relationship_manager', hint: 'Internal team member responsible for this project relationship' }
  ],
  seo: [
    { key: 'slug', label: 'URL Slug', req: true, full: true },
    { key: 'seo_title', label: 'SEO Title', full: true },
    { key: 'seo_description', label: 'SEO Description', type: 'textarea', full: true },
    { key: 'canonical_url', label: 'Canonical URL', full: true }
  ]
};

// Common, real-estate-listing-standard phrasing for each Apartment Specifications field —
// shown as toggleable preset chips above the free-text textarea so most projects can be
// filled without typing, while the textarea still accepts anything custom.
const SPEC_PRESETS = {
  flooring: ['Vitrified Tiles', 'Italian Marble', 'Wooden Flooring', 'Granite', 'Anti-Skid Tiles (Bathroom/Balcony)', 'Ceramic Tiles'],
  doors: ['Flush Doors', 'Laminated Doors', 'Teak Wood Frame', 'Engineered Wood Doors', 'Fire-Rated Main Door', 'Digital Door Lock Provision'],
  windows: ['UPVC Windows', 'Powder-Coated Aluminium Windows', 'Sliding Windows', 'Glass Windows with Mosquito Mesh', 'Bay Windows'],
  kitchen: ['Granite Platform', 'Stainless Steel Sink', 'Modular Kitchen Ready', 'Provision for Water Purifier', 'Exhaust Fan Provision', 'Dado Tiling up to Lintel'],
  bathroom: ['Anti-Skid Ceramic Tiles', 'Premium CP Sanitary Fittings', 'Hot & Cold Water Provision', 'Exhaust Fan Provision', 'Concealed Plumbing', 'Glass Partition / Shower Cubicle'],
  electrical: ['Concealed Copper Wiring', 'Modular Switches', 'MCB Distribution Box', 'TV & AC Points in Every Room', 'Adequate Power Backup Points', 'Video Door Phone Provision'],
  walls_paint: ['Premium Emulsion Paint (Interior)', 'Weatherproof Exterior Paint', 'Textured Accent Wall Finish', 'Putty Finish Walls', 'Oil Bound Distemper'],
  balcony: ['MS/Glass Railing', 'Weatherproof Vitrified Tiles', 'Utility / Wash Area', 'Sit-out Balcony', 'Planter Box Provision']
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
  configuration: () => ({ _k: uid(), bhk_type: '1 BHK', area_unit: 'sq_ft', carpet_area: '', built_up_area: '', super_built_up_area: '', starting_price: '', maximum_price: '', price_type: 'total_price', price_on_request: false, availability: 'available', number_of_units: '', parking_included: 'not_available', parking_type: [], description: '' }),
  tower: () => ({ _k: uid(), tower_name: '', number_of_floors: '', number_of_units: '', configurations: [], tower_status: 'under_construction', construction_stage: '', construction_start_date: '', expected_completion_date: '', possession_status: '', construction_details: '' }),
  amenity: (category, name) => ({ _k: uid(), category, amenity_name: name, amenity_type: name, description: '', is_available: true }),
  nearby: () => ({ _k: uid(), category: 'transport', location_type: '', name: '', distance: '', distance_unit: 'km', description: '' }),
  prosCons: (item_type) => ({ _k: uid(), item_type, content: '' }),
  document: () => ({ _k: uid(), document_type: 'rera_certificate', title: '', visibility: 'public', description: '', file_path: null, file_url: null, file_name: null }),
  litigation: () => ({ _k: uid(), status: 'no_known_litigation', case_title: '', court_tribunal: '', case_type: '', filing_date: '', current_status: '', case_description: '', supporting_document_path: null, supporting_document_url: null, supporting_document_name: null }),
  update: () => ({ _k: uid(), update_title: '', update_date: '', construction_stage: '', description: '', is_published: true, media: [] }),
  faq: () => ({ _k: uid(), question: '', answer: '', is_published: true }),
  galleryItem: () => ({ _k: uid(), category: 'exterior', title: '', image_path: null, image_url: null }),
  video: () => ({ _k: uid(), media_type: 'video', platform: 'youtube', title: '', media_url: '' }),
  phase: () => ({ _k: uid(), phase_name: '', construction_start_date: '', expected_completion_date: '', rera_possession_date: '', target_possession_date: '', units_per_phase: '', configurations: [] })
};

const BHK_PRESET = ['1 BHK', '1.5 BHK', '2 BHK', '2.5 BHK', '3 BHK', '3.5 BHK', '4 BHK', '4.5 BHK', '5 BHK'];

// The preset chips/options below are editable from Settings → Lookup Lists (lookup_options
// table). The hardcoded constants above stay as the fallback: a list falls back to them
// whenever lookup_options couldn't be read or has no active rows for it, so the form never
// ends up with an empty picker.
function presetList(listKey, groupKey, fallback) {
  const rows = lookups.presets?.[`${listKey}:${groupKey || ''}`];
  return rows?.length ? rows : (fallback || []);
}
const bhkPresets = () => presetList('bhk', null, BHK_PRESET);
const specPresets = key => SPEC_PRESETS[key] ? presetList('spec', key, SPEC_PRESETS[key]) : null;
const amenityPresets = cat => presetList('amenity', cat.key, cat.preset);

const PHASE_FIELDS = [
  { key: 'phase_name', label: 'Phase Name', req: true, placeholder: 'e.g. Phase 1' },
  { key: 'construction_start_date', label: 'Construction Start Date', type: 'date' },
  { key: 'expected_completion_date', label: 'Expected Completion Date', type: 'date' },
  { key: 'rera_possession_date', label: 'RERA Possession Date', type: 'date' },
  { key: 'target_possession_date', label: 'Target Possession Date', type: 'date' },
  { key: 'units_per_phase', label: 'Units per Phase', type: 'number' }
];

function freshState() {
  return {
    project: K.freshProject(),
    configurations: [], towers: [], amenities: [], nearby: [], prosCons: [], documents: [], litigation: [], updates: [], faqs: [], phases: [],
    media: { main: {}, masterPlan: {}, gallery: [], videos: [] }
  };
}

function freshResidentialProject() {
  return {
      project_name: '', developer_id: '', project_type: 'apartment', launch_date: '', rera_numbers: [], overview: '', highlights: [],
      city_id: '', locality_id: '', address: '', pincode: '', latitude: '', longitude: '',
      total_land_area: '', land_area_unit: 'acre', total_towers_buildings: '', total_floors: '', total_residential_units: '', number_of_phases: '', open_green_area_value: '', open_green_area_unit: 'acre', built_up_project_area: '', built_up_project_area_unit: 'sq_ft',
      status: 'upcoming',
      starting_price: '', maximum_price: '', price_on_request: false, base_price: '', floor_rise_charges: '', parking_charges: '', clubhouse_charges: '', maintenance_charges: '', other_charges: '', gst_applicable: false, price_disclaimer: '', registration_stamp_duty_disclaimer: '',
      flooring: '', doors: '', windows: '', kitchen: '', bathroom: '', electrical: '', walls_paint: '', balcony: '', other_specifications: '',
      agent_id: '', relationship_manager_id: '',
      slug: '', seo_title: '', seo_description: '', canonical_url: ''
  };
}

/* ============ entry point ============ */

let wizardOpen = false;

// prefill: optional values to seed a brand-new project with (e.g. { developer_id } when
// opened from the Developers page's "Add Project" action) — ignored when editing an
// existing project, which already has its own saved values.
export async function openProjectForm(rootEl, user, existingId, exitCb, prefill, kind = 'residential') {
  K = KINDS[kind] || KINDS.residential;
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
  uploads = {};
  originalModerationStatus = null;

  content.innerHTML = `<div class="empty">Loading project form…</div>`;
  await loadLookups();

  if (isEdit) {
    state = await loadProject(existingId);
    if (!state) { content.innerHTML = `<div class="empty">Project not found.</div>`; return; }
  } else {
    state = freshState();
    if (lookups.settings?.default_city_id && lookups.cities.some(c => c.id === lookups.settings.default_city_id)) {
      state.project.city_id = lookups.settings.default_city_id;
    }
    if (prefill) Object.assign(state.project, prefill);
  }

  renderShell();
  // Gives the wizard its own URL (#/residential/edit/<id> or #/residential/add) instead of
  // silently reusing whatever page opened it — otherwise a refresh had nothing in the URL to
  // tell the boot sequence a wizard was open at all, and it fell through to the Residential
  // Projects list (or further still, to Dashboard). See app.js's boot sequence, which parses
  // this same shape back out to reopen the wizard.
  pushWizardState(existingId ? `#/${K.routeBase}/edit/${existingId}` : `#/${K.routeBase}/add`);
}

// Every step change (Next, stepper/Edit jump) pushes one browser history entry, so the
// phone/browser back button steps back through the wizard one step at a time — and, once
// past the first step, exits the wizard back to whichever page opened it (also via back).
// `hash` is only passed by the initial open (see openProjectForm/showSubmitSuccess above) to
// stamp the wizard's own URL; every later call just keeps whatever hash is already active.
function pushWizardState(hash) {
  historyPushCount++;
  history.pushState({ pfWizard: true, step: stepIndex }, '', hash || location.hash);
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
  const [dev, city, loc, agt, rm, proj, opts, settings] = await Promise.all([
    sb.from('developers').select('id,name').order('name'),
    sb.from('cities').select('id,name').order('name'),
    sb.from('localities').select('id,name,city_id').order('name'),
    sb.from('agents').select('id,full_name').order('full_name'),
    sb.from('relationship_managers').select('id,full_name,rm_code').eq('status', 'active').order('full_name'),
    sb.from(K.tables.project).select('id,project_name,developer_id').is('deleted_at', null).order('project_name'),
    sb.from('lookup_options').select('list_key,group_key,label').eq('is_active', true).order('sort_order').order('label'),
    sb.from('app_settings').select('default_city_id').eq('id', 1).maybeSingle()
  ]);
  lookups.developers = dev.data || [];
  lookups.cities = city.data || [];
  lookups.localities = loc.data || [];
  lookups.agents = agt.data || [];
  lookups.relationshipManagers = rm.data || [];
  lookups.projects = proj.data || [];
  lookups.presets = {};
  for (const o of opts.data || []) (lookups.presets[`${o.list_key}:${o.group_key || ''}`] ||= []).push(o.label);
  lookups.settings = settings.data || null;
}

async function loadProject(id) {
  const s = freshState();
  const T = K.tables;
  const { data: p, error } = await sb.from(T.project).select('*').eq('id', id).single();
  if (error || !p) { console.error(error); return null; }
  Object.keys(s.project).forEach(k => { if (k in p && p[k] !== null) s.project[k] = p[k]; });
  s.project.highlights = p.highlights || [];
  s.project.rera_numbers = p.rera_numbers || [];
  originalModerationStatus = p.moderation_status || null;

  const [phases, cfg, tow, ame, near, pc, docs, lit, upd, faqs] = await Promise.all([
    sb.from(T.phases).select('*').eq('project_id', id).order('display_order'),
    sb.from(T.units).select('*').eq('project_id', id).order('display_order'),
    sb.from(T.towers).select('*').eq('project_id', id).order('display_order'),
    sb.from(T.amenities).select('*').eq('project_id', id).order('display_order'),
    sb.from(T.nearby).select('*').eq('project_id', id).order('display_order'),
    sb.from(T.prosCons).select('*').eq('project_id', id).order('display_order'),
    sb.from(T.documents).select('*').eq('project_id', id),
    sb.from(T.litigation).select('*').eq('project_id', id),
    sb.from(T.updates).select(`*,${T.updateMedia}(*)`).eq('project_id', id).order('display_order'),
    sb.from(T.faqs).select('*').eq('project_id', id).order('display_order')
  ]);
  s.phases = (phases.data || []).map(r => ({ ...r, _k: r.id, configurations: r.configurations || [] }));
  s.configurations = (cfg.data || []).map(r => ({ ...r, _k: r.id, parking_type: r.parking_type || [] }));
  s.towers = (tow.data || []).map(r => ({ ...r, _k: r.id, configurations: r.configurations || [] }));
  s.amenities = (ame.data || []).map(r => ({ ...r, _k: r.id }));
  s.nearby = (near.data || []).map(r => ({ ...r, _k: r.id }));
  s.prosCons = (pc.data || []).map(r => ({ ...r, _k: r.id }));
  s.documents = (docs.data || []).map(r => ({ ...r, _k: r.id, file_name: (r.file_path || '').split('/').pop() }));
  s.litigation = (lit.data || []).map(r => ({ ...r, _k: r.id, supporting_document_name: (r.supporting_document_path || '').split('/').pop() }));
  s.updates = (upd.data || []).map(r => ({ ...r, _k: r.id, media: (r[T.updateMedia] || []).map(m => ({ ...m, _k: m.id })) }));
  s.faqs = (faqs.data || []).map(r => ({ ...r, _k: r.id }));

  const { data: media } = await sb.from(T.media).select('*').eq('project_id', id);
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
        <div><h1>${isEdit ? 'Edit' : 'Add'} ${K.label} Project</h1><p id="pf-step-label">Step ${stepIndex} of ${TOTAL_STEPS} · ${K.stepNames[stepIndex - 1]}</p></div>
      </div>
      <div class="form-head-right">
        <button class="btn-ghost" id="pf-save-draft">${isEdit ? 'Update' : 'Save as Draft'}</button>
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
  const html = K.stepNames.map((name, i) => {
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
  $('#pf-step-label').textContent = `Step ${stepIndex} of ${TOTAL_STEPS} · ${K.stepNames[stepIndex - 1]}`;
  $('#pf-panel-head').innerHTML = `<h2>${esc(K.stepNames[stepIndex - 1])}</h2><p>${esc(K.stepSub[stepIndex - 1])}</p>`;
  $('#pf-panel-body').innerHTML = renderBody(stepIndex);
  $('#pf-footer-label').textContent = `${pct}% complete`;
  $('#pf-back').disabled = stepIndex === 1;
  $('#pf-next').textContent = stepIndex === TOTAL_STEPS
    ? (originalModerationStatus === 'published' ? 'Update Project' : 'Submit for Verification →')
    : `Next: ${K.stepNames[stepIndex] || ''} →`;
  $('#pf-close').title = stepIndex > 1 ? 'Back' : 'Close';
  handleSpecialBindings();
  // No scrollTo here on purpose — renderStepBody() is also called for in-place updates on
  // the current step (toggling an amenity chip, adding/removing a repeat-card row, an
  // upload finishing, etc.), and jumping the page to the top on every one of those was the
  // "page moves up when clicking amenities" bug. Only an actual step change should scroll;
  // see goNext(), gotoStep() and handleWizardPopState() below, which call it explicitly.
}

/* ============ generic field rendering ============ */

function renderField(spec, value, attr, item) {
  const req = spec.req ? '<span class="req">*</span>' : '';
  const hint = spec.hint ? `<span class="hint">${esc(spec.hint)}</span>` : '';
  const fullCls = (spec.full ? ' full' : '') + (spec.quickAdd ? ' field-quickadd-wrap' : '');
  const placeholder = typeof spec.placeholder === 'function' ? spec.placeholder(item) : spec.placeholder;
  if (spec.type === 'checkbox') {
    return `<div class="field${fullCls}"><label style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" ${attr} ${value ? 'checked' : ''} style="width:16px;height:16px;accent-color:var(--green)"> ${esc(spec.label)}</label>${hint}</div>`;
  }
  let input;
  if (spec.type === 'select') {
    let opts = typeof spec.options === 'function' ? spec.options(item) : spec.options;
    // A value set via "+ New" (free text) has no matching <option> yet — show it selected
    // anyway instead of silently falling back to the blank placeholder.
    if (spec.allowCustomValue && value && !opts.some(o => String(o.value) === String(value))) {
      opts = [{ value, label: value }, ...opts];
    }
    input = `<select ${attr}${spec.forceSearch ? ' data-force-search' : ''}><option value="">Select…</option>${opts.map(o => `<option value="${esc(o.value)}"${String(value ?? '') === String(o.value) ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
    if (spec.quickAdd) input = `<div class="field-quickadd">${input}<button type="button" class="btn-outline" style="padding:8px 10px;white-space:nowrap" data-quickadd="${spec.quickAdd}">+ New</button></div>`;
  } else if (spec.type === 'textarea') {
    input = `<textarea ${attr} placeholder="${esc(placeholder || '')}">${esc(value ?? '')}</textarea>`;
  } else if (spec.unit) {
    const unitLabel = typeof spec.unit === 'function' ? spec.unit(item) : spec.unit;
    input = `<div class="field-suffix"><input ${attr} type="${spec.type || 'text'}" value="${value == null ? '' : esc(String(value))}" placeholder="${esc(placeholder || '')}"><span>${esc(unitLabel)}</span></div>`;
  } else {
    input = `<input ${attr} type="${spec.type || 'text'}" value="${value == null ? '' : esc(String(value))}" placeholder="${esc(placeholder || '')}">`;
  }
  // Spells the typed amount out in words right under the input (e.g. "₹ Twenty Five Lakh"),
  // kept in sync live by onFieldInput() without a full re-render so typing doesn't lose focus.
  const words = spec.showWords ? (() => {
    const bindPath = (attr.match(/data-bind="([^"]+)"/) || [])[1] || '';
    return `<div class="price-words" data-words-for="${esc(bindPath)}">${esc(fmtPriceWords(value))}</div>`;
  })() : '';
  const label = spec.label ? `<label>${esc(spec.label)} ${req}</label>` : '';
  return `<div class="field${fullCls}">${label}${input}${words}${hint}</div>`;
}

function renderFieldsGrid(specs, values, bindPrefix) {
  return `<div class="form-grid">${specs.map(s => renderField(s, values[s.key], `data-bind="${bindPrefix}.${s.key}"`, values)).join('')}</div>`;
}

// A number field with its unit select attached directly to its right edge, as one compact
// control, instead of the value and unit sitting as two separate fields in the grid.
function renderFieldWithUnit(valueSpec, unitSpec, values, bindPrefix) {
  const value = values[valueSpec.key];
  const unitValue = values[unitSpec.key];
  const opts = typeof unitSpec.options === 'function' ? unitSpec.options() : unitSpec.options;
  const input = `<input data-bind="${bindPrefix}.${valueSpec.key}" type="number" value="${value == null ? '' : esc(String(value))}" placeholder="${esc(valueSpec.placeholder || '')}">`;
  const select = `<select data-bind="${bindPrefix}.${unitSpec.key}">${opts.map(o => `<option value="${esc(o.value)}"${String(unitValue ?? '') === String(o.value) ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
  return `<div class="field"><label>${esc(valueSpec.label)}</label><div class="field-unit-group">${input}${select}</div></div>`;
}

// Size & Scale's own layout: area fields pair with their unit right next to them instead of
// as a separate grid cell.
function renderSizeScale() {
  const f = Object.fromEntries(K.fields.size.map(s => [s.key, s]));
  const p = state.project;
  const plain = (key) => renderField(f[key], p[key], `data-bind="project.${key}"`, p);
  return `<div class="form-grid size-scale-grid">
    ${renderFieldWithUnit(f.total_land_area, f.land_area_unit, p, 'project')}
    ${renderFieldWithUnit(f.open_green_area_value, f.open_green_area_unit, p, 'project')}
    ${renderFieldWithUnit(f.built_up_project_area, f.built_up_project_area_unit, p, 'project')}
    ${K.sizePlainKeys.map(plain).join('')}
  </div>`;
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
  const wordsEl = content.querySelector(`[data-words-for="${CSS.escape(el.dataset.bind)}"]`);
  if (wordsEl) wordsEl.textContent = fmtPriceWords(getPath(state, el.dataset.bind));
}
function onFieldChange(e) {
  const el = e.target.closest('[data-bind]');
  if (!el) return;
  if (el.dataset.bind === 'project.developer_id') {
    applyBind(el);
    state.project.project_name = '';
    renderStepBody();
  } else if (el.dataset.bind === 'project.project_name') {
    const prevName = state.project.project_name;
    applyBind(el);
    // Picking one of this developer's existing projects (rather than a freshly typed name)
    // switches the whole wizard over to editing that project instead of continuing to build
    // a separate one under the same name.
    const match = lookups.projects.find(p => p.developer_id === state.project.developer_id && p.project_name === el.value);
    if (match && match.id !== projectId) {
      if (touched && !confirm(`Open "${match.project_name}" for editing? Unsaved changes on this step will be lost.`)) {
        state.project.project_name = prevName;
        renderStepBody();
        return;
      }
      openProjectForm(content, currentUser, match.id, onExit, undefined, K.key);
      return;
    }
  }
  else if (el.dataset.bind === 'project.city_id') { applyBind(el); state.project.locality_id = ''; renderStepBody(); }
  else if (/^nearby\.\d+\.category$/.test(el.dataset.bind)) { applyBind(el); renderStepBody(); }
  // Built-up/Super Built-up Area show the selected unit (sq ft / sq m) as their suffix —
  // re-render so switching Area Unit updates those labels, not just Carpet Area's own select.
  else if (/^configurations\.\d+\.area_unit$/.test(el.dataset.bind) || el.dataset.bind === 'project.area_unit') { applyBind(el); renderStepBody(); }
  else applyBind(el);
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
  if (upload) { removeUploadedFile(upload.dataset.removeUpload); return; }
}

// Removes an uploaded file's reference from state (and best-effort deletes it from Storage)
// for either shape of upload key used across the form:
//  - "media.main" / "media.masterPlan" name the media row object itself, whose fields are
//    media_path/media_url/file_name/file_size.
//  - "documents.0.file" / "litigation.0.supporting_document" name a field *prefix* on a flat
//    item object, whose fields are <prefix>_path/_url/_name/_size.
// These used to be handled by one blind `key + '_path'` setPath() for both shapes — that's
// correct for the second shape (it targets the item's own <prefix>_path field) but wrong for
// the first (it wrote a stray "main_path" property onto `state.media` instead of touching
// `state.media.main.media_path`), so the Main Image / Master Plan "✕" silently did nothing.
function removeUploadedFile(key) {
  let bucket, path;
  if (key.startsWith('media.')) {
    const row = getPath(state, key) || {};
    bucket = K.buckets.media;
    path = row.media_path;
    row.media_path = null; row.media_url = null; row.file_name = null; row.file_size = null;
  } else {
    bucket = K.buckets.docs;
    path = getPath(state, key + '_path');
    setPath(state, key + '_path', null);
    setPath(state, key + '_url', null);
    setPath(state, key + '_name', null);
    setPath(state, key + '_size', null);
  }
  deleteStorageFile(bucket, path);
  touched = true;
  renderStepBody();
}

function addRepeatItem(key, arg) {
  touched = true;
  const arr = getPath(state, key) || [];
  let item;
  if (key === 'amenities') item = DEFAULTS.amenity(arg, '');
  else if (key === 'prosCons') item = DEFAULTS.prosCons(arg);
  else {
    const factoryName = key.endsWith('s') ? key.slice(0, -1) : key;
    if (key === 'configurations') { arr.push(K.newUnit()); setPath(state, key, arr); renderStepBody(); return; }
    const map = { configurations: 'configuration', towers: 'tower', nearby: 'nearby', documents: 'document', litigation: 'litigation', updates: 'update', faqs: 'faq', phases: 'phase', 'media.videos': 'video' };
    item = DEFAULTS[map[key] || factoryName] ? DEFAULTS[map[key] || factoryName]() : { _k: uid() };
  }
  arr.push(item);
  setPath(state, key, arr);
  renderStepBody();
}
function removeRepeatItem(key, idx) {
  touched = true;
  const arr = getPath(state, key) || [];
  const item = arr[idx];
  // Deleting the whole row (not just clearing its upload slot) still needs to release
  // whatever file it holds, or every removed Document/Litigation entry and Construction
  // Update photo leaks in Storage the same way a bare "✕" on the upload slot used to.
  if (item) {
    if (key === 'documents' && item.file_path) deleteStorageFile(K.buckets.docs, item.file_path);
    else if (key === 'litigation' && item.supporting_document_path) deleteStorageFile(K.buckets.docs, item.supporting_document_path);
    else if (key === 'updates' && item.media?.length) item.media.forEach(m => deleteStorageFile(K.buckets.media, m.media_path));
  }
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
  } else if (kind === 'project_name') {
    if (!state.project.developer_id) { toast('Select a developer first', true); return; }
    const name = prompt('New project name:');
    if (!name) return;
    state.project.project_name = name;
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
  } else if (kind === 'relationship_manager') {
    const name = prompt('New relationship manager full name:');
    if (!name) return;
    // rm_code (K99-###AAA) is generated by a DB trigger — never set from here.
    const { data, error } = await sb.from('relationship_managers').insert({ full_name: name }).select('id,full_name,rm_code').single();
    if (error) { toast(error.message, true); return; }
    lookups.relationshipManagers.push(data);
    state.project.relationship_manager_id = data.id;
    renderStepBody();
    toast(`Added as ${data.rm_code}`);
  }
}

/* ============ step body renderers ============ */

function renderBody(i) {
  switch (i) {
    case 1: return renderBasic();
    case 2: return renderFieldsGrid(K.fields.location, state.project, 'project');
    case 3: return renderSizeScale();
    case 4: return renderFieldsGrid(K.fields.status, state.project, 'project') + `<h4 style="margin:20px 0 10px">Project Phases</h4>` + renderPhases();
    case 5: return K.renderUnits();
    case 6: return renderSpecs();
    case 7: return renderTowers();
    case 8: return renderAmenities();
    case 9: return renderNearby();
    case 10: return renderMedia();
    case 11: return renderProsCons();
    case 12: return renderDocuments();
    case 13: return renderLitigation();
    case 14: return renderUpdates();
    case 15: return renderFaqs();
    case 16: return renderFieldsGrid(K.fields.contact, state.project, 'project');
    case 17: return renderSeo();
    case 18: return renderReview();
    default: return '';
  }
}

function renderBasic() {
  const specs = K.fields.basic.filter(s => s.key !== 'overview');
  const overview = K.fields.basic.find(s => s.key === 'overview');
  return `<div class="form-grid">${specs.map(s => renderField(s, state.project[s.key], `data-bind="project.${s.key}"`)).join('')}
    ${chipRowHtml('RERA Number(s)', 'Add one or more RERA registration numbers — e.g. one per phase or tower.', state.project.rera_numbers, 'project.rera_numbers', 'pf-rera-input')}
    ${renderField(overview, state.project.overview, `data-bind="project.overview"`)}
    ${chipRowHtml('Project Highlights', 'Short, factual highlights — separate from Pros & Cons', state.project.highlights, 'project.highlights', 'pf-highlight-input')}
    <div class="field full"><div class="hint">Project Status, RERA Possession Date and Target Possession Date are set together in "Status &amp; Construction" — kept in one place so they can't fall out of sync.</div></div>
  </div>`;
}

// Project-level starting/maximum price shown on the public listing card — derived from the
// BHK configurations added in Step 5 rather than typed in separately (there's no dedicated
// pricing step; see projectPayload()).
function priceRangeFromConfigs() {
  // A commercial unit priced as monthly rent isn't a sale price — keep it out of the
  // project's sale price range (its rent is shown separately via expected_rent).
  const priced = state.configurations.filter(c => c.price_type !== 'monthly_rent');
  const starts = priced.map(c => Number(c.starting_price)).filter(n => n > 0);
  const maxes = priced.map(c => Number(c.maximum_price || c.starting_price)).filter(n => n > 0);
  if (!starts.length) return { min: null, max: null };
  return { min: Math.min(...starts), max: maxes.length ? Math.max(...maxes) : Math.min(...starts) };
}

// A Maximum Price typed lower than that same card's Starting Price (e.g. a missing digit —
// 7,50,000 instead of 7,50,00,000) doesn't just look wrong on the card: the project-level
// price range derived from every configuration's lowest start / highest max (see
// priceRangeFromConfigs() and projectPayload()) ends up inverted (min > max), which the DB
// rejects with a bare "violates check constraint residential_projects_price_range_chk" on
// save. Called from both the Next button and Save as Draft, since either can trigger a save.
function validateConfigPriceRange() {
  const badIdx = state.configurations.findIndex(c =>
    c.maximum_price !== '' && c.maximum_price !== null && c.maximum_price !== undefined &&
    Number(c.maximum_price) < Number(c.starting_price));
  return badIdx >= 0 ? `Maximum Price must be greater than or equal to Starting Price (${K.unitSingular} #${badIdx + 1})` : null;
}

function renderSeo() {
  if (!state.project.slug) state.project.slug = slugify([state.project.project_name, lookups.localities.find(l => l.id === state.project.locality_id)?.name, lookups.cities.find(c => c.id === state.project.city_id)?.name].filter(Boolean).join('-'));
  return `<div class="form-grid">${K.fields.seo.map(s => renderField(s, state.project[s.key], `data-bind="project.${s.key}"`)).join('')}
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
    // customRender fields (e.g. configurations' bhk_type chip picker) are validated like any
    // other field but drawn by extraHtml instead of the generic input/select/textarea markup.
    const fieldsHtml = fields.filter(s => !s.customRender).map(s => renderField(s, item[s.key], `data-bind="${key}.${i}.${s.key}"`, item)).join('');
    const before = opts.extraHtmlBefore ? opts.extraHtmlBefore(item, i) : '';
    const extra = opts.extraHtml ? opts.extraHtml(item, i) : '';
    const title = (opts.titleOf && opts.titleOf(item, i)) || `${opts.singular} ${i + 1}`;
    return repeatCard(title, i, `<div class="form-grid">${before}${fieldsHtml}${extra}</div>`, key);
  }).join('');
  return `<div class="repeat-list">${list || `<div class="empty">${esc(opts.emptyText)}</div>`}</div>
    <button type="button" class="add-repeat" data-add-item="${key}">+ ${esc(opts.addLabel)}</button>`;
}

function areaUnitLabel(u) {
  return { sq_ft: 'sq ft', sq_m: 'sq m' }[u] || u || '';
}

// Same preset-chip + custom-chip picker as bhkChipsHtml, but single-select: a configuration
// has exactly one bhk_type, not a list, so clicking a chip replaces the value instead of
// toggling membership.
function bhkTypeChipsHtml(value, idx) {
  const val = value || '';
  const presets = K.unitPresets();
  const presetChips = presets.map(v => `<span class="chip${val === v ? ' active' : ''}" data-set-bhktype="${idx}" data-val="${esc(v)}" style="cursor:pointer">${esc(v)}</span>`).join('');
  const customChip = val && !presets.includes(val) ? `<span class="chip active">${esc(val)}</span>` : '';
  const inputId = `pf-cfg-bhk-${idx}`;
  return `<div class="field full">
    <label>${esc(K.unitLabel)} <span class="req">*</span></label>
    <div class="chip-row">${presetChips}${customChip}
    <input type="text" id="${inputId}" placeholder="${esc(K.unitCustomPlaceholder)}" style="border:1px solid #d5dfde;border-radius:20px;padding:7px 12px;font-size:12px;width:140px">
    <span class="chip chip-add" data-set-bhktype-custom="${idx}" data-input="${inputId}">+ Set</span></div>
  </div>`;
}

const CONFIG_FIELDS = [
  { key: 'bhk_type', label: 'BHK', req: true, customRender: true },
  // area_unit is rendered attached to Carpet Area's right edge (see extraHtmlBefore below),
  // not as its own field — customRender keeps it out of the generic field grid.
  { key: 'area_unit', label: 'Area Unit', type: 'select', options: AREA_UNIT_OPTIONS, customRender: true },
  { key: 'carpet_area', label: 'Carpet Area', type: 'number', customRender: true },
  { key: 'built_up_area', label: 'Built-up Area', type: 'number', unit: c => areaUnitLabel(c?.area_unit) },
  { key: 'super_built_up_area', label: 'Super Built-up Area', type: 'number', unit: c => areaUnitLabel(c?.area_unit) },
  { key: 'starting_price', label: 'Starting Price', type: 'number', unit: '₹', req: true, showWords: true },
  { key: 'maximum_price', label: 'Maximum Price', type: 'number', unit: '₹', showWords: true },
  { key: 'price_type', label: 'Price Type', type: 'select', options: enumOpts(['total_price', 'price_per_sq_ft', 'price_per_sq_m']) },
  { key: 'availability', label: 'Availability', type: 'select', options: enumOpts(['available', 'sold_out', 'on_request']) },
  { key: 'number_of_units', label: 'Number of Units', type: 'number', placeholder: 'e.g. 24' },
  { key: 'parking_included', label: 'Parking', type: 'select', options: enumOpts(['included', 'additional', 'not_available']) }
];
const CONFIG_FIELDS_BY_KEY = Object.fromEntries(CONFIG_FIELDS.map(s => [s.key, s]));
function renderConfigurations() {
  return renderRepeatStep('configurations', CONFIG_FIELDS, {
    singular: 'BHK Configuration', emptyText: 'No configurations added yet.', addLabel: 'Add BHK Configuration',
    // Same BHK type can repeat across cards with a different carpet/built-up area (e.g. two
    // "2 BHK" variants at 850 and 950 sq ft) — each is its own record, so the title has to
    // show the area alongside the BHK type or the cards are indistinguishable at a glance.
    titleOf: (c, i) => c.bhk_type
      ? `${c.bhk_type}${c.carpet_area ? ` · ${c.carpet_area} ${areaUnitLabel(c.area_unit)}` : ''}`
      : `BHK Configuration ${i + 1}`,
    extraHtmlBefore: (c, i) => bhkTypeChipsHtml(c.bhk_type, i)
      + renderFieldWithUnit(CONFIG_FIELDS_BY_KEY.carpet_area, CONFIG_FIELDS_BY_KEY.area_unit, c, `configurations.${i}`),
    extraHtml: (c, i) => {
      const parkTypes = ['covered', 'open', 'mechanical', 'ev', 'other'];
      const parkChips = parkTypes.map(t => `<span class="chip${(c.parking_type || []).includes(t) ? ' active' : ''}" data-toggle-parktype="${i}" data-val="${t}" style="cursor:pointer">${esc(t)}</span>`).join('');
      return `<div class="field full"><label>Parking Type</label><div class="chip-row">${parkChips}</div></div>`;
    }
  });
}

const TOWER_FIELDS = [
  { key: 'tower_name', label: 'Tower Name', req: true, placeholder: 'e.g. Tower A' },
  { key: 'number_of_floors', label: 'Number of Floors', type: 'number' },
  { key: 'number_of_units', label: 'Number of Units', type: 'number' },
  { key: 'tower_status', label: 'Tower Status', type: 'select', options: enumOpts(['upcoming', 'under_construction', 'ready_to_move', 'completed', 'other']) },
  { key: 'construction_stage', label: 'Construction Stage', type: 'select', options: CONSTRUCTION_STAGE_OPTIONS },
  { key: 'possession_status', label: 'Possession Status', type: 'select', options: POSSESSION_STATUS_OPTIONS },
  { key: 'construction_start_date', label: 'RERA Possession Date', type: 'date' },
  { key: 'expected_completion_date', label: 'Builder Possession Date', type: 'date' },
  { key: 'construction_details', label: 'Construction Details', type: 'textarea', full: true }
];
function renderTowers() {
  return renderRepeatStep('towers', TOWER_FIELDS, {
    titleOf: t => t.tower_name, singular: 'Tower', emptyText: 'No towers added yet.', addLabel: 'Add Tower / Building',
    extraHtml: (t, i) => bhkChipsHtml(t.configurations, `towers.${i}.configurations`, i)
  });
}

function bhkChipsHtml(values, bindPath, idx) {
  const vals = values || [];
  const presets = K.unitPresets();
  const presetChips = presets.map(v => {
    const on = vals.includes(v);
    return `<span class="chip${on ? ' active' : ''}" data-toggle-bhk="${bindPath}" data-val="${esc(v)}" style="cursor:pointer">${esc(v)}</span>`;
  }).join('');
  const customVals = vals.filter(v => !presets.includes(v));
  const customChips = customVals.map(v => {
    const i = vals.indexOf(v);
    return `<span class="chip active">${esc(v)}<span style="cursor:pointer;margin-left:6px" data-remove-chip="${bindPath}" data-idx="${i}">✕</span></span>`;
  }).join('');
  const inputId = `pf-phase-bhk-${idx}`;
  return `<div class="field full">
    <label>${esc(K.chipLabel)}</label>
    <div class="chip-row">${presetChips}${customChips}
    <input type="text" id="${inputId}" placeholder="${esc(K.unitCustomPlaceholder)}" style="border:1px solid #d5dfde;border-radius:20px;padding:7px 12px;font-size:12px;width:140px">
    <span class="chip chip-add" data-add-chip="${bindPath}" data-input="${inputId}">+ Add</span></div>
  </div>`;
}

function renderPhases() {
  return renderRepeatStep('phases', PHASE_FIELDS, {
    titleOf: p => p.phase_name, singular: 'Phase', emptyText: 'No phases added yet.', addLabel: 'Add Phase',
    extraHtml: (p, i) => bhkChipsHtml(p.configurations, `phases.${i}.configurations`, i)
  });
}

// Splits a spec field's comma-joined string back into its selected preset/custom tokens.
function specTokens(value) {
  return String(value || '').split(',').map(t => t.trim()).filter(Boolean);
}

function toggleSpecChip(field, value) {
  const tokens = specTokens(state.project[field]);
  const idx = tokens.indexOf(value);
  if (idx >= 0) tokens.splice(idx, 1); else tokens.push(value);
  state.project[field] = tokens.join(', ');
}

function renderSpecs() {
  const fields = K.fields.specs.map(s => {
    const preset = K.specPresets(s.key);
    if (!preset) return renderField(s, state.project[s.key], `data-bind="project.${s.key}"`);
    const selected = specTokens(state.project[s.key]);
    const chips = preset.map(v => `<span class="chip${selected.includes(v) ? ' active' : ''}" data-toggle-spec-chip="${s.key}" data-val="${esc(v)}" style="cursor:pointer">${esc(v)}</span>`).join('');
    return `<div class="field full">
      <label>${esc(s.label)}</label>
      <span class="hint">Tap to select one or more, or type your own below.</span>
      <div class="chip-row">${chips}</div>
      <textarea data-bind="project.${s.key}" placeholder="Additional notes…">${esc(state.project[s.key] ?? '')}</textarea>
    </div>`;
  }).join('');
  return `<div class="form-grid">${fields}</div>`;
}

function renderAmenities() {
  const sections = K.amenityCategories.map(cat => {
    const existing = state.amenities.filter(a => a.category === cat.key);
    const preset = K.amenityPresets(cat);
    const presetChips = preset.map(name => {
      const on = existing.some(a => a.amenity_name === name);
      return `<span class="chip${on ? ' active' : ''}" data-toggle-amenity="${cat.key}" data-name="${esc(name)}" style="cursor:pointer">${esc(name)}</span>`;
    }).join('');
    const customExtra = existing.filter(a => !preset.includes(a.amenity_name));
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

// Per-category examples so the Type/Name placeholders guide the admin toward what's
// actually expected for the selected nearby-location category, instead of a generic
// "Metro Station" example showing up for a hospital or mall entry.
const NEARBY_CATEGORY_EXAMPLES = {
  transport: { type: 'Metro Station', name: 'Baner Metro Station' },
  education: { type: 'School', name: 'Delhi Public School' },
  healthcare: { type: 'Hospital', name: 'Ruby Hall Clinic' },
  shopping_retail: { type: 'Mall', name: 'Phoenix Marketcity' },
  business_employment: { type: 'IT Park', name: 'Hinjewadi IT Park' },
  lifestyle_entertainment: { type: 'Multiplex', name: 'PVR Cinemas' }
};
// Preset "Type" options per nearby-location category — transport gets the full list asked
// for; the other categories get a sensible starter list too so the dropdown behaves the same
// way everywhere, but allowCustomValue (below) means none of this is a hard enum — typing
// something not on the list is still fine and saved as-is.
const NEARBY_TYPE_PRESETS = {
  transport: ['Metro Station', 'Railway Station', 'Bus Stop', 'Airport', 'Highway / Expressway Access'],
  education: ['School', 'College', 'University', 'Coaching Institute'],
  healthcare: ['Hospital', 'Clinic', 'Diagnostic Center', 'Pharmacy'],
  shopping_retail: ['Mall', 'Supermarket', 'Market / Bazaar', 'Showroom'],
  business_employment: ['IT Park', 'Business Park', 'Corporate Office', 'SEZ'],
  lifestyle_entertainment: ['Multiplex / Cinema', 'Restaurant / Cafe', 'Club / Lounge', 'Park / Garden']
};

/* ============ commercial-only content (same 18 steps, commercial fields/presets) ============ */

// Must match the DB's commercial_projects_project_type_check constraint exactly.
const COMMERCIAL_PROJECT_TYPES = enumOpts(['office', 'shop', 'showroom', 'warehouse', 'industrial', 'healthcare', 'education', 'hospitality', 'commercial_land', 'commercial_building']);
const TRANSACTION_TYPE_OPTIONS = enumOpts(['sale', 'lease', 'sale_and_lease']);

const COMMERCIAL_FIELDS = {
  basic: [
    FIELDS.basic.find(s => s.key === 'developer_id'),
    FIELDS.basic.find(s => s.key === 'project_name'),
    { key: 'project_type', label: 'Property Type', req: true, type: 'select', options: COMMERCIAL_PROJECT_TYPES },
    { key: 'transaction_type', label: 'Available For', req: true, type: 'select', options: TRANSACTION_TYPE_OPTIONS },
    FIELDS.basic.find(s => s.key === 'launch_date'),
    FIELDS.basic.find(s => s.key === 'overview')
  ],
  location: FIELDS.location,
  size: [
    ...FIELDS.size.filter(s => s.key !== 'total_residential_units'),
    { key: 'total_commercial_units', label: 'Total Commercial Units', type: 'number' },
    { key: 'area_unit', label: 'Leasable / Saleable Area Unit', type: 'select', options: AREA_UNIT_OPTIONS },
    { key: 'total_leasable_area', label: 'Total Leasable Area', type: 'number', unit: p => areaUnitLabel(p?.area_unit) },
    { key: 'total_saleable_area', label: 'Total Saleable Area', type: 'number', unit: p => areaUnitLabel(p?.area_unit) },
    { key: 'typical_floor_plate', label: 'Typical Floor Plate', type: 'number', unit: p => areaUnitLabel(p?.area_unit), hint: 'Usable area of one typical floor' }
  ],
  status: [
    FIELDS.status[0],
    { key: 'occupancy_certificate', label: 'Occupancy Certificate (OC)', type: 'select', options: enumOpts(['received', 'applied', 'not_applied']) }
  ],
  // Project-level commercial terms, shown above the unit cards on Step 5.
  pricing: [
    { key: 'price_on_request', label: 'Price on request (hide prices on the listing)', type: 'checkbox', full: true },
    { key: 'maintenance_charges', label: 'Maintenance / CAM Charges', type: 'number', unit: '₹/sq ft/mo' },
    { key: 'security_deposit_months', label: 'Security Deposit', type: 'number', unit: 'months' },
    { key: 'lock_in_period_months', label: 'Lock-in Period', type: 'number', unit: 'months' },
    { key: 'rent_escalation_percent', label: 'Rent Escalation', type: 'number', unit: '% / yr' },
    { key: 'gst_applicable', label: 'GST applicable', type: 'checkbox' },
    { key: 'price_disclaimer', label: 'Price Disclaimer', type: 'textarea', full: true }
  ],
  specs: [
    { key: 'structure', label: 'Structure', type: 'textarea', full: true },
    { key: 'flooring', label: 'Flooring', type: 'textarea', full: true },
    { key: 'facade_glazing', label: 'Facade / Glazing', type: 'textarea', full: true },
    { key: 'lifts_elevators', label: 'Lifts / Elevators', type: 'textarea', full: true },
    { key: 'hvac', label: 'HVAC / Air Conditioning', type: 'textarea', full: true },
    { key: 'power_load_backup', label: 'Power Load & Backup', type: 'textarea', full: true },
    { key: 'fire_safety', label: 'Fire Safety', type: 'textarea', full: true },
    { key: 'washrooms_pantry', label: 'Washrooms & Pantry', type: 'textarea', full: true },
    { key: 'loading_docks', label: 'Loading Docks (warehouse / industrial)', type: 'textarea', full: true },
    { key: 'floor_to_ceiling_height', label: 'Floor-to-Ceiling Height', placeholder: 'e.g. 3.6 m slab-to-slab', full: true },
    { key: 'other_specifications', label: 'Other Specifications', type: 'textarea', full: true }
  ],
  contact: FIELDS.contact,
  seo: FIELDS.seo
};

const COMMERCIAL_SPEC_PRESETS = {
  structure: ['RCC Framed Structure', 'Earthquake Resistant (Zone Compliant)', 'Pre-Engineered Building (PEB)', 'Steel Structure'],
  flooring: ['Vitrified Tiles', 'Granite', 'Italian Marble', 'Raised Access Flooring', 'Epoxy / Industrial Flooring', 'FM2 / Trimix Flooring'],
  facade_glazing: ['Double Glazed Glass Facade', 'ACP Cladding', 'Structural Glazing', 'Stone Cladding'],
  lifts_elevators: ['High-Speed Passenger Lifts', 'Service Lift', 'Goods Lift', 'Escalators', 'Destination Control System'],
  hvac: ['Central Air Conditioning (VRF/VRV)', 'Chilled Water System', 'Provision for Split AC', 'Fresh Air Handling Units'],
  power_load_backup: ['100% Power Backup', 'DG Backup for Common Areas', 'Dedicated Transformer', 'High Power Load Provision'],
  fire_safety: ['Sprinkler System', 'Fire Alarm & Detection', 'Fire Hydrants', 'Pressurised Staircases', 'Fire NOC Obtained'],
  washrooms_pantry: ['Private Washroom', 'Common Washrooms on Each Floor', 'Pantry Provision', 'Dry Pantry'],
  loading_docks: ['Dock Levellers', 'Loading / Unloading Bays', 'Truck Turning Radius', 'Clear Height 9m+']
};

// Must match the DB's commercial_amenities_category_check constraint exactly.
const COMMERCIAL_AMENITY_CATEGORIES = [
  { key: 'business_facilities', label: 'Business Facilities', preset: ['Conference Rooms', 'Business Lounge', 'Reception / Concierge', 'Meeting Pods'] },
  { key: 'food_beverage', label: 'Food & Beverage', preset: ['Food Court', 'Cafeteria', 'Restaurant', 'Vending Area'] },
  { key: 'security_safety', label: 'Security & Safety', preset: ['24x7 Security', 'CCTV Surveillance', 'Access Control', 'Boom Barriers'] },
  { key: 'parking_mobility', label: 'Parking & Mobility', preset: ['Multi-level Parking', 'Visitor Parking', 'EV Charging', 'Valet Parking'] },
  { key: 'power_utilities', label: 'Power & Utilities', preset: ['Power Backup', 'Dedicated Transformer', 'Water Treatment Plant', 'STP'] },
  { key: 'building_services', label: 'Building Services', preset: ['High-Speed Elevators', 'Central AC', 'Building Management System', 'Housekeeping'] },
  { key: 'connectivity_it', label: 'Connectivity & IT', preset: ['High-Speed Fibre', 'Multiple ISP Ready', 'Server / Data Room', 'Wi-Fi in Common Areas'] },
  { key: 'wellness_lifestyle', label: 'Wellness & Lifestyle', preset: ['Gymnasium', 'Creche', 'Landscaped Terrace', 'Breakout Zones'] },
  { key: 'logistics', label: 'Logistics', preset: ['Loading Bays', 'Dock Levellers', 'Truck Parking', 'Wide Internal Roads'] },
  { key: 'eco_friendly', label: 'Eco-Friendly Features', preset: ['LEED / IGBC Certified', 'Solar Panels', 'Rainwater Harvesting', 'EV Charging Points'] }
];

const COMMERCIAL_UNIT_PRESET = ['Office Space', 'Shop', 'Showroom', 'Warehouse', 'Industrial Shed', 'Clinic / Medical Space', 'Institute / Classroom', 'Hotel Room / Serviced Unit', 'Food Court / F&B Unit', 'Co-working Seat', 'Commercial Floor', 'Whole Building', 'Commercial Plot'];

// The editable preset lists, as Settings → Lookup Lists shows them. The group keys are fixed
// here (they're the DB's category/field values); only the items inside each group live in
// lookup_options.
export const LOOKUP_LISTS = [
  { key: 'bhk', label: 'BHK Types', groups: null },
  { key: 'spec', label: 'Specifications', groups: FIELDS.specs.filter(s => SPEC_PRESETS[s.key]).map(s => ({ key: s.key, label: s.label })) },
  { key: 'amenity', label: 'Amenities', groups: AMENITY_CATEGORIES.map(c => ({ key: c.key, label: c.label })) },
  { key: 'nearby_type', label: 'Nearby Location Types', groups: enumOpts(Object.keys(NEARBY_TYPE_PRESETS)).map(o => ({ key: o.value, label: o.label })) },
  { key: 'commercial_unit', label: 'Commercial Unit Types', groups: null },
  { key: 'commercial_spec', label: 'Commercial Specifications', groups: COMMERCIAL_FIELDS.specs.filter(s => COMMERCIAL_SPEC_PRESETS[s.key]).map(s => ({ key: s.key, label: s.label })) },
  { key: 'commercial_amenity', label: 'Commercial Amenities', groups: COMMERCIAL_AMENITY_CATEGORIES.map(c => ({ key: c.key, label: c.label })) }
];
const NEARBY_FIELDS = [
  { key: 'category', label: 'Category', req: true, type: 'select', options: NEARBY_CATEGORIES },
  { key: 'location_type', label: 'Type', type: 'select', allowCustomValue: true,
    options: n => presetList('nearby_type', n?.category, NEARBY_TYPE_PRESETS[n?.category]).map(v => ({ value: v, label: v })) },
  { key: 'name', label: 'Name', req: true, placeholder: n => `e.g. ${(NEARBY_CATEGORY_EXAMPLES[n?.category]?.name) || 'Baner Metro Station'}` },
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
      const media = (u.media || []).map(m => `<div class="upload-thumb"><span class="name">${esc(m.file_name || m.media_path?.split('/').pop() || 'photo')}${m.file_size ? ` · ${fmtBytes(m.file_size)}` : ''}</span></div>`).join('');
      const input = `<input type="file" accept="image/*" data-update-upload="${i}">`;
      const uploadHtml = !projectId ? `<div class="hint">Save the project first to attach photos.</div>`
        : renderUploadSlot(`updates.${i}`, input) || `<label class="upload-box">📷 Add site photo${input}<span class="hint">${esc(UPLOAD_LIMITS[K.buckets.media].label)}</span></label>`;
      return `<div class="field full">${uploadHtml}${media}</div>`;
    }
  });
}

const DOC_FIELDS = [
  { key: 'document_type', label: 'Document Type', req: true, type: 'select', options: () => K.docTypes },
  { key: 'title', label: 'Title', req: true },
  { key: 'visibility', label: 'Visibility', type: 'select', options: enumOpts(['public', 'restricted', 'internal']) },
  { key: 'description', label: 'Description', type: 'textarea', full: true }
];
function renderDocuments() {
  return renderRepeatStep('documents', DOC_FIELDS, {
    titleOf: d => d.title, singular: 'Document', emptyText: 'No documents added yet.', addLabel: 'Add Document',
    extraHtml: (d, i) => {
      const input = `<input type="file" data-doc-upload="${i}">`;
      const uploadHtml = d.file_name
        ? `<div class="upload-thumb"><span class="name">${esc(d.file_name)}${d.file_size ? ` · ${fmtBytes(d.file_size)}` : ''}</span><button type="button" data-remove-upload="documents.${i}.file">✕</button></div>`
        : !projectId ? `<div class="hint">Save the project first (through Status &amp; Construction) to upload files.</div>`
        : renderUploadSlot(`documents.${i}`, input) || `<label class="upload-box">📄 Click to upload file${input}<span class="hint">${esc(UPLOAD_LIMITS[K.buckets.docs].label)}</span></label>`;
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
      const input = `<input type="file" data-lit-upload="${i}">`;
      const uploadHtml = l.supporting_document_name
        ? `<div class="upload-thumb"><span class="name">${esc(l.supporting_document_name)}${l.supporting_document_size ? ` · ${fmtBytes(l.supporting_document_size)}` : ''}</span><button type="button" data-remove-upload="litigation.${i}.supporting_document">✕</button></div>`
        : !projectId ? `<div class="hint">Save the project first to attach a document.</div>`
        : renderUploadSlot(`litigation.${i}`, input) || `<label class="upload-box">📄 Attach supporting document${input}<span class="hint">${esc(UPLOAD_LIMITS[K.buckets.docs].label)}</span></label>`;
      return `<div class="field full">${uploadHtml}</div>`;
    }
  });
}

// Must match the DB's residential_media_category_check constraint exactly.
const GALLERY_CATEGORIES = enumOpts(['exterior', 'interior', 'hall', 'bedroom', 'kitchen', 'bathroom', 'dining_hall', 'puja_room', 'balcony', 'clubhouse', 'amenities', 'landscape', 'parking', 'other']);
// Must match the DB's commercial_media_category_check constraint exactly.
const COMMERCIAL_GALLERY_CATEGORIES = enumOpts(['exterior', 'facade', 'lobby', 'reception', 'office_space', 'retail_floor', 'showroom', 'warehouse_interior', 'common_area', 'amenities', 'landscape', 'parking', 'other']);
// Must match each kind's <kind>_documents_document_type_check constraint exactly.
const RESIDENTIAL_DOC_TYPES = enumOpts(['rera_certificate', 'project_brochure', 'price_sheet', 'floor_plan_pdf', 'approvals', 'noc', 'other']);
const COMMERCIAL_DOC_TYPES = enumOpts(['rera_certificate', 'project_brochure', 'price_sheet', 'floor_plan_pdf', 'approvals', 'noc', 'occupancy_certificate', 'fire_noc', 'environmental_clearance', 'lease_terms', 'other']);

/* ============ commercial units (Step 5) ============ */

const COMMERCIAL_UNIT_FIELDS = [
  { key: 'unit_type', label: 'Unit Type', req: true, customRender: true },
  { key: 'area_unit', label: 'Area Unit', type: 'select', options: AREA_UNIT_OPTIONS, customRender: true },
  { key: 'carpet_area', label: 'Carpet Area', type: 'number', customRender: true },
  { key: 'variant_name', label: 'Unit / Variant Name', placeholder: 'e.g. Ground floor retail' },
  { key: 'floor_level', label: 'Floor / Level', placeholder: 'e.g. G+1 or 5th–8th' },
  { key: 'transaction_type', label: 'Available For', type: 'select', options: TRANSACTION_TYPE_OPTIONS },
  { key: 'built_up_area', label: 'Built-up Area', type: 'number', unit: c => areaUnitLabel(c?.area_unit) },
  { key: 'super_built_up_area', label: 'Super Built-up Area', type: 'number', unit: c => areaUnitLabel(c?.area_unit) },
  { key: 'starting_price', label: 'Starting Price (Sale)', type: 'number', unit: '₹', showWords: true },
  { key: 'maximum_price', label: 'Maximum Price (Sale)', type: 'number', unit: '₹', showWords: true },
  { key: 'price_type', label: 'Price Type', type: 'select', options: enumOpts(['total_price', 'price_per_sq_ft', 'price_per_sq_m', 'monthly_rent']) },
  { key: 'expected_rent', label: 'Expected Rent', type: 'number', unit: '₹/month', showWords: true },
  { key: 'availability', label: 'Availability', type: 'select', options: enumOpts(['available', 'sold_out', 'leased_out', 'on_request']) },
  { key: 'number_of_units', label: 'Number of Units', type: 'number', placeholder: 'e.g. 12' },
  { key: 'furnishing', label: 'Furnishing', type: 'select', options: enumOpts(['bare_shell', 'warm_shell', 'semi_furnished', 'fully_furnished', 'plug_and_play']) },
  { key: 'washroom', label: 'Washroom', type: 'select', options: enumOpts(['private', 'common', 'none']) },
  { key: 'parking_included', label: 'Parking', type: 'select', options: enumOpts(['included', 'additional', 'not_available']) },
  { key: 'pantry', label: 'Pantry inside unit', type: 'checkbox' },
  { key: 'description', label: 'Description', type: 'textarea', full: true }
];

function newCommercialUnit() {
  return { _k: uid(), unit_type: 'Office Space', variant_name: '', floor_level: '', transaction_type: state.project.transaction_type || 'sale', area_unit: 'sq_ft', carpet_area: '', built_up_area: '', super_built_up_area: '', starting_price: '', maximum_price: '', price_type: 'total_price', expected_rent: '', price_on_request: false, availability: 'available', number_of_units: '', furnishing: '', washroom: '', pantry: false, parking_included: 'not_available', parking_type: [], description: '' };
}

function renderCommercialUnits() {
  const terms = renderFieldsGrid(COMMERCIAL_FIELDS.pricing, state.project, 'project');
  const units = renderRepeatStep('configurations', COMMERCIAL_UNIT_FIELDS, {
    singular: 'Unit', emptyText: 'No units added yet.', addLabel: 'Add Unit',
    titleOf: (c, i) => c.unit_type
      ? `${c.unit_type}${c.variant_name ? ` · ${c.variant_name}` : ''}${c.carpet_area ? ` · ${c.carpet_area} ${areaUnitLabel(c.area_unit)}` : ''}`
      : `Unit ${i + 1}`,
    extraHtmlBefore: (c, i) => bhkTypeChipsHtml(c.unit_type, i)
      + renderFieldWithUnit(CONFIG_FIELDS_BY_KEY.carpet_area, CONFIG_FIELDS_BY_KEY.area_unit, c, `configurations.${i}`),
    extraHtml: (c, i) => {
      const parkTypes = ['covered', 'open', 'mechanical', 'ev', 'other'];
      const parkChips = parkTypes.map(t => `<span class="chip${(c.parking_type || []).includes(t) ? ' active' : ''}" data-toggle-parktype="${i}" data-val="${t}" style="cursor:pointer">${esc(t)}</span>`).join('');
      return `<div class="field full"><label>Parking Type</label><div class="chip-row">${parkChips}</div></div>`;
    }
  });
  return `<h4 style="margin:0 0 10px">Pricing &amp; Lease Terms</h4>${terms}<h4 style="margin:24px 0 10px">Units</h4>${units}`;
}

function residentialUnitRow(c, idx) {
  return {
    bhk_type: c.bhk_type, area_unit: c.area_unit,
    carpet_area: num(c.carpet_area), built_up_area: num(c.built_up_area), super_built_up_area: num(c.super_built_up_area),
    starting_price: num(c.starting_price), maximum_price: num(c.maximum_price), price_type: c.price_type,
    price_on_request: !!c.price_on_request, availability: c.availability, number_of_units: num(c.number_of_units),
    parking_included: c.parking_included, parking_type: c.parking_type?.length ? c.parking_type : null,
    description: c.description || null, display_order: idx
  };
}

function commercialUnitRow(c, idx) {
  return {
    unit_type: c.unit_type, variant_name: str(c.variant_name ?? ''), floor_level: str(c.floor_level ?? ''),
    transaction_type: c.transaction_type || 'sale', area_unit: c.area_unit || 'sq_ft',
    carpet_area: num(c.carpet_area), built_up_area: num(c.built_up_area), super_built_up_area: num(c.super_built_up_area),
    starting_price: num(c.starting_price), maximum_price: num(c.maximum_price), price_type: c.price_type || 'total_price',
    expected_rent: num(c.expected_rent), price_on_request: !!c.price_on_request, availability: c.availability || 'available',
    number_of_units: num(c.number_of_units), furnishing: str(c.furnishing ?? ''), washroom: str(c.washroom ?? ''), pantry: !!c.pantry,
    parking_included: c.parking_included || 'not_available', parking_type: c.parking_type?.length ? c.parking_type : null,
    description: c.description || null, display_order: idx
  };
}

function freshCommercialProject() {
  return {
    project_name: '', developer_id: '', project_type: 'office', transaction_type: 'sale', launch_date: '', rera_numbers: [], overview: '', highlights: [],
    city_id: '', locality_id: '', address: '', pincode: '', latitude: '', longitude: '',
    total_land_area: '', land_area_unit: 'acre', total_towers_buildings: '', total_floors: '', total_commercial_units: '', number_of_phases: '',
    open_green_area_value: '', open_green_area_unit: 'acre', built_up_project_area: '', built_up_project_area_unit: 'sq_ft',
    area_unit: 'sq_ft', total_leasable_area: '', total_saleable_area: '', typical_floor_plate: '',
    status: 'upcoming', occupancy_certificate: '',
    price_on_request: false, maintenance_charges: '', security_deposit_months: '', lock_in_period_months: '', rent_escalation_percent: '', gst_applicable: false, price_disclaimer: '',
    structure: '', flooring: '', facade_glazing: '', lifts_elevators: '', hvac: '', power_load_backup: '', fire_safety: '',
    floor_to_ceiling_height: '', washrooms_pantry: '', loading_docks: '', other_specifications: '',
    agent_id: '', relationship_manager_id: '',
    slug: '', seo_title: '', seo_description: '', canonical_url: ''
  };
}

function commercialPayload(p) {
  const range = priceRangeFromConfigs();
  return {
    project_name: p.project_name, developer_id: p.developer_id, project_type: p.project_type, transaction_type: p.transaction_type || 'sale',
    launch_date: str(p.launch_date), rera_numbers: p.rera_numbers || [], rera_number: str((p.rera_numbers || [])[0] || null), overview: p.overview, highlights: p.highlights || [],
    city_id: p.city_id, locality_id: p.locality_id, address: p.address, pincode: p.pincode,
    latitude: num(p.latitude), longitude: num(p.longitude),
    total_land_area: num(p.total_land_area), land_area_unit: str(p.land_area_unit),
    total_towers_buildings: num(p.total_towers_buildings), total_floors: str(p.total_floors),
    total_commercial_units: num(p.total_commercial_units), number_of_phases: num(p.number_of_phases),
    open_green_area_value: num(p.open_green_area_value), open_green_area_unit: str(p.open_green_area_unit),
    built_up_project_area: num(p.built_up_project_area), built_up_project_area_unit: str(p.built_up_project_area_unit),
    area_unit: p.area_unit || 'sq_ft', total_leasable_area: num(p.total_leasable_area), total_saleable_area: num(p.total_saleable_area), typical_floor_plate: num(p.typical_floor_plate),
    status: p.status, occupancy_certificate: str(p.occupancy_certificate),
    starting_price: range.min, maximum_price: range.max, price_on_request: !!p.price_on_request, price_disclaimer: str(p.price_disclaimer),
    maintenance_charges: num(p.maintenance_charges), security_deposit_months: num(p.security_deposit_months),
    lock_in_period_months: num(p.lock_in_period_months), rent_escalation_percent: num(p.rent_escalation_percent), gst_applicable: !!p.gst_applicable,
    structure: str(p.structure), flooring: str(p.flooring), facade_glazing: str(p.facade_glazing), lifts_elevators: str(p.lifts_elevators),
    hvac: str(p.hvac), power_load_backup: str(p.power_load_backup), fire_safety: str(p.fire_safety), floor_to_ceiling_height: str(p.floor_to_ceiling_height),
    washrooms_pantry: str(p.washrooms_pantry), loading_docks: str(p.loading_docks), other_specifications: str(p.other_specifications),
    agent_id: str(p.agent_id), relationship_manager_id: str(p.relationship_manager_id),
    seo_title: str(p.seo_title), seo_description: str(p.seo_description), canonical_url: str(p.canonical_url)
  };
}

/* ============ kind configs ============ */

const KINDS = {
  residential: {
    ...PROJECT_KINDS.residential,
    stepNames: STEP_NAMES, stepSub: STEP_SUB, fields: FIELDS,
    sizePlainKeys: ['total_towers_buildings', 'total_floors', 'total_residential_units', 'number_of_phases'],
    unitKey: 'bhk_type', unitLabel: 'BHK', unitSingular: 'BHK Configuration', chipLabel: 'Configuration', unitCustomPlaceholder: 'Custom BHK…',
    unitFields: CONFIG_FIELDS, unitPresets: bhkPresets, newUnit: () => DEFAULTS.configuration(), unitRow: residentialUnitRow, renderUnits: renderConfigurations,
    specPresets, amenityPresets, amenityCategories: AMENITY_CATEGORIES,
    galleryCategories: GALLERY_CATEGORIES, docTypes: RESIDENTIAL_DOC_TYPES,
    freshProject: freshResidentialProject, payload: residentialPayload
  },
  commercial: {
    ...PROJECT_KINDS.commercial,
    stepNames: [
      'Basic Information', 'Project Location', 'Size & Scale', 'Status & Construction',
      'Commercial Units & Pricing', 'Building Specifications', 'Tower / Building Details',
      'Amenities & Features', 'Nearby Locations', 'Project Media', 'Pros & Cons',
      'Project Documents', 'Litigation & Legal', 'Construction Updates', 'Project FAQ',
      'Contact / Enquiry', 'SEO', 'Review & Submit'
    ],
    stepSub: [
      'Core identity of the property — type, whether it is for sale or lease, and its overview.',
      'Where the project is located.',
      'Land, buildings, floors, leasable/saleable area and unit count.',
      'Construction progress, occupancy certificate and phase timelines.',
      'Lease terms for the whole project, then one record per unit type / size on offer.',
      'Structure, facade, HVAC, power, fire safety and other building specifications.',
      'Add one record per tower/building/block in the project.',
      'Group amenities by category — check the ones available, or add custom ones.',
      'Points of interest around the project, grouped by category.',
      'Main image, gallery, master plan, videos and reels.',
      'Short, factual pros and cons for the public listing.',
      'RERA, occupancy certificate, fire NOC, lease terms and other documents.',
      'Legal/litigation disclosure for the project.',
      'Dated construction progress updates with optional photos.',
      'Frequently asked questions shown on the public listing.',
      'Agent and relationship manager assigned to this project.',
      'Search engine metadata for the public project page.',
      'Review every section before saving as draft or submitting for verification.'
    ],
    fields: COMMERCIAL_FIELDS,
    sizePlainKeys: ['total_towers_buildings', 'total_floors', 'total_commercial_units', 'number_of_phases', 'area_unit', 'total_leasable_area', 'total_saleable_area', 'typical_floor_plate'],
    unitKey: 'unit_type', unitLabel: 'Unit Type', unitSingular: 'Unit', chipLabel: 'Unit Types', unitCustomPlaceholder: 'Custom unit type…',
    unitFields: COMMERCIAL_UNIT_FIELDS, unitPresets: () => presetList('commercial_unit', null, COMMERCIAL_UNIT_PRESET),
    newUnit: newCommercialUnit, unitRow: commercialUnitRow, renderUnits: renderCommercialUnits,
    specPresets: key => COMMERCIAL_SPEC_PRESETS[key] ? presetList('commercial_spec', key, COMMERCIAL_SPEC_PRESETS[key]) : null,
    amenityPresets: cat => presetList('commercial_amenity', cat.key, cat.preset),
    amenityCategories: COMMERCIAL_AMENITY_CATEGORIES,
    galleryCategories: COMMERCIAL_GALLERY_CATEGORIES, docTypes: COMMERCIAL_DOC_TYPES,
    freshProject: freshCommercialProject, payload: commercialPayload
  }
};

function renderMedia() {
  if (!projectId) {
    return `<div class="empty">Save the project first (complete through Status &amp; Construction, then Save as Draft) to upload media.</div>`;
  }
  const sizeHint = `<span class="hint">${esc(UPLOAD_LIMITS[K.buckets.media].label)}</span>`;
  const main = state.media.main;
  const mp = state.media.masterPlan;

  const mainInput = `<input type="file" accept="image/*" data-main-upload="1">`;
  const mainBox = renderUploadSlot('media.main', mainInput) || (main.media_url
    ? `<div class="upload-thumb"><img src="${esc(main.media_url)}" loading="lazy" onerror="this.style.display='none'"><span class="name">Main image set${main.file_size ? ` · ${fmtBytes(main.file_size)}` : ''}</span><button type="button" data-remove-upload="media.main">✕</button></div>`
    : `<label class="upload-box">📷 Click to upload main image${mainInput}${sizeHint}</label>`);

  const mpInput = `<input type="file" accept="image/*" data-masterplan-upload="1">`;
  const mpBox = renderUploadSlot('media.masterPlan', mpInput) || (mp.media_url
    ? `<div class="upload-thumb"><img src="${esc(mp.media_url)}" loading="lazy" onerror="this.style.display='none'"><span class="name">Master plan set${mp.file_size ? ` · ${fmtBytes(mp.file_size)}` : ''}</span><button type="button" data-remove-upload="media.masterPlan">✕</button></div>`
    : `<label class="upload-box">🗺️ Click to upload master plan${mpInput}${sizeHint}</label>`);

  const galleryItems = state.media.gallery.map((g, i) => `
    <div class="upload-thumb upload-thumb-wide">
      <img src="${esc(g.media_url || '')}" loading="lazy" onerror="this.style.display='none'">
      <div class="upload-thumb-body">
        <span class="name">${esc(g.file_name || 'Photo')}${g.file_size ? ` · ${fmtBytes(g.file_size)}` : ''}</span>
        <select data-bind="media.gallery.${i}.category">${K.galleryCategories.map(o => `<option value="${esc(o.value)}"${(g.category || 'exterior') === o.value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
        <input type="text" placeholder="Alt text (for SEO &amp; accessibility)" value="${esc(g.alt_text || '')}" data-bind="media.gallery.${i}.alt_text">
      </div>
      <button type="button" data-remove-gallery="${i}">✕</button>
    </div>`).join('');
  const galleryUploads = Object.entries(uploads).filter(([k]) => k.startsWith('media.gallery.')).map(([key, up]) =>
    up.error
      ? `<div class="upload-thumb upload-error"><span class="name">⚠️ ${esc(up.error)}</span><button type="button" data-dismiss-upload="${key}">✕</button></div>`
      : `<div class="upload-thumb uploading"><div class="upload-spinner"></div><span class="name">Uploading ${esc(up.name)}…</span></div>`
  ).join('');

  const videos = state.media.videos.map((v, i) => `<div class="form-grid" style="margin-bottom:10px">
      ${renderField({ label: 'Platform', type: 'select', options: enumOpts(['youtube', 'facebook', 'instagram', 'other']) }, v.platform, `data-bind="media.videos.${i}.platform"`)}
      ${renderField({ label: v.media_type === 'reel' ? 'Reel Title' : 'Video Title' }, v.title, `data-bind="media.videos.${i}.title"`)}
      ${renderField({ label: 'URL', full: true }, v.media_url, `data-bind="media.videos.${i}.media_url"`)}
    </div>`).join('');
  return `
    <div class="field full"><label>Main Image</label>${mainBox}</div>
    <div class="field full"><label>Master Plan</label>${mpBox}</div>
    <div class="field full"><label>Gallery <span class="hint">${state.media.gallery.length} photo${state.media.gallery.length === 1 ? '' : 's'}</span></label>
      ${galleryItems}${galleryUploads}
      <label class="upload-box">🖼️ Add gallery photo<input type="file" accept="image/*" data-gallery-upload="1">${sizeHint}</label>
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
  const relManagerRec = lookups.relationshipManagers.find(r => r.id === p.relationship_manager_id);
  const relManager = relManagerRec ? `${relManagerRec.full_name} (${relManagerRec.rm_code})` : '—';
  const section = (title, rows, stepNum) => `<div class="review-card">
    <div class="review-card-head"><b>${esc(title)}</b><button type="button" data-goto="${stepNum}">Edit</button></div>
    <dl>${rows.map(([k, v]) => `<div><dt>${esc(k)}:</dt> <dd>${esc(v || '—')}</dd></div>`).join('')}</dl>
  </div>`;
  const range = priceRangeFromConfigs();
  const priceText = range.min == null ? 'Not set' : (range.min === range.max ? fmtPriceWords(range.min) : `${fmtPriceWords(range.min)} – ${fmtPriceWords(range.max)}`);
  if (K.key === 'commercial') return renderCommercialReview(section, { dev, city, loc, agent, relManager, priceText });
  const html = `<div class="review-grid">
    ${section('1. Basic Information', [['Project', p.project_name], ['Developer', dev], ['Type', p.project_type], ['RERA Number(s)', p.rera_numbers.length ? p.rera_numbers.join(', ') : '—'], ['Highlights', `${p.highlights.length} added`]], 1)}
    ${section('2. Project Location', [['Address', p.address], ['City / Locality', `${loc}, ${city}`], ['Pincode', p.pincode]], 2)}
    ${section('3. Size & Scale', [['Land Area', p.total_land_area ? `${p.total_land_area} ${p.land_area_unit}` : '—'], ['Towers', p.total_towers_buildings], ['Total Units', p.total_residential_units]], 3)}
    ${section('4. Status & Construction', [['Status', p.status], ['Phases', state.phases.length || '—']], 4)}
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
    ${section('16. Contact / Enquiry', [['Assigned Agent', agent], ['Relationship Manager', relManager]], 16)}
    ${section('17. SEO', [['Slug', p.slug], ['SEO Title', p.seo_title]], 17)}
  </div>
  ${confirmRowHtml()}`;
  return html;
}

function confirmRowHtml() {
  return `<div class="confirm-row"><input type="checkbox" id="pf-confirm"><label for="pf-confirm">I confirm this information is accurate${originalModerationStatus === 'published' ? '' : ' and ready for verification'}. <span class="req">*</span></label></div>`;
}

function renderCommercialReview(section, { dev, city, loc, agent, relManager, priceText }) {
  const p = state.project;
  const n = i => `${i}. ${K.stepNames[i - 1]}`;
  const label = v => (v ? String(v).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '—');
  const rents = state.configurations.map(c => Number(c.expected_rent)).filter(x => x > 0);
  const rentText = rents.length ? `${fmtPriceWords(Math.min(...rents))}${rents.length > 1 ? ` – ${fmtPriceWords(Math.max(...rents))}` : ''} / month` : 'Not set';
  return `<div class="review-grid">
    ${section(n(1), [['Project', p.project_name], ['Developer', dev], ['Property Type', label(p.project_type)], ['Available For', label(p.transaction_type)], ['RERA Number(s)', p.rera_numbers.length ? p.rera_numbers.join(', ') : '—'], ['Highlights', `${p.highlights.length} added`]], 1)}
    ${section(n(2), [['Address', p.address], ['City / Locality', `${loc}, ${city}`], ['Pincode', p.pincode]], 2)}
    ${section(n(3), [['Land Area', p.total_land_area ? `${p.total_land_area} ${p.land_area_unit}` : '—'], ['Leasable Area', p.total_leasable_area ? `${p.total_leasable_area} ${areaUnitLabel(p.area_unit)}` : '—'], ['Total Units', p.total_commercial_units]], 3)}
    ${section(n(4), [['Status', p.status], ['Occupancy Certificate', label(p.occupancy_certificate)], ['Phases', state.phases.length || '—']], 4)}
    ${section(n(5), [['Units', `${state.configurations.length} added`], ['Sale Price Range', priceText], ['Rent', rentText]], 5)}
    ${section(n(6), [['Structure', p.structure], ['HVAC', p.hvac]], 6)}
    ${section(n(7), [['Towers added', `${state.towers.length}`]], 7)}
    ${section(n(8), [['Selected', `${state.amenities.length} amenities`]], 8)}
    ${section(n(9), [['Added', `${state.nearby.length} landmarks`]], 9)}
    ${section(n(10), [['Main image', state.media.main.media_url ? 'Uploaded' : 'Not set'], ['Gallery', `${state.media.gallery.length} images`], ['Videos', `${state.media.videos.length} added`]], 10)}
    ${section(n(11), [['Pros', `${state.prosCons.filter(x => x.item_type === 'pro').length}`], ['Cons', `${state.prosCons.filter(x => x.item_type === 'con').length}`]], 11)}
    ${section(n(12), [['Documents', `${state.documents.length} added`]], 12)}
    ${section(n(13), [['Entries', `${state.litigation.length}`]], 13)}
    ${section(n(14), [['Updates', `${state.updates.length}`]], 14)}
    ${section(n(15), [['FAQs added', `${state.faqs.length}`]], 15)}
    ${section(n(16), [['Assigned Agent', agent], ['Relationship Manager', relManager]], 16)}
    ${section(n(17), [['Slug', p.slug], ['SEO Title', p.seo_title]], 17)}
  </div>
  ${confirmRowHtml()}`;
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
  if (stepIndex === 5) {
    const priceError = validateConfigPriceRange();
    if (priceError) { toast(priceError, true); return; }
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
  } catch (e) {
    // Without this, an unexpected error here (a thrown exception rather than a returned
    // {error} — a network drop mid-request, a bug) left the wizard stuck on the current
    // step with the Next button simply doing nothing and no visible explanation.
    toast(e.message || 'Something went wrong saving this step — please try again.', true);
    return;
  } finally {
    $('#pf-next').disabled = false;
  }
  stepIndex++;
  pushWizardState();
  renderStepBody();
  window.scrollTo(0, 0);
}

function stepFieldSpecs(i) {
  const F = K.fields;
  const map = { 1: F.basic, 2: F.location, 3: F.size, 4: F.status, 5: F.pricing, 6: F.specs, 16: F.contact, 17: F.seo };
  return map[i] || null;
}

// Repeatable steps' required fields aren't covered by stepFieldSpecs() above (that only
// validates the single-record FIELDS.* steps) — without this, a required field left blank
// on a repeat-card step (e.g. a Construction Update with no date) would pass validation,
// then fail at the database with a NOT NULL / invalid-date error, and Next would silently
// do nothing.
function repeatStepSpecs(i) {
  const map = {
    4: ['phases', PHASE_FIELDS], 5: ['configurations', K.unitFields], 7: ['towers', TOWER_FIELDS], 9: ['nearby', NEARBY_FIELDS],
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
  enhanceSelects(content);
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
  content.querySelectorAll('[data-set-bhktype]').forEach(el => {
    el.onclick = () => {
      const i = Number(el.dataset.setBhktype);
      state.configurations[i][K.unitKey] = el.dataset.val;
      touched = true;
      renderStepBody();
    };
  });
  content.querySelectorAll('[data-set-bhktype-custom]').forEach(el => {
    el.onclick = () => {
      const i = Number(el.dataset.setBhktypeCustom);
      const input = document.getElementById(el.dataset.input);
      const val = (input?.value || '').trim();
      if (!val) return;
      state.configurations[i][K.unitKey] = val;
      touched = true;
      renderStepBody();
    };
  });
  content.querySelectorAll('[data-toggle-bhk]').forEach(el => {
    el.onclick = () => {
      const path = el.dataset.toggleBhk, val = el.dataset.val;
      const arr = getPath(state, path) || [];
      const idx = arr.indexOf(val);
      if (idx >= 0) arr.splice(idx, 1); else arr.push(val);
      setPath(state, path, arr);
      touched = true;
      renderStepBody();
    };
  });
  content.querySelectorAll('[data-toggle-spec-chip]').forEach(el => {
    el.onclick = () => {
      toggleSpecChip(el.dataset.toggleSpecChip, el.dataset.val);
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
    el.onclick = () => {
      const idx = Number(el.dataset.removeGallery);
      deleteStorageFile(K.buckets.media, state.media.gallery[idx]?.media_path);
      state.media.gallery.splice(idx, 1);
      touched = true;
      renderStepBody();
    };
  });
  content.querySelectorAll('[data-dismiss-upload]').forEach(el => {
    el.onclick = () => { delete uploads[el.dataset.dismissUpload]; renderStepBody(); };
  });
  content.querySelectorAll('input[type=file][data-main-upload]').forEach(el => {
    el.onchange = () => handleUpload(el.files[0], K.buckets.media, 'media/main', 'media.main',
      r => { state.media.main = { media_type: 'main_image', ...r }; });
  });
  content.querySelectorAll('input[type=file][data-masterplan-upload]').forEach(el => {
    el.onchange = () => handleUpload(el.files[0], K.buckets.media, 'media/master-plan', 'media.masterPlan',
      r => { state.media.masterPlan = { media_type: 'master_plan', ...r }; });
  });
  content.querySelectorAll('input[type=file][data-gallery-upload]').forEach(el => {
    el.onchange = () => handleUpload(el.files[0], K.buckets.media, 'media/gallery', `media.gallery.${uid()}`,
      r => { state.media.gallery.push({ _k: uid(), media_type: 'gallery', category: 'exterior', alt_text: '', ...r }); });
  });
  content.querySelectorAll('input[type=file][data-doc-upload]').forEach(el => {
    el.onchange = () => { const i = Number(el.dataset.docUpload); handleUpload(el.files[0], K.buckets.docs, 'documents', `documents.${i}`,
      r => { state.documents[i].file_path = r.media_path; state.documents[i].file_url = r.media_url || null; state.documents[i].file_name = r.file_name; state.documents[i].file_size = r.file_size; }); };
  });
  content.querySelectorAll('input[type=file][data-lit-upload]').forEach(el => {
    el.onchange = () => { const i = Number(el.dataset.litUpload); handleUpload(el.files[0], K.buckets.docs, 'litigation', `litigation.${i}`,
      r => { state.litigation[i].supporting_document_path = r.media_path; state.litigation[i].supporting_document_url = r.media_url || null; state.litigation[i].supporting_document_name = r.file_name; state.litigation[i].supporting_document_size = r.file_size; }); };
  });
  content.querySelectorAll('input[type=file][data-update-upload]').forEach(el => {
    el.onchange = () => { const i = Number(el.dataset.updateUpload); handleUpload(el.files[0], K.buckets.media, 'construction-updates', `updates.${i}`,
      r => { state.updates[i].media = state.updates[i].media || []; state.updates[i].media.push({ _k: uid(), media_path: r.media_path, media_url: r.media_url, file_name: r.file_name, file_size: r.file_size }); }); };
  });
}

// Renders the in-progress/error state for a stable-key upload slot (one file at a time —
// main image, master plan, or one row's document/litigation/site-photo attachment), or null
// when nothing is happening so the caller falls back to its normal "empty"/"filled" markup.
// `inputHtml` is the exact <input type=file …> markup for that slot, reused as the retry
// control on error since the key is stable and safe to re-trigger in place.
function renderUploadSlot(key, inputHtml) {
  const up = uploads[key];
  if (!up) return null;
  if (up.error) {
    return `<div class="upload-box upload-error"><span>⚠️ ${esc(up.error)}</span><label class="retry-link">Try again${inputHtml}</label></div>`;
  }
  return `<div class="upload-box uploading"><div class="upload-spinner"></div><div class="upload-progress-wrap"><div class="name">Uploading ${esc(up.name)}${up.size ? ` · ${fmtBytes(up.size)}` : ''}…</div></div></div>`;
}

// Uses the Supabase JS storage client directly (the same call every other upload in this
// app already relies on) rather than a hand-rolled request against the Storage REST API —
// re-implementing auth/headers by hand risked subtly diverging from what the SDK sends and
// getting rejected by Storage's row-level security, which isn't a risk worth taking here.
// That does mean there's no byte-level progress percentage (the SDK's upload() is a plain
// fetch with no progress events) — the spinner + filename is an honest "in progress" status
// instead of a fabricated number.
async function handleUpload(file, bucket, folder, key, cb) {
  if (!file || !projectId) return;

  const limits = UPLOAD_LIMITS[bucket];
  if (limits) {
    if (file.size > limits.maxBytes) {
      uploads[key] = { error: `Too large (${fmtBytes(file.size)}). Max is ${fmtBytes(limits.maxBytes)}.` };
      renderStepBody();
      return;
    }
    if (limits.mimeTypes.length && !limits.mimeTypes.includes(file.type)) {
      uploads[key] = { error: `Unsupported file type${file.type ? ` (${file.type})` : ''}. Allowed: ${limits.label}.` };
      renderStepBody();
      return;
    }
  }

  uploads[key] = { name: file.name, size: file.size };
  renderStepBody();

  const safeName = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
  const path = `${projectId}/${folder}/${Date.now()}-${safeName}`;
  const { error } = await sb.storage.from(bucket).upload(path, file, { upsert: true });
  if (error) {
    uploads[key] = { error: error.message, name: file.name };
    renderStepBody();
    toast(error.message, true);
    return;
  }

  delete uploads[key];
  const url = bucket === K.buckets.docs ? null : sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  cb({ media_path: path, media_url: url, file_name: file.name, file_size: file.size });
  touched = true;
  renderStepBody();
  toast('Uploaded');
}

// Best-effort delete of a file from Supabase Storage when its reference is removed from the
// form (a re-upload, a removed gallery photo, a deleted Document/Litigation/Construction
// Update row). Fire-and-forget: a failed delete here just leaves an orphaned file in the
// bucket, which is far better than blocking the person from removing the reference in the
// form over a storage error they can't do anything about.
function deleteStorageFile(bucket, path) {
  if (!path) return;
  sb.storage.from(bucket).remove([path]).catch(() => {});
}

/* ============ save logic ============ */

async function ensureProjectCode() {
  const cityName = lookups.cities.find(c => c.id === state.project.city_id)?.name || 'GEN';
  const cityCode = cityName.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'GEN';
  return `${K.codePrefix}-${cityCode}-${Date.now().toString(36).toUpperCase().slice(-6)}`;
}
async function ensureUniqueSlug(base) {
  let slug = base || 'project';
  let n = 1;
  for (;;) {
    let q = sb.from(K.tables.project).select('id').eq('slug', slug);
    if (projectId) q = q.neq('id', projectId);
    const { data } = await q.limit(1);
    if (!data || !data.length) return slug;
    n++;
    slug = `${base}-${n}`;
  }
}

function projectPayload() {
  return { ...K.payload(state.project), updated_by: currentUser.id };
}

const num = v => (v === '' || v === null || v === undefined ? null : Number(v));
const str = v => (v === '' ? null : v);

function residentialPayload(p) {
  return {
    project_name: p.project_name, developer_id: p.developer_id, project_type: p.project_type,
    launch_date: str(p.launch_date), rera_numbers: p.rera_numbers || [], rera_number: str((p.rera_numbers || [])[0] || null), overview: p.overview, highlights: p.highlights || [],
    city_id: p.city_id, locality_id: p.locality_id, address: p.address, pincode: p.pincode,
    latitude: num(p.latitude), longitude: num(p.longitude),
    total_land_area: num(p.total_land_area), land_area_unit: str(p.land_area_unit),
    total_towers_buildings: num(p.total_towers_buildings), total_floors: str(p.total_floors),
    total_residential_units: num(p.total_residential_units),
    number_of_phases: num(p.number_of_phases),
    open_green_area_value: num(p.open_green_area_value), open_green_area_unit: str(p.open_green_area_unit),
    built_up_project_area: num(p.built_up_project_area), built_up_project_area_unit: str(p.built_up_project_area_unit),
    status: p.status,
    starting_price: priceRangeFromConfigs().min, maximum_price: priceRangeFromConfigs().max, price_on_request: !!p.price_on_request,
    base_price: num(p.base_price), floor_rise_charges: num(p.floor_rise_charges), parking_charges: num(p.parking_charges),
    clubhouse_charges: num(p.clubhouse_charges), maintenance_charges: num(p.maintenance_charges), other_charges: num(p.other_charges),
    gst_applicable: !!p.gst_applicable, price_disclaimer: str(p.price_disclaimer), registration_stamp_duty_disclaimer: str(p.registration_stamp_duty_disclaimer),
    flooring: str(p.flooring), doors: str(p.doors), windows: str(p.windows), kitchen: str(p.kitchen), bathroom: str(p.bathroom),
    electrical: str(p.electrical), walls_paint: str(p.walls_paint), balcony: str(p.balcony), other_specifications: str(p.other_specifications),
    agent_id: str(p.agent_id), relationship_manager_id: str(p.relationship_manager_id),
    seo_title: str(p.seo_title), seo_description: str(p.seo_description), canonical_url: str(p.canonical_url)
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
    const { data, error } = await sb.from(K.tables.project).insert(payload).select('id,project_code,slug').single();
    if (error) return { error: error.message };
    projectId = data.id;
    state.project.slug = data.slug;
    await sb.from(K.tables.history).insert({ project_id: projectId, to_status: 'draft', action: 'created', changed_by: currentUser.id });
  } else {
    if (state.project.slug) payload.slug = await ensureUniqueSlug(slugify(state.project.slug));
    const { error } = await sb.from(K.tables.project).update(payload).eq('id', projectId);
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

  const T = K.tables;
  try {
    if (i === 4) {
      const err = await replaceChildRows(T.phases, state.phases.map((p, idx) => ({
        phase_name: p.phase_name, construction_start_date: p.construction_start_date || null,
        expected_completion_date: p.expected_completion_date || null, rera_possession_date: p.rera_possession_date || null,
        target_possession_date: p.target_possession_date || null, units_per_phase: num(p.units_per_phase),
        configurations: p.configurations?.length ? p.configurations : [],
        display_order: idx
      })));
      if (err) throw new Error(err);
    } else if (i === 5) {
      const err = await replaceChildRows(T.units, state.configurations.map((c, idx) => K.unitRow(c, idx)));
      if (err) throw new Error(err);
    } else if (i === 7) {
      const err = await replaceChildRows(T.towers, state.towers.map((t, idx) => ({
        tower_name: t.tower_name, number_of_floors: num(t.number_of_floors),
        number_of_units: num(t.number_of_units), configurations: t.configurations || [], tower_status: t.tower_status,
        construction_stage: t.construction_stage || null, construction_start_date: t.construction_start_date || null,
        expected_completion_date: t.expected_completion_date || null, possession_status: t.possession_status || null,
        construction_details: t.construction_details || null, display_order: idx
      })));
      if (err) throw new Error(err);
    } else if (i === 8) {
      const err = await replaceChildRows(T.amenities, state.amenities.map((a, idx) => ({
        category: a.category, amenity_type: a.amenity_type || a.amenity_name, amenity_name: a.amenity_name,
        description: a.description || null, is_available: a.is_available !== false, display_order: idx
      })));
      if (err) throw new Error(err);
    } else if (i === 9) {
      // location_type is NOT NULL in the database but optional in the UI — must default to
      // '' (not null) here, or the insert fails whenever a landmark's "Type" is left blank.
      const err = await replaceChildRows(T.nearby, state.nearby.map((n, idx) => ({
        category: n.category, location_type: n.location_type || '', name: n.name, distance: num(n.distance),
        distance_unit: n.distance_unit, description: n.description || null, display_order: idx
      })));
      if (err) throw new Error(err);
    } else if (i === 10) {
      const err = await replaceChildRows(T.media, mediaRows());
      if (err) throw new Error(err);
    } else if (i === 11) {
      const err = await replaceChildRows(T.prosCons, state.prosCons.map((p, idx) => ({
        item_type: p.item_type, content: p.content, display_order: idx, created_by: currentUser.id
      })));
      if (err) throw new Error(err);
    } else if (i === 12) {
      const err = await replaceChildRows(T.documents, state.documents.filter(d => d.file_path).map(d => ({
        document_type: d.document_type, title: d.title, file_path: d.file_path, file_url: d.file_url,
        visibility: d.visibility, description: d.description || null, uploaded_by: currentUser.id
      })));
      if (err) throw new Error(err);
    } else if (i === 13) {
      const err = await replaceChildRows(T.litigation, state.litigation.map(l => ({
        status: l.status, case_title: l.case_title || null, court_tribunal: l.court_tribunal || null,
        case_type: l.case_type || null, filing_date: l.filing_date || null, current_status: l.current_status || null,
        case_description: l.case_description || null, supporting_document_path: l.supporting_document_path || null,
        supporting_document_url: l.supporting_document_url || null, created_by: currentUser.id
      })));
      if (err) throw new Error(err);
    } else if (i === 14) {
      await sb.from(T.updates).delete().eq('project_id', projectId);
      for (const u of state.updates) {
        const { data, error } = await sb.from(T.updates).insert({
          project_id: projectId, update_title: u.update_title, update_date: u.update_date,
          construction_stage: u.construction_stage || null, description: u.description || null,
          is_published: !!u.is_published, created_by: currentUser.id
        }).select('id').single();
        if (error) throw new Error(error.message);
        if (u.media?.length) {
          await sb.from(T.updateMedia).insert(u.media.map(m => ({ update_id: data.id, media_path: m.media_path, media_url: m.media_url })));
        }
      }
    } else if (i === 15) {
      const err = await replaceChildRows(T.faqs, state.faqs.map((f, idx) => ({
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
  // storage_bucket is required by the DB whenever media_path is set (residential_media_
  // storage_mapping_check) — leaving it out made every save fail *after* replaceChildRows()
  // had already deleted the previous rows, so a failed Project Media save silently wiped
  // out whatever photos were already on the project.
  //
  // display_order and is_primary are NOT NULL columns with DB-side defaults (0 / false),
  // but replaceChildRows() sends every row in ONE batch insert, and PostgREST builds that
  // as a single statement using the union of keys across all rows — any row missing a key
  // present on another row gets an explicit NULL for it instead of falling back to the
  // column default. So every row needs every one of these keys set, even if just to the
  // same value the default would have given it.
  if (state.media.main.media_path) rows.push({ media_type: 'main_image', media_path: state.media.main.media_path, media_url: state.media.main.media_url, storage_bucket: K.buckets.media, is_primary: true, display_order: 0 });
  if (state.media.masterPlan.media_path) rows.push({ media_type: 'master_plan', media_path: state.media.masterPlan.media_path, media_url: state.media.masterPlan.media_url, storage_bucket: K.buckets.media, is_primary: false, display_order: 0 });
  state.media.gallery.forEach((g, i) => rows.push({ media_type: 'gallery', category: g.category || 'exterior', media_path: g.media_path, media_url: g.media_url, storage_bucket: K.buckets.media, alt_text: g.alt_text || null, is_primary: false, display_order: i }));
  state.media.videos.forEach((v, i) => rows.push({ media_type: v.media_type || 'video', platform: v.platform, title: v.title || null, media_url: v.media_url, is_primary: false, display_order: i }));
  return rows;
}

async function saveCurrentAndDraft() {
  handleSpecialBindings();
  const priceError = validateConfigPriceRange();
  if (priceError) { toast(priceError, true); return; }
  $('#pf-save-draft').disabled = true;
  try {
    // persistStep() already calls saveProjectCore() internally for any step from
    // FIRST_SAVE_AFTER_STEP onward — calling it again here duplicated every draft save
    // (harmless on its own, since the second call just re-updates the row it just created/
    // updated, but it doubled the network round trips and made a slow connection or a
    // transient error twice as likely to hit right on this step).
    const ok = await persistStep(Math.max(stepIndex, stepIndex < FIRST_SAVE_AFTER_STEP ? FIRST_SAVE_AFTER_STEP - 1 : stepIndex));
    if (stepIndex < FIRST_SAVE_AFTER_STEP) {
      toast('Fill Basic Info, Location and Status & Construction to save — kept locally for now.');
    } else if (ok !== false) {
      toast(isEdit ? 'Updated' : 'Saved as draft');
      renderStepBody();
    }
  } finally {
    $('#pf-save-draft').disabled = false;
  }
}

async function submitForVerification() {
  const priceError = validateConfigPriceRange();
  if (priceError) { toast(priceError, true); return; }
  $('#pf-next').disabled = true;
  try {
    for (let i = FIRST_SAVE_AFTER_STEP; i <= 15; i++) {
      const ok = await persistStep(i);
      if (!ok) return;
    }
    // Editing an already-published listing just saves the changes in place — sending it
    // back into the moderation queue on every edit would make routine corrections (a typo, a
    // price update) disappear off the live site until someone re-approves them. Only a
    // project that hasn't been published yet (draft / changes_required / rejected / a brand
    // new one) actually needs this to move it into review.
    if (originalModerationStatus === 'published') {
      const { error } = await sb.from(K.tables.project).update({ updated_by: currentUser.id }).eq('id', projectId);
      if (error) { toast(error.message, true); return; }
      toast('Project updated');
      closeForm();
      return;
    }
    const { error } = await sb.from(K.tables.project).update({
      moderation_status: 'pending_verification', submitted_at: new Date().toISOString(), updated_by: currentUser.id
    }).eq('id', projectId);
    if (error) { toast(error.message, true); return; }
    await sb.from(K.tables.history).insert({
      project_id: projectId, from_status: originalModerationStatus || 'draft', to_status: 'pending_verification', action: 'submitted', changed_by: currentUser.id
    });
    toast('Submitted for verification');
    showSubmitSuccess();
  } finally {
    const nextBtn = $('#pf-next');
    if (nextBtn) nextBtn.disabled = false;
  }
}

// Shown in place of the wizard right after a successful submit, instead of closing
// straight back to the project list — resets the form so another project can be added,
// while still leaving "Back to Projects" for the original exit behavior.
function showSubmitSuccess() {
  content.removeEventListener('input', onFieldInput);
  content.removeEventListener('change', onFieldChange);
  content.removeEventListener('click', onFieldClick);
  content.innerHTML = `<div class="wrap">
    <div class="form-success">
      <div class="form-success-icon">🎉</div>
      <h3>Congratulations!</h3>
      <p>Your project has been submitted for verification.</p>
      <div style="display:flex;gap:10px;margin-top:18px">
        <button type="button" class="btn-outline" id="pf-success-close">Back to Projects</button>
        <button type="button" class="btn-primary" id="pf-success-add">Add Another Project</button>
      </div>
    </div>
  </div>`;
  $('#pf-success-close').addEventListener('click', () => closeForm());
  $('#pf-success-add').addEventListener('click', () => {
    projectId = null;
    isEdit = false;
    stepIndex = 1;
    touched = false;
    uploads = {};
    state = freshState();
    renderShell();
    pushWizardState(`#/${K.routeBase}/add`);
  });
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

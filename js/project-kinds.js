// The two project kinds the admin manages. Each has its own set of tables and Storage
// buckets (commercial_* mirrors residential_* table for table), so every page that reads or
// writes projects looks its tables up here instead of naming residential_* directly.

export const PROJECT_KINDS = {
  residential: {
    key: 'residential',
    label: 'Residential',
    routeBase: 'residential',
    codePrefix: 'RES',
    tables: {
      project: 'residential_projects',
      units: 'residential_configurations',
      phases: 'residential_project_phases',
      towers: 'residential_towers',
      amenities: 'residential_amenities',
      nearby: 'residential_nearby_locations',
      prosCons: 'residential_project_pros_cons',
      documents: 'residential_documents',
      litigation: 'residential_litigation',
      updates: 'residential_construction_updates',
      updateMedia: 'residential_construction_update_media',
      faqs: 'residential_faqs',
      media: 'residential_media',
      history: 'residential_project_moderation_history',
      enquiries: 'residential_enquiries',
      blogs: 'residential_project_blogs'
    },
    buckets: { media: 'residential-media', docs: 'residential-documents' }
  },
  commercial: {
    key: 'commercial',
    label: 'Commercial',
    routeBase: 'commercial',
    codePrefix: 'COM',
    tables: {
      project: 'commercial_projects',
      units: 'commercial_units',
      phases: 'commercial_project_phases',
      towers: 'commercial_towers',
      amenities: 'commercial_amenities',
      nearby: 'commercial_nearby_locations',
      prosCons: 'commercial_project_pros_cons',
      documents: 'commercial_documents',
      litigation: 'commercial_litigation',
      updates: 'commercial_construction_updates',
      updateMedia: 'commercial_construction_update_media',
      faqs: 'commercial_faqs',
      media: 'commercial_media',
      history: 'commercial_project_moderation_history',
      enquiries: 'commercial_enquiries',
      blogs: 'commercial_project_blogs'
    },
    buckets: { media: 'commercial-media', docs: 'commercial-documents' }
  }
};

export const KIND_KEYS = Object.keys(PROJECT_KINDS);

export function projectKind(key) {
  return PROJECT_KINDS[key] || PROJECT_KINDS.residential;
}

// PostgREST embed hint for a project's locality — each project table has its own FK name.
export function localityEmbed(kind) {
  return `localities!${projectKind(kind).tables.project}_locality_id_fkey(name)`;
}

// Runs the same query builder against every kind's table and tags each row with its kind,
// so merged lists (moderation queue, enquiries, archive, dashboard) can route actions back
// to the right table. `build(kind)` returns a Supabase query; errors are collected, not thrown.
// `kinds` narrows it to a subset (e.g. the Reports page's Residential/Commercial filter).
export async function queryAllKinds(build, kinds = KIND_KEYS) {
  const results = await Promise.all(kinds.map(k => build(PROJECT_KINDS[k])));
  const rows = [];
  let error = null;
  results.forEach((r, i) => {
    if (r.error) { error = error || r.error; return; }
    (r.data || []).forEach(row => rows.push({ ...row, _kind: kinds[i] }));
  });
  return { data: rows, error };
}

export function kindPill(kind) {
  return `<span class="pill kind-${kind}">${projectKind(kind).label}</span>`;
}

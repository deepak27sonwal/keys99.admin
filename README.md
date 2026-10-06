# Keys99 Admin

Fresh administration panel for Keys99.com.

## Environments

- Staging: `superdeep.keys99.com`
- Production later: `admin.keys99.com`

## Backend

Supabase project: `keys99.com`

Project ref: `ljyywdgwjiedeiuqchdt`

The browser application uses only the Supabase publishable key. A service-role key must never be committed to this repository.

## Current database contract

### Foundation

- profiles
- user_roles
- developers
- cities
- localities
- agents
- relationship_managers
- app_settings (single row: enquiry contact defaults, default city)
- lookup_options (editable preset lists for the project form: BHK types, specifications, amenities, nearby location types)

### Residential

- residential_projects
- residential_configurations
- residential_towers
- residential_amenities
- residential_nearby_locations
- residential_media
- residential_floor_plans
- residential_documents
- residential_litigation
- residential_construction_updates
- residential_construction_update_media
- residential_faqs
- residential_project_pros_cons
- residential_enquiries
- residential_project_moderation_history
- residential_project_blogs

### Commercial

Mirrors the residential tables one for one (same RLS model, moderation workflow and
archive behaviour), with commercial-specific columns and enums. Covers Office, Shop,
Showroom, Warehouse, Industrial, Healthcare, Education, Hospitality, Commercial Land and
Commercial Building.

- commercial_projects (sale / lease / sale-and-lease, leasable and saleable area, lease terms, building specs)
- commercial_units (unit type, floor, furnishing, rent or sale price, per unit)
- commercial_project_phases
- commercial_towers
- commercial_amenities
- commercial_nearby_locations
- commercial_media
- commercial_documents
- commercial_litigation
- commercial_construction_updates
- commercial_construction_update_media
- commercial_faqs
- commercial_project_pros_cons
- commercial_enquiries
- commercial_project_moderation_history
- commercial_project_blogs

Storage buckets: `commercial-media` (public) and `commercial-documents` (private), mirroring
`residential-media` / `residential-documents`.

The admin code looks every table and bucket up through `js/project-kinds.js` rather than
naming them directly, and the project wizard (`js/project-form.js`) drives both kinds from
the same 18-step skeleton with a per-kind config.

All current public tables have RLS enabled.

## Admin workflow

Authentication → role check → dashboard → residential project management → moderation → publish.

The residential project editor is being built around the finalized 20-section posting specification. Child records are stored in their dedicated tables rather than flattened into one JSON field.

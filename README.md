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

## Rendering blog posts (public site)

Blog posts (`residential_project_blogs` / `commercial_project_blogs`) are written in a
rich-text editor in the admin (Quill, `js/rich-text.js`). Each post stores:

| Column | Use on the site |
|---|---|
| `body_html` | The post body — sanitized HTML using only `h2 h3 p br strong em u s a ul ol li blockquote img hr` (alignment via `ql-align-center/right/justify` classes). **Render this.** Older posts may have it empty: fall back to `body`, splitting on blank lines into `<p>`s. |
| `body` | Plain-text copy of the post, for search, feeds and the fallback above. |
| `title`, `excerpt` | Page `<h1>` and intro / card summary. |
| `cover_image_url`, `cover_image_alt` | Hero image (16:9 works best) and its `alt`. All images are ≤ 100 KB WebP. |
| `author`, `published_at`, `reading_time_minutes`, `tags[]` | Meta line ("Keys99 Editorial · 09 Oct 2026 · 3 min read") and tag chips. |
| `meta_title`, `meta_description` | `<title>` and `<meta name="description">` (fall back to `title` / `excerpt`). |
| `is_published`, `is_featured` | Only show published posts; pin featured ones first. |

Sanitize `body_html` again on the site (e.g. DOMPurify with the tag list above) — never
trust stored HTML blindly. Wrap it in `<div class="k99-article">` and copy the
`.k99-post-*` / `.k99-article` rules from `css/admin.css` (section "Post typography") so the
site matches the admin's Preview exactly.

## Releasing

The admin has no build step, so browsers and CDNs can keep serving an old copy of a JS
module after a deploy. Before committing a change that should go live, run:

```sh
scripts/stamp-build.sh
```

It writes a new build stamp into `index.html` and `login.html`: an import map that adds
`?v=<build>` to every `js/*.js` module, plus versioned CSS and entry-script URLs. The live
build is shown at the bottom of the sidebar ("Build 20261008.1619-47aa326"), so you can check
that staging is on the latest deploy. `_headers` also tells Cloudflare Pages / Netlify to
revalidate every file on each visit.

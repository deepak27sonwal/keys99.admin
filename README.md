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

`carpet_area` in `residential_configurations` and `commercial_units` is **text**: either a
single size (`"720"`) or a range of two sizes (`"650-720"`), always written with a plain
hyphen and no spaces or units (a check constraint enforces the format). The public site
should display it as-is, e.g. "650–720 sq ft", rather than parsing it as a number.

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

## Newsletter

Sidebar → **Newsletter** (`js/newsletter.js`). Write an email in the rich-text composer,
pick who receives it, preview it (desktop / mobile), send yourself a test, then send.

- **Audience** — everyone subscribed, newsletter subscribers only, registered users only
  (optionally narrowed by city / interest), or hand-picked people. Only rows with
  `is_subscribed = true` are ever emailed.
- **Registered users count as subscribers.** Opening the Newsletter page runs the
  `send-newsletter` function's `sync_users` action, which adds every keys99.com account
  without a staff role (`user_roles`) to `newsletter_subscribers` (source `registered_user`).
- **Personalisation** — `{{first_name}}`, `{{name}}`, `{{email}}` in the subject or body are
  filled in per recipient.
- **Sending** — `supabase/functions/send-newsletter` (Brevo transactional API) sends each
  email individually from **Keys99 &lt;newsletter@keys99.com&gt;**, in batches the page drives
  with a progress bar; each recipient's result is in `newsletter_campaign_recipients`
  (Delivery report). A send interrupted by closing the tab can be resumed from the list.
- **Unsubscribe** — every email links to `unsubscribe.html?t=<token>` on this site (it asks
  for a click before unsubscribing) and carries a one-click `List-Unsubscribe` header handled
  by `supabase/functions/newsletter-unsubscribe`.

Setup checklist:
1. In Brevo → *Senders, domains & dedicated IPs*, add and verify **newsletter@keys99.com**
   (and authenticate the keys99.com domain — SPF/DKIM — for good deliverability). Brevo
   rejects sends from an unverified sender.
2. The Brevo API key must be set as an Edge Function secret named `BREVO_API_KEY`
   (`Brevo_apikey`, used by `subscribe-newsletter`, also works).
3. Run `supabase/manual/newsletter_admin_policies.sql` once in the SQL editor so
   super admins (not only admins) can use the Newsletter page.

## Featured listings

Residential and Commercial project lists have a ☆ / ★ button on each row to feature a
project, and a **★ Featured** button that opens the manager (display order, optional
"featured until" date, remove). Columns on both project tables: `is_featured`,
`featured_order`, `featured_until`, `featured_at`.

The website should show a project as featured when:

```sql
is_featured and moderation_status = 'published' and deleted_at is null
  and (featured_until is null or featured_until >= current_date)
order by featured_order nulls last, featured_at desc
```

## Stored images

Every image upload is converted to WebP ≤ 100 KB (see CLAUDE.md). Photos stored before that
rule can be fixed from **Settings → Image Optimization** (super admins): *Scan* lists in-use
images that are not WebP or are over 100 KB, *Convert* re-encodes them in the browser and
repoints every project / floor plan / blog / document row at the new file before deleting the
original, and *Delete unused* removes images nothing refers to.

## Rental listings

Owners post rentals on keys99.com (`rental_properties` plus `rental_residential_details` /
`rental_commercial_details`, photos in the public `rental-property-media` bucket, ownership
documents in the private `rental-property-documents` bucket). **Rental Listings** in the admin
(`js/rentals.js`) is their approval queue:

- Tabs: Pending Approval, Approved, Rejected, Rented / Expired / Inactive, All. The sidebar badge
  and the bell count listings waiting in `pending`.
- **Review** shows photos, owner, every detail, amenities, history and the ownership documents.
  Documents open through a 10-minute signed link and can be marked verified or rejected.
- Actions: pending → **Approve** / **Reject** (the reason is saved in `rejection_reason`, which
  the owner sees and can fix and resubmit); approved → **Mark Rented** / **Deactivate**;
  rented / expired / inactive → **Reactivate**. Each one is logged in
  `rental_property_moderation_history`.
- The database enforces the rules: owners can only move a listing between draft and pending,
  and only with at least one photo and one document, and they can't set approval fields.
  Approving queues a site rebuild.

## Security notes

- **Third-party code.** supabase-js is self-hosted at an exact version
  (`assets/vendor/supabase-js-2.117.3/`, checked against npm's integrity hash) rather than
  loaded as a floating `@2` from a CDN, so a new upstream release can't change code that sees
  admin sessions. Upgrade by replacing the folder and updating the `<script>` in `index.html`
  and `login.html`.
- **Links.** Admin-entered links (ad link, developer website, canonical URL, video URLs) must
  be http(s) web addresses; a bare domain gets `https://` added. Check constraints
  (`*_safe_chk`) block `javascript:` / `data:` links in the database as well.
- **Headers.** `_headers` stops the admin being framed by other sites and sets
  `nosniff` / `Referrer-Policy`.
- **Edge functions.** The source of every deployed function lives under `supabase/functions/`.
  `sync-brevo-contact` only lets a user change their own Brevo contact (admins may pass any
  email). `subscribe-newsletter` never overwrites an existing subscriber's details.
- **Supabase dashboard.** Turn on Authentication → Passwords → *Leaked password protection*.

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

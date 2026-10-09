// send-newsletter — sends Newsletter emails composed in the Keys99 admin through Brevo.
//
// Called by the admin (js/newsletter.js) with the signed-in admin's JWT. Every action checks
// that the caller has an admin or super_admin role. Actions (POST JSON { action, ... }):
//   sync_users  — adds registered website users (accounts without a staff role) to
//                 newsletter_subscribers, so they're treated like subscribers.
//   test        — { subject, preheader, html, to: [emails] } sends one copy per address with
//                 sample merge values; nothing is recorded.
//   queue       — { campaign_id } resolves the campaign's audience into
//                 newsletter_campaign_recipients rows (status 'queued') and marks it 'sending'.
//   send_batch  — { campaign_id } sends up to BATCH queued recipients and returns
//                 { sent, failed, remaining }; the admin calls it until remaining is 0, which
//                 keeps each call well inside the edge-function time limit.
//
// Each email is sent individually so it can be personalised ({{first_name}}, {{name}},
// {{email}}, {{unsubscribe_url}}) and carry its own one-click List-Unsubscribe header.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SENDER = { name: "Keys99", email: "newsletter@keys99.com" };
const BATCH = 120;
const CONCURRENCY = 6;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });

type Recipient = { email: string; full_name?: string | null; unsubscribe_token?: string | null };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function personalise(html: string, r: Recipient, unsubscribeUrl: string) {
  const name = (r.full_name || "").trim();
  const first = name.split(/\s+/)[0] || "there";
  const values: Record<string, string> = {
    first_name: esc(first),
    name: esc(name || "there"),
    email: esc(r.email),
    unsubscribe_url: esc(unsubscribeUrl),
  };
  return html.replace(/\{\{\s*(first_name|name|email|unsubscribe_url)\s*\}\}/g, (_m, k) => values[k]);
}

async function sendOne(apiKey: string, subject: string, html: string, r: Recipient, unsubscribeUrl: string, oneClickUrl: string) {
  const subj = personalise(subject, r, unsubscribeUrl).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "api-key": apiKey },
    body: JSON.stringify({
      sender: SENDER,
      to: [{ email: r.email, ...(r.full_name ? { name: r.full_name } : {}) }],
      subject: subj,
      htmlContent: personalise(html, r, unsubscribeUrl),
      headers: {
        "List-Unsubscribe": `<${oneClickUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      tags: ["newsletter"],
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).message || text; } catch { /* keep raw */ }
    return { ok: false as const, error: `Brevo ${res.status}: ${msg}`.slice(0, 500) };
  }
  let id: string | null = null;
  try { id = JSON.parse(text).messageId || null; } catch { /* ignore */ }
  return { ok: true as const, id };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const apiKey = Deno.env.get("BREVO_API_KEY") || Deno.env.get("Brevo_apikey");
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // --- caller must be a signed-in admin / super admin ---
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: userData } = await admin.auth.getUser(jwt);
  const caller = userData?.user;
  if (!caller) return json({ error: "Please sign in again." }, 401);
  const { data: roles } = await admin.from("user_roles").select("role").eq("user_id", caller.id);
  if (!(roles || []).some((r) => r.role === "admin" || r.role === "super_admin")) return json({ error: "Only admins can send newsletters." }, 403);

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");
  // The link in the email opens unsubscribe.html on the admin site (passed by the admin page,
  // as Supabase can't serve HTML pages); mail apps' one-click unsubscribe POSTs straight to the
  // newsletter-unsubscribe function.
  const oneClickBase = `${url}/functions/v1/newsletter-unsubscribe`;
  const pageBase = /^https:\/\/[^\s"'<>]+$/.test(String(body.unsubscribe_page || "")) ? String(body.unsubscribe_page) : oneClickBase;
  const links = (token: string) => ({ page: `${pageBase}?t=${token}`, oneClick: `${oneClickBase}?t=${token}` });

  if (action === "sync_users") {
    const users: { id: string; email?: string; user_metadata?: Record<string, unknown> }[] = [];
    for (let page = 1; page < 50; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) return json({ error: error.message }, 500);
      users.push(...data.users);
      if (data.users.length < 1000) break;
    }
    const [{ data: staff }, { data: profiles }, { data: existing }] = await Promise.all([
      admin.from("user_roles").select("user_id"),
      admin.from("profiles").select("id,full_name"),
      admin.from("newsletter_subscribers").select("email,user_id"),
    ]);
    const staffIds = new Set((staff || []).map((r) => r.user_id));
    const names = new Map((profiles || []).map((p) => [p.id, p.full_name]));
    const known = new Map((existing || []).map((s) => [s.email, s.user_id]));
    const rows = users
      .filter((u) => u.email && !staffIds.has(u.id))
      .map((u) => ({ id: u.id, email: u.email!.trim().toLowerCase(), name: (names.get(u.id) || u.user_metadata?.full_name || u.user_metadata?.name || null) as string | null }))
      .filter((u) => known.get(u.email) !== u.id);   // new, or not linked yet
    let added = 0;
    for (const u of rows) {
      if (known.has(u.email)) {
        // Already subscribed via the website form — just link the account (keep their choice).
        await admin.from("newsletter_subscribers").update({ user_id: u.id, updated_at: new Date().toISOString() }).eq("email", u.email);
      } else {
        const { error } = await admin.from("newsletter_subscribers").insert({ email: u.email, full_name: u.name, source: "registered_user", is_subscribed: true, user_id: u.id });
        if (!error) added++;
      }
    }
    return json({ added, linked: rows.length - added });
  }

  if (!apiKey) return json({ error: "The Brevo API key isn't configured on the server (secret BREVO_API_KEY)." }, 500);

  if (action === "test") {
    const to: string[] = (Array.isArray(body.to) ? body.to : [body.to]).map((e: unknown) => String(e || "").trim().toLowerCase()).filter((e: string) => /^\S+@\S+\.\S+$/.test(e)).slice(0, 5);
    if (!to.length) return json({ error: "Enter an email address for the test." }, 400);
    if (!body.subject || !body.html) return json({ error: "Subject and content are required." }, 400);
    const results = await pool(to, 3, (email) =>
      sendOne(apiKey, `[TEST] ${body.subject}`, String(body.html), { email, full_name: String(body.sample_name || "Rahul Sharma") }, links("test").page, links("test").oneClick));
    const failed = results.filter((r) => !r.ok) as { error: string }[];
    if (failed.length) return json({ error: failed[0].error }, 502);
    return json({ sent: to.length });
  }

  const campaignId = String(body.campaign_id || "");
  const { data: campaign, error: cErr } = await admin.from("newsletter_campaigns").select("*").eq("id", campaignId).single();
  if (cErr || !campaign) return json({ error: "Campaign not found." }, 404);

  if (action === "queue") {
    if (!["draft", "failed"].includes(campaign.status)) return json({ error: `This email is already ${campaign.status}.` }, 409);
    const f = (campaign.audience_filter || {}) as { type?: string; cities?: string[]; interests?: string[]; subscriber_ids?: string[] };
    // Supabase returns at most 1,000 rows per request, so page through the audience.
    const subs: { id: string }[] = [];
    for (let from = 0; from < 100000; from += 1000) {
      let q = admin.from("newsletter_subscribers").select("id").eq("is_subscribed", true).order("created_at").range(from, from + 999);
      if (f.type === "registered_user") q = q.eq("source", "registered_user");
      else if (f.type === "website") q = q.neq("source", "registered_user");
      else if (f.type === "custom") q = q.in("id", (f.subscriber_ids || []).slice(0, 500));
      if (f.type !== "custom" && f.cities?.length) q = q.in("city", f.cities);
      if (f.type !== "custom" && f.interests?.length) q = q.in("property_interest", f.interests);
      const { data, error: sErr } = await q;
      if (sErr) return json({ error: sErr.message }, 500);
      subs.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
    if (!subs?.length) return json({ error: "No subscribed recipients match this audience." }, 400);
    // Retrying a failed send: put its failed recipients back in the queue.
    if (campaign.status === "failed") {
      await admin.from("newsletter_campaign_recipients").update({ status: "queued", error_message: null }).eq("campaign_id", campaignId).eq("status", "failed");
    }
    for (let i = 0; i < subs.length; i += 1000) {
      const { error } = await admin.from("newsletter_campaign_recipients").upsert(
        subs.slice(i, i + 1000).map((s) => ({ campaign_id: campaignId, subscriber_id: s.id, status: "queued" })),
        { onConflict: "campaign_id,subscriber_id", ignoreDuplicates: true });
      if (error) return json({ error: error.message }, 500);
    }
    await admin.from("newsletter_campaigns").update({ status: "sending", total_recipients: subs.length, last_error: null, updated_at: new Date().toISOString() }).eq("id", campaignId);
    return json({ total: subs.length });
  }

  if (action === "send_batch") {
    if (campaign.status !== "sending") return json({ error: `This email is ${campaign.status}, not sending.` }, 409);
    const { data: batch, error: bErr } = await admin.from("newsletter_campaign_recipients")
      .select("id, subscriber:newsletter_subscribers(email, full_name, unsubscribe_token, is_subscribed)")
      .eq("campaign_id", campaignId).eq("status", "queued").limit(BATCH);
    if (bErr) return json({ error: bErr.message }, 500);

    const now = () => new Date().toISOString();
    const results = await pool(batch || [], CONCURRENCY, async (row: any) => {
      const s = row.subscriber;
      if (!s || !s.is_subscribed) {
        await admin.from("newsletter_campaign_recipients").update({ status: "failed", error_message: "Unsubscribed before sending" }).eq("id", row.id);
        return false;
      }
      const l = links(s.unsubscribe_token);
      const r = await sendOne(apiKey, campaign.subject, campaign.content_html, s, l.page, l.oneClick);
      await admin.from("newsletter_campaign_recipients").update(r.ok
        ? { status: "sent", provider_message_id: r.id, sent_at: now(), error_message: null }
        : { status: "failed", error_message: r.error }).eq("id", row.id);
      return r.ok;
    });

    const [{ count: sent }, { count: failed }, { count: remaining }] = await Promise.all(
      ["sent", "failed", "queued"].map((st) => admin.from("newsletter_campaign_recipients").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId).eq("status", st)));
    const firstError = results.includes(false)
      ? (await admin.from("newsletter_campaign_recipients").select("error_message").eq("campaign_id", campaignId).eq("status", "failed").limit(1)).data?.[0]?.error_message
      : null;
    const patch: Record<string, unknown> = { sent_count: sent || 0, failed_count: failed || 0, updated_at: now() };
    if (firstError) patch.last_error = firstError;
    if (!remaining) {
      patch.status = (sent || 0) > 0 ? "sent" : "failed";
      patch.sent_at = now();
    }
    await admin.from("newsletter_campaigns").update(patch).eq("id", campaignId);
    return json({ sent: sent || 0, failed: failed || 0, remaining: remaining || 0, last_error: firstError });
  }

  return json({ error: "Unknown action" }, 400);
});

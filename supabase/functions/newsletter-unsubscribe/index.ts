// newsletter-unsubscribe — backs the unsubscribe link in every Keys99 newsletter.
//
// The link in the email opens unsubscribe.html (a static page hosted with the admin), which
// calls this function. Mail apps' one-click unsubscribe (List-Unsubscribe-Post, RFC 8058)
// POSTs here directly.
//   GET  ?t=<token>  → { email, is_subscribed }            (look up, change nothing)
//   POST ?t=<token>  → { email, is_subscribed: false }     (unsubscribe)
// Public (no JWT): the token is a random UUID unique to each subscriber.
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  let token = url.searchParams.get("t") || "";
  if (!token && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    token = String(body.t || "");
  }
  if (token === "test") return json({ email: "test", is_subscribed: true, test: true });
  if (!/^[0-9a-f-]{36}$/i.test(token)) return json({ error: "This unsubscribe link is incomplete." }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: sub } = await admin.from("newsletter_subscribers").select("id,email,is_subscribed").eq("unsubscribe_token", token).maybeSingle();
  if (!sub) return json({ error: "We couldn't find this subscription. It may already have been removed." }, 404);

  if (req.method === "POST") {
    if (sub.is_subscribed) {
      const now = new Date().toISOString();
      await admin.from("newsletter_subscribers").update({ is_subscribed: false, unsubscribed_at: now, updated_at: now }).eq("id", sub.id);
    }
    return json({ email: sub.email, is_subscribed: false });
  }
  return json({ email: sub.email, is_subscribed: sub.is_subscribed });
});

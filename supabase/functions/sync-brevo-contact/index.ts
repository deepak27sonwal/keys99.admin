// sync-brevo-contact — adds / updates the signed-in website user's own contact in Brevo
// (name, city, interest, subscribed or not). Called by keys99.com with the user's JWT.
//
// Security: a user can only change their OWN contact (the email on their account). Only an
// admin / super_admin may pass a different email — otherwise anyone with an account could
// subscribe, rename or blacklist any address in Brevo.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json"
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  const brevoKey = Deno.env.get("BREVO_API_KEY");
  if (!brevoKey) return json({ error: "BREVO_API_KEY secret is not configured" }, 500);

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Authorization required" }, 401);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (!user) return json({ error: "Invalid session" }, 401);

  const body = await req.json().catch(() => ({}));
  const ownEmail = String(user.email || "").trim().toLowerCase();
  const email = String(body.email || ownEmail).trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ error: "Email is required" }, 400);
  if (email !== ownEmail) {
    const { data: roles } = await admin.from("user_roles").select("role").eq("user_id", user.id);
    if (!(roles || []).some((r) => r.role === "admin" || r.role === "super_admin")) {
      return json({ error: "You can only update your own email." }, 403);
    }
  }

  const clip = (v: unknown) => String(v ?? "").trim().slice(0, 80);
  const fullName = clip(body.full_name);
  const city = clip(body.city);
  const propertyInterest = clip(body.property_interest);
  const source = clip(body.source || "website").slice(0, 40);
  const isSubscribed = body.is_subscribed !== false;

  const attributes: Record<string, string> = {};
  if (fullName) attributes.FULLNAME = fullName;
  if (city) attributes.CITY = city;
  if (propertyInterest) attributes.PROPERTY_INTEREST = propertyInterest;
  if (source) attributes.SOURCE = source;

  const r = await fetch("https://api.brevo.com/v3/contacts", {
    method: "POST",
    headers: { "accept": "application/json", "content-type": "application/json", "api-key": brevoKey },
    body: JSON.stringify({ email, attributes, updateEnabled: true, emailBlacklisted: !isSubscribed })
  });
  if (!r.ok) {
    console.error("Brevo contact sync failed:", r.status, (await r.text()).slice(0, 300));
    return json({ error: "Couldn't update your email preferences just now. Please try again." }, 502);
  }
  return json({ success: true, email });
});

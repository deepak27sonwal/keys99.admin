// subscribe-newsletter — the public "Subscribe" form on keys99.com (no login).
// Saves the address in newsletter_subscribers and adds it to Brevo.
//
// Security: because anyone can call this with any email, it never overwrites what an
// existing subscriber already has (name, city, interest, source) — it only fills blanks —
// so nobody can rename another subscriber (names are merged into newsletters as {{name}}).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json"
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST required" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const brevoKey = Deno.env.get("Brevo_apikey");
  if (!supabaseUrl || !serviceRoleKey || !brevoKey) return json({ error: "Newsletter service is not configured" }, 500);

  const body = await req.json().catch(() => ({}));
  const email = String(body.email || "").trim().toLowerCase();
  const fullName = String(body.full_name || "").trim().slice(0, 80);
  const city = String(body.city || "").trim().slice(0, 80);
  const propertyInterest = String(body.property_interest || "").trim().slice(0, 80);
  const source = String(body.source || "newsletter").trim().slice(0, 40);

  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ error: "Please enter a valid email address." }, 400);

  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const now = new Date().toISOString();
  const { data: existing } = await admin.from("newsletter_subscribers")
    .select("id, full_name, city, property_interest, source").eq("email", email).maybeSingle();

  // What the subscriber ends up with: their existing details win, the form only fills blanks.
  const merged = {
    full_name: existing?.full_name || fullName || null,
    city: existing?.city || city || null,
    property_interest: existing?.property_interest || propertyInterest || null,
    source: existing?.source || source || "newsletter",
  };
  const { error: dbError } = existing
    ? await admin.from("newsletter_subscribers").update({ ...merged, is_subscribed: true, updated_at: now }).eq("id", existing.id)
    : await admin.from("newsletter_subscribers").insert({ email, ...merged, is_subscribed: true, updated_at: now });
  if (dbError) return json({ error: "We couldn't save your subscription. Please try again." }, 500);

  const sendBrevoContact = async (payload: Record<string, unknown>) =>
    fetch("https://api.brevo.com/v3/contacts", {
      method: "POST",
      headers: { "accept": "application/json", "content-type": "application/json", "api-key": brevoKey },
      body: JSON.stringify(payload)
    });

  let brevoResponse = await sendBrevoContact({
    email,
    attributes: { FIRSTNAME: merged.full_name || "", CITY: merged.city || "", PROPERTY_INTEREST: merged.property_interest || "", SOURCE: merged.source },
    updateEnabled: true,
    emailBlacklisted: false
  });

  if (!brevoResponse.ok) {
    console.error("Brevo attribute sync failed:", await brevoResponse.text());
    brevoResponse = await sendBrevoContact({ email, updateEnabled: true, emailBlacklisted: false });
  }

  if (!brevoResponse.ok) {
    console.error("Brevo contact sync failed:", await brevoResponse.text());
    return json({ message: "You're subscribed to Keys99. Your subscription was saved, and email-service syncing will be completed shortly." });
  }

  return json({ success: true, message: "You're subscribed. Welcome to Keys99!" });
});

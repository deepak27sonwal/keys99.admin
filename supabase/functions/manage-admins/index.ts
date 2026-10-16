import { createClient } from "jsr:@supabase/supabase-js@2";

// Lets a super_admin manage the panel's admin accounts (list / create / remove / set_password)
// without ever putting the service-role key in the browser. Every action re-verifies the caller
// is a super_admin using a service-role client here (RLS-bypassing, so it's the source of
// truth), not just trusting the JWT that verify_jwt already checked.
//
// "my_sessions" / "list" / "buyer_overview" also surface active login sessions (auth.sessions,
// one row per signed-in device/browser) via SQL functions whose EXECUTE is granted to
// service_role only — this Edge Function (running with the service-role key) is the only
// caller that can ever reach them.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Turns a raw user_agent string into something an admin can actually recognize at a glance,
// e.g. "Chrome on Windows" instead of the full UA string.
function describeDevice(userAgent: string | null | undefined): string {
  const ua = userAgent || "";
  if (!ua) return "Unknown device";
  let browser = "Unknown browser";
  if (/edg\//i.test(ua)) browser = "Edge";
  else if (/chrome\//i.test(ua) && !/chromium/i.test(ua)) browser = "Chrome";
  else if (/firefox\//i.test(ua)) browser = "Firefox";
  else if (/safari\//i.test(ua) && !/chrome\//i.test(ua)) browser = "Safari";
  else if (/opr\/|opera/i.test(ua)) browser = "Opera";

  let os = "Unknown OS";
  if (/windows/i.test(ua)) os = "Windows";
  else if (/iphone|ipad|ios/i.test(ua)) os = "iOS";
  else if (/mac os x/i.test(ua)) os = "macOS";
  else if (/android/i.test(ua)) os = "Android";
  else if (/linux/i.test(ua)) os = "Linux";

  return `${browser} on ${os}`;
}

function mapDevices(devices: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(devices)) return [];
  return devices.map((d) => {
    const rec = d as Record<string, unknown>;
    return {
      id: rec.id,
      label: describeDevice(rec.user_agent as string | null),
      ip: rec.ip,
      created_at: rec.created_at,
      last_active: rec.last_active,
    };
  });
}

// Same rule the admin page shows: 8–72 characters (bcrypt ignores anything past 72 bytes) with
// a letter and a number. Supabase's own password policy is applied on top by updateUserById.
function passwordProblem(password: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (new TextEncoder().encode(password).length > 72) return "Password must be at most 72 characters.";
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return "Password must contain at least one letter and one number.";
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    if (!token) return json({ error: "Missing authorization" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "Invalid session" }, 401);
    const callerId = userData.user.id;

    const { data: callerRoles } = await admin.from("user_roles").select("role").eq("user_id", callerId);
    const isSuperAdmin = (callerRoles || []).some((r) => r.role === "super_admin");
    const hasAnyRole = (callerRoles || []).length > 0;

    const body = await req.json().catch(() => ({}));
    const action = body.action;

    // Any signed-in admin/super-admin can see their OWN sessions — this doesn't touch other
    // accounts, so it doesn't need the super-admin gate below.
    if (action === "my_sessions") {
      if (!hasAnyRole) return json({ error: "Not an admin account." }, 403);
      const { data: sessions, error } = await admin.rpc("admin_user_sessions", { target_user_ids: [callerId] });
      if (error) return json({ error: error.message }, 400);
      const row = (sessions || [])[0];
      return json({
        session_count: row?.session_count ?? 0,
        devices: mapDevices(row?.devices),
      }, 200);
    }

    // Aggregate "how many buyers are online" for the Analytics section — any admin/super-admin
    // can see this (it's just counts + a recently-active list, no admin-account management),
    // so it only needs hasAnyRole, not the super-admin gate below.
    if (action === "buyer_overview") {
      if (!hasAnyRole) return json({ error: "Not an admin account." }, 403);
      const [{ data: overview, error: ovErr }, { data: recent, error: recentErr }] = await Promise.all([
        admin.rpc("buyer_session_overview"),
        admin.rpc("buyer_sessions_list", { limit_count: 50 }),
      ]);
      if (ovErr) return json({ error: ovErr.message }, 400);
      if (recentErr) return json({ error: recentErr.message }, 400);
      const o = (overview || [])[0] || {};
      return json({
        total_buyers: o.total_buyers ?? 0,
        active_buyers: o.active_buyers ?? 0,
        active_sessions: o.active_sessions ?? 0,
        recent: (recent || []).map((r: any) => ({
          user_id: r.user_id,
          email: r.email,
          full_name: r.full_name,
          session_count: r.session_count,
          last_active: r.last_active,
        })),
      }, 200);
    }

    if (!isSuperAdmin) return json({ error: "Only a super admin can manage admin accounts." }, 403);

    if (action === "list") {
      const { data: roles, error } = await admin
        .from("user_roles")
        .select("id,user_id,role,created_at")
        .in("role", ["admin", "super_admin"])
        .order("created_at");
      if (error) return json({ error: error.message }, 400);

      const userIds = (roles || []).map((r) => r.user_id);
      const { data: sessionRows } = await admin.rpc("admin_user_sessions", { target_user_ids: userIds });
      const sessionsByUser = new Map((sessionRows || []).map((s: any) => [s.user_id, s]));

      const results = [];
      for (const r of roles || []) {
        const { data: u } = await admin.auth.admin.getUserById(r.user_id);
        const s = sessionsByUser.get(r.user_id) as any;
        results.push({
          role_id: r.id,
          user_id: r.user_id,
          role: r.role,
          created_at: r.created_at,
          email: u?.user?.email || null,
          is_self: r.user_id === callerId,
          last_sign_in_at: u?.user?.last_sign_in_at || null,
          session_count: s?.session_count ?? 0,
          last_active: s?.last_active ?? null,
        });
      }
      return json({ admins: results }, 200);
    }

    if (action === "create") {
      const email = String(body.email || "").trim();
      const password = String(body.password || "");
      const fullName = body.full_name ? String(body.full_name).trim() : "";

      if (!email || !password) return json({ error: "Email and password are required." }, 400);
      if (password.length < 8) return json({ error: "Password must be at least 8 characters." }, 400);

      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: fullName ? { full_name: fullName } : {},
      });
      if (createErr) return json({ error: createErr.message }, 400);

      const { error: roleErr } = await admin.from("user_roles").insert({
        user_id: created.user.id,
        role: "admin",
        created_by: callerId,
      });
      if (roleErr) {
        // Don't leave an orphaned login with no role if the role insert fails.
        await admin.auth.admin.deleteUser(created.user.id);
        return json({ error: roleErr.message }, 400);
      }

      return json({ user_id: created.user.id, email: created.user.email }, 200);
    }

    if (action === "remove") {
      const userId = String(body.user_id || "");
      if (!userId) return json({ error: "user_id is required." }, 400);
      if (userId === callerId) return json({ error: "You can't remove your own admin access." }, 400);

      const { data: targetRoles } = await admin.from("user_roles").select("role").eq("user_id", userId);
      if ((targetRoles || []).some((r) => r.role === "super_admin")) {
        return json({ error: "Super admins can't be removed from here." }, 400);
      }

      const { error } = await admin.from("user_roles").delete().eq("user_id", userId).eq("role", "admin");
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true }, 200);
    }

    // A super admin sets a new password for an admin account, or for their own. Other super
    // admins' passwords can't be changed here (they change their own, or use the Supabase
    // dashboard). Signing in still needs the emailed code, so a password alone never gets in.
    if (action === "set_password") {
      const userId = String(body.user_id || "");
      const password = String(body.password || "");
      if (!userId) return json({ error: "user_id is required." }, 400);
      const problem = passwordProblem(password);
      if (problem) return json({ error: problem }, 400);

      const { data: targetRoles } = await admin.from("user_roles").select("role").eq("user_id", userId);
      const targetRoleList = (targetRoles || []).map((r) => r.role);
      const isSelf = userId === callerId;
      if (!isSelf) {
        if (targetRoleList.includes("super_admin")) {
          return json({ error: "Another super admin's password can't be changed from here." }, 403);
        }
        if (!targetRoleList.includes("admin")) {
          return json({ error: "That account isn't an admin." }, 400);
        }
      }

      const { error } = await admin.auth.admin.updateUserById(userId, { password });
      if (error) return json({ error: error.message }, 400);

      // Audit trail (never the password itself). A failure here doesn't undo the change.
      await admin.from("activity_log").insert({
        actor_type: "admin",
        actor_id: callerId,
        action: "admin_password_changed",
        entity_type: "admin_account",
        entity_id: userId,
        metadata: { self: isSelf },
      });

      return json({ ok: true }, 200);
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error." }, 500);
  }
});

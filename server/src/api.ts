// The dashboard's API (/api/app): regions and imports, API keys, settings, usage, the playground, and
// the usual account pages. Everyone signed in can look; only admins change anything.

import { Hono, type Context } from "hono";
import { sql } from "./db.ts";
import { APP_VERSION, IMPORT_WORKERS, UPDATE_CHECK, oidc } from "./config.ts";
import { requireAdmin, requireUser, signOutEverywhere, type AppEnv } from "./auth.ts";
import { sha256 } from "./crypto.ts";
import { HttpError, bad, body, rateLimit, str } from "./http.ts";
import { RELEASES_URL, updateStatus } from "./updates.ts";
import { USERNAME, getUser, isRole, meView } from "./users.ts";
import { forgetKeys, latencyStats, newKey, type ApiKey } from "./access.ts";
import { ENDPOINTS, settings, updateSettings } from "./settings.ts";
import { find, reverse, toResults } from "./geocode.ts";
import { catalog } from "./import/catalog.ts";
import { cancel, enqueue, liveProgress, remove } from "./import/jobs.ts";
import { regionSizes } from "./import/run.ts";
import { cacheStats, resetCache } from "./cache.ts";
import { places } from "./places.ts";

export const api = new Hono<AppEnv>();

api.use("*", requireUser);

/** Changes: admins only. */
const admin = requireAdmin;
/** The route's :id (Hono loses its type behind a middleware). */
const idOf = (c: Context) => c.req.param("id") ?? "";

// ---------- Overview ----------

api.get("/overview", async (c) => {
  // Usage rolled up three ways, each window twice as long as the chart shows, so a period can be
  // compared with the one before it: 60 days, 52 weeks (ISO, from Monday), 24 months.
  const [[totals], daily, weekly, monthly, topKeys, [keys]] = await Promise.all([
    sql`
      SELECT count(*)::int AS regions, coalesce(sum(features), 0)::int AS features, coalesce(sum(addresses), 0)::int AS addresses,
             pg_database_size(current_database())::float8 AS database_bytes
      FROM regions WHERE imported_at IS NOT NULL`,
    sql`
      SELECT day::text AS period, endpoint, sum(requests)::int AS requests, sum(errors)::int AS errors
      FROM api_usage WHERE day > current_date - 60 GROUP BY 1, 2 ORDER BY 1`,
    sql`
      SELECT date_trunc('week', day)::date::text AS period, endpoint, sum(requests)::int AS requests, sum(errors)::int AS errors
      FROM api_usage WHERE day >= date_trunc('week', current_date) - interval '51 weeks' GROUP BY 1, 2 ORDER BY 1`,
    sql`
      SELECT date_trunc('month', day)::date::text AS period, endpoint, sum(requests)::int AS requests, sum(errors)::int AS errors
      FROM api_usage WHERE day >= date_trunc('month', current_date) - interval '23 months' GROUP BY 1, 2 ORDER BY 1`,
    sql`
      SELECT u.key_id AS id, k.name, k.prefix, sum(u.requests)::int AS requests, sum(u.errors)::int AS errors
      FROM api_usage u LEFT JOIN api_keys k ON k.id = u.key_id
      WHERE u.day > current_date - 30 GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 6`,
    sql`SELECT count(*)::int AS total, count(*) FILTER (WHERE NOT disabled AND (expires_at IS NULL OR expires_at > now()))::int AS active FROM api_keys`,
  ]);
  return c.json({ totals, usage: { daily, weekly, monthly }, topKeys, keys, latency: latencyStats(), job: liveProgress() });
});

// ---------- Regions, the catalog, imports ----------

api.get("/regions", async (c) => {
  // The countries a region holds, from its own country and state areas (a few rows each, by index).
  const [regions, sizes] = await Promise.all([
    sql`
      SELECT r.*, array(
        SELECT DISTINCT f.country_code FROM features f
        WHERE f.region = r.id AND f.layer IN ('country', 'state') AND f.country_code IS NOT NULL ORDER BY 1
      ) AS countries
      FROM regions r ORDER BY r.name`,
    regionSizes(),
  ]);
  return c.json(regions.map((r) => ({ ...r, bytes: sizes[r.id as string] ?? 0 })));
});

api.get("/catalog", async (c) => {
  const refresh = c.req.query("refresh") === "1";
  if (refresh) rateLimit(c, "catalog", 10, 60 * 60_000);
  return c.json(await catalog(refresh));
});

api.post("/regions/:id/install", admin, async (c) => {
  const b = await body(c).catch(() => ({}) as Record<string, unknown>);
  const languages = Array.isArray(b.languages) ? b.languages.filter((l): l is string => typeof l === "string" && /^[a-z]{2,3}$/.test(l)) : undefined;
  const houseNumbers = typeof b.houseNumbers === "boolean" ? b.houseNumbers : undefined;
  return c.json(await enqueue(idOf(c), c.get("user").id, { languages, houseNumbers }), 201);
});

api.patch("/regions/:id", admin, async (c) => {
  const b = await body(c);
  if (typeof b.autoUpdate !== "boolean") throw bad();
  await sql`UPDATE regions SET auto_update = ${b.autoUpdate} WHERE id = ${idOf(c)}`;
  return c.json({ ok: true });
});

api.delete("/regions/:id", admin, async (c) => {
  await remove(idOf(c));
  return c.json({ ok: true });
});

api.get("/jobs", async (c) => {
  const jobs = await sql`SELECT * FROM jobs ORDER BY id DESC LIMIT 50`;
  const live = liveProgress();
  return c.json(jobs.map((j) => (live && j.id === String(live.id) ? { ...j, progress: live.progress ?? j.progress } : j)));
});

api.post("/jobs/:id/cancel", admin, async (c) => {
  await cancel(Number(idOf(c)));
  return c.json({ ok: true });
});

// ---------- API keys ----------

const KEY_COLUMNS = sql`id, name, prefix, scopes, rate_per_minute, daily_quota, origins, ips, expires_at, disabled, created_by, created_at, last_used_at`;

api.get("/keys", async (c) => {
  const keys = await sql<(ApiKey & { requestsToday: number; requests30d: number })[]>`
    SELECT ${KEY_COLUMNS},
      (SELECT coalesce(sum(requests), 0)::int FROM api_usage u WHERE u.key_id = k.id AND u.day = current_date) AS requests_today,
      (SELECT coalesce(sum(requests), 0)::int FROM api_usage u WHERE u.key_id = k.id AND u.day > current_date - 30) AS requests_30d
    FROM api_keys k ORDER BY created_at DESC`;
  return c.json(keys);
});

function keyFields(b: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  if (b.name !== undefined) {
    out.name = str(b.name, 80);
    if (!out.name) throw bad("Give the key a name");
  }
  if (b.scopes !== undefined) {
    if (!Array.isArray(b.scopes) || !b.scopes.every((s) => (ENDPOINTS as readonly unknown[]).includes(s))) throw bad("Unknown endpoint in scopes");
    out.scopes = [...new Set(b.scopes as string[])];
  }
  for (const [k, max] of [["ratePerMinute", 1_000_000], ["dailyQuota", 100_000_000]] as const) {
    if (b[k] === undefined) continue;
    if (b[k] === null || b[k] === "") out[k] = null;
    else {
      const n = Number(b[k]);
      if (!Number.isInteger(n) || n < 1 || n > max) throw bad(`${k === "ratePerMinute" ? "Requests per minute" : "Daily quota"} should be between 1 and ${max}`);
      out[k] = n;
    }
  }
  if (b.origins !== undefined) {
    if (!Array.isArray(b.origins) || !b.origins.every((o) => typeof o === "string" && /^https?:\/\/[^/\s]+$/.test(o))) throw bad("Websites look like https://example.com");
    out.origins = [...new Set(b.origins as string[])];
  }
  if (b.ips !== undefined) {
    if (!Array.isArray(b.ips) || !b.ips.every((ip) => typeof ip === "string" && /^[0-9a-fA-F:.]{3,45}$/.test(ip))) throw bad("IP addresses aren't valid");
    out.ips = [...new Set(b.ips as string[])];
  }
  if (b.expiresAt !== undefined) {
    if (b.expiresAt === null || b.expiresAt === "") out.expiresAt = null;
    else {
      const d = new Date(String(b.expiresAt));
      if (Number.isNaN(d.getTime())) throw bad("Expiry date isn't valid");
      out.expiresAt = d;
    }
  }
  if (b.disabled !== undefined) {
    if (typeof b.disabled !== "boolean") throw bad();
    out.disabled = b.disabled;
  }
  return out;
}

api.post("/keys", admin, async (c) => {
  rateLimit(c, "new-key", 50, 60 * 60_000);
  const f = keyFields(await body(c));
  if (!f.name) throw bad("Give the key a name");
  const { key, hash, prefix } = newKey();
  const [row] = await sql`
    INSERT INTO api_keys (id, name, prefix, key_hash, scopes, rate_per_minute, daily_quota, origins, ips, expires_at, created_by)
    VALUES (${sha256(key).slice(0, 16)}, ${f.name as string}, ${prefix}, ${hash}, ${(f.scopes as string[]) ?? []}, ${(f.ratePerMinute as number) ?? null},
            ${(f.dailyQuota as number) ?? null}, ${(f.origins as string[]) ?? []}, ${(f.ips as string[]) ?? []}, ${(f.expiresAt as Date) ?? null}, ${c.get("user").id})
    RETURNING ${KEY_COLUMNS}`;
  // The key itself is only ever in this response.
  return c.json({ ...row, key }, 201);
});

api.patch("/keys/:id", admin, async (c) => {
  const f = keyFields(await body(c));
  const columns: Record<string, string> = { name: "name", scopes: "scopes", ratePerMinute: "rate_per_minute", dailyQuota: "daily_quota", origins: "origins", ips: "ips", expiresAt: "expires_at", disabled: "disabled" };
  for (const [k, v] of Object.entries(f)) await sql`UPDATE api_keys SET ${sql(columns[k])} = ${v as never} WHERE id = ${idOf(c)}`;
  forgetKeys();
  const [row] = await sql`SELECT ${KEY_COLUMNS} FROM api_keys WHERE id = ${idOf(c)}`;
  if (!row) throw new HttpError(404, "This key doesn't exist any more");
  return c.json(row);
});

api.delete("/keys/:id", admin, async (c) => {
  await sql`DELETE FROM api_keys WHERE id = ${idOf(c)}`;
  forgetKeys();
  return c.json({ ok: true });
});

// ---------- Settings ----------

api.get("/settings", (c) => c.json(settings()));

api.patch("/settings/:section", admin, async (c) => c.json(await updateSettings(c.req.param("section") ?? "", await body(c))));

// ---------- Custom places, the response cache ----------

api.route("/places", places);

api.get("/cache", (c) => c.json(cacheStats()));

api.post("/cache/clear", admin, (c) => {
  resetCache();
  return c.json(cacheStats());
});

// ---------- Playground: the API without keys or limits, for whoever is signed in ----------

api.get("/try/:mode", async (c) => {
  rateLimit(c, "try", 1200, 60_000);
  const mode = c.req.param("mode");
  const lang = c.req.query("lang") || settings().results.defaultLanguage;
  const started = performance.now();
  let hits;
  if (mode === "reverse") {
    const lat = Number(c.req.query("lat"));
    const lon = Number(c.req.query("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw bad("lat and lon are required");
    hits = await reverse(lat, lon, { radius: c.req.query("radius") ? Number(c.req.query("radius")) : undefined, viewer: "all" });
  } else if (mode === "autocomplete" || mode === "search") {
    const q = c.req.query("q")?.trim();
    if (!q) return c.json({ results: [], ms: 0 });
    const lat = Number(c.req.query("lat"));
    const lon = Number(c.req.query("lon"));
    const near = c.req.query("lat") && Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : undefined;
    hits = await find(q, { near, limit: c.req.query("limit") ? Number(c.req.query("limit")) : undefined, viewer: "all" }, mode === "autocomplete");
  } else throw new HttpError(404, "Not found");
  return c.json({ results: toResults(hits, lang), ms: Math.round((performance.now() - started) * 10) / 10 });
});

// ---------- Profile ----------

api.patch("/profile", async (c) => {
  const user = c.get("user");
  const b = await body(c);
  if (b.name !== undefined) await sql`UPDATE users SET name = ${str(b.name, 100)} WHERE id = ${user.id}`;
  if (b.email !== undefined) {
    const email = str(b.email, 255).toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad("That email doesn't look right");
    if (email) {
      const [taken] = await sql`SELECT 1 FROM users WHERE lower(email) = ${email} AND id <> ${user.id}`;
      if (taken) throw new HttpError(409, "Another account uses that email");
    }
    await sql`UPDATE users SET email = ${email || null} WHERE id = ${user.id}`;
  }
  return c.json(meView((await getUser(user.id))!));
});

api.post("/profile/delete-account", async (c) => {
  const user = c.get("user");
  const b = await body(c);
  if (str(b.confirm) !== user.id) throw bad("Type your username to confirm");
  if (user.role === "admin") {
    const [{ count }] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM users WHERE role = 'admin' AND id <> ${user.id}`;
    if (count === 0) throw bad("You're the only admin. Make someone else an admin first.");
  }
  await sql`DELETE FROM users WHERE id = ${user.id}`;
  return c.json({ ok: true });
});

// ---------- Sessions ----------

api.get("/sessions", async (c) => {
  const current = c.get("session").id;
  const rows = await sql<{ id: string; method: string; userAgent: string; ip: string; createdAt: Date; lastSeenAt: Date }[]>`
    SELECT id, method, user_agent, ip, created_at, last_seen_at FROM sessions
    WHERE user_id = ${c.get("user").id} AND expires_at > now() ORDER BY last_seen_at DESC`;
  return c.json(rows.map((r) => ({ ...r, id: sha256(r.id).slice(0, 24), current: r.id === current })));
});

api.delete("/sessions/:id", async (c) => {
  const user = c.get("user");
  const rows = await sql<{ id: string }[]>`SELECT id FROM sessions WHERE user_id = ${user.id}`;
  const target = rows.find((r) => sha256(r.id).slice(0, 24) === idOf(c));
  if (target) await sql`DELETE FROM sessions WHERE id = ${target.id}`;
  return c.json({ ok: true });
});

api.post("/sessions/revoke-others", async (c) => {
  await signOutEverywhere(c.get("user").id, c.get("session").id);
  return c.json({ ok: true });
});

// ---------- Server ----------

api.get("/server", (c) =>
  c.json({
    oidc: oidc ? { name: oidc.name, adminGroups: oidc.adminGroups.length > 0 } : null,
    version: APP_VERSION,
    importWorkers: IMPORT_WORKERS,
    publicUrl: new URL(c.req.url).origin,
  }),
);

api.get("/updates", async (c) => {
  if (!UPDATE_CHECK) return c.json({ current: APP_VERSION, latest: null, available: false, releasesUrl: RELEASES_URL, checkedAt: null, disabled: true });
  const refresh = c.req.query("refresh") === "1";
  if (refresh) rateLimit(c, "update-check", 10, 60 * 60_000);
  return c.json(await updateStatus(refresh));
});

// ---------- Users (admins) ----------

const GROUP_MANAGED = "Admins come from your identity provider's groups: add or remove them there.";
const groupManaged = () => !!oidc && oidc.adminGroups.length > 0;

const users = new Hono<AppEnv>();
users.use("*", requireAdmin);

users.get("/", async (c) =>
  c.json(await sql`SELECT id, name, email, role, (oidc_sub IS NOT NULL) AS sso_linked, created_at, last_seen_at FROM users ORDER BY created_at`),
);

users.post("/", async (c) => {
  const b = await body(c);
  const id = str(b.username, 63);
  const email = str(b.email, 255).toLowerCase() || null;
  if (!USERNAME.test(id)) throw bad("Usernames use letters, numbers, dots, dashes and underscores.");
  const [taken] = await sql`SELECT 1 FROM users WHERE lower(id) = lower(${id}) OR (${email}::text IS NOT NULL AND lower(email) = ${email})`;
  if (taken) throw new HttpError(409, "That username or email is taken");
  const role = b.role === undefined ? "user" : b.role;
  if (!isRole(role)) throw bad("Pick a role: user or admin");
  if (role === "admin" && groupManaged()) throw bad(GROUP_MANAGED);
  await sql`INSERT INTO users (id, name, email, role) VALUES (${id}, ${str(b.name, 100)}, ${email}, ${role})`;
  return c.json({ ok: true }, 201);
});

users.patch("/:id", async (c) => {
  const b = await body(c);
  const id = idOf(c);
  if (b.role !== undefined) {
    if (!isRole(b.role)) throw bad("Pick a role: user or admin");
    if (id === c.get("user").id) throw bad("You can't change your own role");
    const target = await getUser(id);
    if (!target) throw new HttpError(404, "This user doesn't exist anymore");
    if (b.role !== target.role && groupManaged()) throw bad(GROUP_MANAGED);
    await sql`UPDATE users SET role = ${b.role} WHERE id = ${id}`;
  }
  if (b.signOut === true) await signOutEverywhere(id);
  return c.json({ ok: true });
});

users.delete("/:id", async (c) => {
  const id = idOf(c);
  if (id === c.get("user").id) throw bad("Delete your own account from your profile");
  await sql`DELETE FROM users WHERE id = ${id}`;
  return c.json({ ok: true });
});

api.route("/admin/users", users);

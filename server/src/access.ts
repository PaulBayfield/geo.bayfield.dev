// Who may call the geocoding API: API keys, the "require a key" switches, rate limits, quotas, CORS.
// Also counts requests (per day, key and endpoint) and keeps recent response times for the dashboard.

import type { Context } from "hono";
import { sql } from "./db.ts";
import { randomToken, sha256 } from "./crypto.ts";
import { HttpError, clientIp } from "./http.ts";
import { settings, type Endpoint } from "./settings.ts";

export const KEY_PREFIX = "geo_";

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  ratePerMinute: number | null;
  dailyQuota: number | null;
  origins: string[];
  ips: string[];
  expiresAt: Date | null;
  disabled: boolean;
  createdBy: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/** A new key: the key itself only comes back here, the database keeps its hash. */
export function newKey() {
  const key = KEY_PREFIX + randomToken(24);
  return { key, hash: sha256(key), prefix: key.slice(0, KEY_PREFIX.length + 6) };
}

// ---------- Key lookup (cached briefly: every request checks one) ----------

const keyCache = new Map<string, { key: ApiKey | null; until: number }>();

async function findKey(hash: string): Promise<ApiKey | null> {
  const hit = keyCache.get(hash);
  if (hit && hit.until > Date.now()) return hit.key;
  const [key] = await sql<ApiKey[]>`SELECT * FROM api_keys WHERE key_hash = ${hash}`;
  keyCache.set(hash, { key: key ?? null, until: Date.now() + 30_000 });
  if (keyCache.size > 5000) keyCache.clear();
  return key ?? null;
}

/** After a key changes in the dashboard: forget what was cached. */
export const forgetKeys = () => keyCache.clear();

// ---------- Sliding-window rate limits ----------

const windows = new Map<string, number[]>();

function allow(bucket: string, perMinute: number): boolean {
  if (!perMinute) return true;
  const now = Date.now();
  const recent = (windows.get(bucket) ?? []).filter((t) => t > now - 60_000);
  if (recent.length >= perMinute) {
    windows.set(bucket, recent);
    return false;
  }
  recent.push(now);
  windows.set(bucket, recent);
  if (windows.size > 50_000) for (const [k, times] of windows) if (times[times.length - 1] < now - 60_000) windows.delete(k);
  return true;
}

// ---------- Usage: counted in memory, written every few seconds ----------

const today = () => new Date().toISOString().slice(0, 10);
const pending = new Map<string, { day: string; keyId: string; endpoint: string; requests: number; errors: number }>();
/** Today's requests per key, for daily quotas (loaded lazily, then counted here). */
const dailyCounts = new Map<string, number>();
let countsDay = today();

function count(keyId: string, endpoint: string, error: boolean) {
  const day = today();
  if (day !== countsDay) {
    dailyCounts.clear();
    countsDay = day;
  }
  const id = `${day}|${keyId}|${endpoint}`;
  const row = pending.get(id) ?? { day, keyId, endpoint, requests: 0, errors: 0 };
  row.requests++;
  if (error) row.errors++;
  pending.set(id, row);
}

export async function flushUsage() {
  if (!pending.size) return;
  const rows = [...pending.values()];
  pending.clear();
  for (const r of rows) {
    await sql`
      INSERT INTO api_usage (day, key_id, endpoint, requests, errors) VALUES (${r.day}, ${r.keyId}, ${r.endpoint}, ${r.requests}, ${r.errors})
      ON CONFLICT (day, key_id, endpoint) DO UPDATE SET requests = api_usage.requests + excluded.requests, errors = api_usage.errors + excluded.errors`;
  }
  const used = [...new Set(rows.map((r) => r.keyId).filter(Boolean))];
  if (used.length) await sql`UPDATE api_keys SET last_used_at = now() WHERE id = ANY(${used})`;
}

async function usedToday(keyId: string): Promise<number> {
  if (!dailyCounts.has(keyId)) {
    const [row] = await sql<{ n: number }[]>`SELECT coalesce(sum(requests), 0)::int AS n FROM api_usage WHERE day = ${today()} AND key_id = ${keyId}`;
    const unflushed = [...pending.values()].filter((p) => p.keyId === keyId).reduce((n, p) => n + p.requests, 0);
    dailyCounts.set(keyId, (row?.n ?? 0) + unflushed);
  }
  return dailyCounts.get(keyId)!;
}

// ---------- Response times (last 1000 per endpoint), for p50/p95 ----------

const latencies = new Map<string, number[]>();

export function recordLatency(endpoint: string, ms: number) {
  const list = latencies.get(endpoint) ?? [];
  list.push(ms);
  if (list.length > 1000) list.shift();
  latencies.set(endpoint, list);
}

export function latencyStats() {
  const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? null;
  return Object.fromEntries(
    [...latencies].map(([endpoint, list]) => {
      const sorted = [...list].sort((a, b) => a - b);
      return [endpoint, { samples: sorted.length, p50: pct(sorted, 0.5), p95: pct(sorted, 0.95), max: sorted.at(-1) ?? null }];
    }),
  );
}

// ---------- The check, on every geocoding request ----------

export interface Caller {
  key: ApiKey | null;
}

const keyFrom = (c: Context) => c.req.header("X-API-Key")?.trim() || c.req.query("api_key")?.trim() || null;

/** Throws 401/403/429 when the request isn't allowed; otherwise who's calling. */
export async function authorize(c: Context, endpoint: Endpoint): Promise<Caller> {
  const s = settings().access;
  const raw = keyFrom(c);
  const ip = clientIp(c);

  if (!raw) {
    if (s.requireKey || s.requireKeyFor.includes(endpoint)) throw new HttpError(401, "An API key is required: send it in the X-API-Key header");
    if (!allow(`ip:${ip}`, s.ipPerMinute)) throw new HttpError(429, "Too many requests, slow down");
    return { key: null };
  }

  const key = await findKey(sha256(raw));
  if (!key || key.disabled) throw new HttpError(401, "This API key isn't valid");
  if (key.expiresAt && key.expiresAt < new Date()) throw new HttpError(401, "This API key has expired");
  if (key.scopes.length && !key.scopes.includes(endpoint)) throw new HttpError(403, `This API key can't use ${endpoint}`);
  if (key.ips.length && !key.ips.includes(ip)) throw new HttpError(403, "This API key can't be used from this address");
  if (key.origins.length) {
    const origin = c.req.header("Origin");
    if (origin && !key.origins.includes(origin)) throw new HttpError(403, "This API key can't be used from this website");
  }
  if (!allow(`key:${key.id}`, key.ratePerMinute ?? s.keyPerMinute)) throw new HttpError(429, "Too many requests for this key, slow down");
  if (key.dailyQuota !== null && (await usedToday(key.id)) >= key.dailyQuota) throw new HttpError(429, "This API key's daily quota is used up");
  return { key };
}

/** Counts a finished request (and its time). */
export function track(caller: Caller | null, endpoint: Endpoint, ms: number, error: boolean) {
  const keyId = caller?.key?.id ?? "";
  count(keyId, endpoint, error);
  if (keyId) dailyCounts.set(keyId, (dailyCounts.get(keyId) ?? 0) + 1);
  if (!error) recordLatency(endpoint, ms);
}

/** CORS headers for the API, from the allowed websites (and the key's own list). */
export function corsOrigin(c: Context): string | null {
  const origin = c.req.header("Origin");
  if (!origin) return null;
  const allowed = settings().access.corsOrigins;
  if (allowed.includes("*")) return "*";
  return allowed.includes(origin) ? origin : null;
}

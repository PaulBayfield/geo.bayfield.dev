// The public geocoding API.
//
//   GET /v1/autocomplete  ?q=&limit=&lat=&lon=&lang=&layers=&countries=&bbox=&tags=
//   GET /v1/search        same parameters, whole words only
//   GET /v1/reverse       ?lat=&lon=&radius=(m)&limit=&lang=&layers=
//   GET /api              Photon's search (q, limit, lat, lon, lang, layer, osm_tag, bbox)
//   GET /reverse          Photon's reverse (lat, lon, limit, radius in km, lang, layer)
//   GET /v1/status        the regions served, and whether a key is required
//
// Every endpoint goes through access.ts first: API key (when required), scopes, rate limits, quotas.

import { Hono, type Context } from "hono";
import { authorize, corsOrigin, track, type Caller } from "./access.ts";
import { find, limitOf, reverse, toPhoton, toResults, type Filters } from "./geocode.ts";
import { bad } from "./http.ts";
import { sql } from "./db.ts";
import { settings, type Endpoint } from "./settings.ts";

export const geo = new Hono();

// ---------- Parameters ----------

const listParam = (c: Context, name: string): string[] => {
  const all = c.req.queries(name) ?? [];
  return all.flatMap((v) => v.split(",")).map((s) => s.trim()).filter(Boolean);
};

function number(c: Context, name: string, min: number, max: number): number | undefined {
  const v = c.req.query(name);
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${name} should be a number between ${min} and ${max}`);
  return n;
}

function point(c: Context, required: boolean) {
  const lat = number(c, "lat", -90, 90);
  const lon = number(c, "lon", -180, 180);
  if (lat === undefined || lon === undefined) {
    if (required) throw bad("lat and lon are required");
    return undefined;
  }
  return { lat, lon };
}

function bbox(c: Context): Filters["bbox"] {
  const v = c.req.query("bbox");
  if (!v) return undefined;
  const parts = v.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) throw bad("bbox is west,south,east,north");
  return parts as [number, number, number, number];
}

const lang = (c: Context) => {
  const l = c.req.query("lang")?.toLowerCase().slice(0, 3);
  return l && /^[a-z]{2,3}$/.test(l) ? l : settings().results.defaultLanguage;
};

function filters(c: Context, layerParam: string, tagParam: string): Filters {
  return {
    limit: number(c, "limit", 1, 1000),
    near: point(c, false),
    layers: listParam(c, layerParam),
    countries: listParam(c, "countries").map((s) => s.toLowerCase()),
    bbox: bbox(c),
    tags: listParam(c, tagParam).filter((t) => /^!?[\w-]+(:[\w-]+)?$/.test(t)),
  };
}

// ---------- One handler around every endpoint: access, CORS, timing, counting ----------

function endpoint(name: Endpoint, run: (c: Context) => Promise<unknown>) {
  return async (c: Context) => {
    const started = performance.now();
    const origin = corsOrigin(c);
    if (origin) {
      c.header("Access-Control-Allow-Origin", origin);
      if (origin !== "*") c.header("Vary", "Origin");
    }
    let caller: Caller | null = null;
    try {
      caller = await authorize(c, name);
      const body = await run(c);
      const ms = performance.now() - started;
      track(caller, name, ms, false);
      c.header("Server-Timing", `geo;dur=${ms.toFixed(1)}`);
      c.header("Cache-Control", "no-store");
      return c.json(body as object);
    } catch (e) {
      track(caller, name, performance.now() - started, true);
      throw e;
    }
  };
}

geo.options("*", (c) => {
  const origin = corsOrigin(c);
  if (origin) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    c.header("Access-Control-Allow-Headers", "X-API-Key, Content-Type");
    c.header("Access-Control-Max-Age", "86400");
  }
  return c.body(null, 204);
});

const query = (c: Context) => {
  const q = c.req.query("q")?.trim() ?? "";
  if (!q) throw bad("q is required");
  if (q.length > 300) throw bad("q is too long");
  return q;
};

// ---------- GeoPol's API ----------

geo.get(
  "/v1/autocomplete",
  endpoint("autocomplete", async (c) => {
    const l = lang(c);
    return { results: toResults(await find(query(c), filters(c, "layers", "tags"), true), l) };
  }),
);

geo.get(
  "/v1/search",
  endpoint("search", async (c) => {
    const l = lang(c);
    return { results: toResults(await find(query(c), filters(c, "layers", "tags"), false), l) };
  }),
);

geo.get(
  "/v1/reverse",
  endpoint("reverse", async (c) => {
    const p = point(c, true)!;
    const hits = await reverse(p.lat, p.lon, { radius: number(c, "radius", 1, 100_000), limit: limitOf(number(c, "limit", 1, 1000) ?? 10), layers: listParam(c, "layers") });
    return { results: toResults(hits, lang(c)) };
  }),
);

// ---------- Photon-compatible: gps, llip, concerts and maps only change the URL ----------

geo.get(
  "/api",
  endpoint("photon", async (c) => toPhoton(await find(query(c), filters(c, "layer", "osm_tag"), true), lang(c))),
);

geo.get(
  "/reverse",
  endpoint("photon", async (c) => {
    const p = point(c, true)!;
    // Photon's radius is in kilometres.
    const km = number(c, "radius", 0.001, 100);
    const hits = await reverse(p.lat, p.lon, { radius: km !== undefined ? km * 1000 : undefined, limit: limitOf(number(c, "limit", 1, 1000) ?? 1), layers: listParam(c, "layer") });
    return toPhoton(hits, lang(c));
  }),
);

// ---------- Status (no key needed) ----------

geo.get("/v1/status", async (c) => {
  const origin = corsOrigin(c);
  if (origin) c.header("Access-Control-Allow-Origin", origin);
  const regions = await sql`SELECT id, name, dump_date, imported_at, features, addresses FROM regions WHERE imported_at IS NOT NULL ORDER BY name`;
  const a = settings().access;
  return c.json({ ok: true, keyRequired: a.requireKey ? ["autocomplete", "search", "reverse", "photon"] : a.requireKeyFor, regions });
});


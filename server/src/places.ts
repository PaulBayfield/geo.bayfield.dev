// Custom places: added in the dashboard, kept in the features table's "custom" partition (see db.ts
// migration 3), so every endpoint finds them like an imported place. Their OSM type is "X" and their
// id their own number ("X12"). Region imports and removals never touch them.
//
// A place can be private: only requests made with one of its API keys find it (others, and requests
// without a key, don't see it at all). The dashboard's playground always does.

import { Hono, type Context } from "hono";
import { requireAdmin, type AppEnv } from "./auth.ts";
import { clearCache } from "./cache.ts";
import { CUSTOM_REGION, LAYERS, sql } from "./db.ts";
import { HttpError, bad, body, str } from "./http.ts";

export interface CustomPlace {
  id: string;
  name: string;
  altNames: string[];
  layer: string;
  osmKey: string;
  osmValue: string;
  housenumber: string | null;
  street: string | null;
  postcode: string | null;
  district: string | null;
  city: string | null;
  state: string | null;
  countryCode: string | null;
  importance: number;
  lat: number;
  lon: number;
  note: string;
  /** Private: only these API keys (ids) find it. Empty: everyone. */
  keys: string[];
  updatedBy: string | null;
  updatedAt: string | null;
}

const COLUMNS = sql`
  id::text, name, coalesce(names->'alt', '[]'::jsonb) AS alt_names, layer, osm_key, osm_value, housenumber, street, postcode,
  district, city, state, country_code, importance, ST_Y(centroid) AS lat, ST_X(centroid) AS lon,
  coalesce(extra->>'note', '') AS note, coalesce(extra->'keys', '[]'::jsonb) AS keys, extra->>'updatedBy' AS updated_by, extra->>'updatedAt' AS updated_at`;

// ---------- Private places: which keys may see them (kept in memory, checked on every result) ----------

let restricted = new Map<string, Set<string>>();

/** The keys allowed to see the custom place `id` (its number), or null when everyone may. */
export const allowedKeys = (id: string): Set<string> | null => restricted.get(id) ?? null;

export async function loadRestrictions() {
  const rows = await sql<{ id: string; keys: string[] }[]>`
    SELECT id::text, extra->'keys' AS keys FROM features
    WHERE region = ${CUSTOM_REGION} AND jsonb_array_length(coalesce(extra->'keys', '[]'::jsonb)) > 0`;
  restricted = new Map(rows.map((r) => [r.id, new Set(r.keys)]));
}

/** API key ids, checked against the keys that exist. */
async function keyIds(v: unknown): Promise<string[]> {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((k) => typeof k === "string")) throw bad("Keys aren't valid");
  const ids = [...new Set(v as string[])];
  if (!ids.length) return [];
  const found = await sql<{ id: string }[]>`SELECT id FROM api_keys WHERE id = ANY(${ids})`;
  if (found.length !== ids.length) throw bad("One of the keys doesn't exist any more");
  return ids;
}

export async function listPlaces(): Promise<CustomPlace[]> {
  return sql<CustomPlace[]>`SELECT ${COLUMNS} FROM features WHERE region = ${CUSTOM_REGION} ORDER BY lower(name), id`;
}

const optional = (v: unknown, max: number) => {
  const s = str(v, max);
  return s ? s : null;
};

/** Checks a place sent by the dashboard. */
function fields(b: Record<string, unknown>) {
  const name = str(b.name, 200);
  if (!name) throw bad("Give the place a name");
  const lat = Number(b.lat);
  const lon = Number(b.lon);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) throw bad("Pick the place on the map (or type its latitude and longitude)");
  const layer = String(b.layer ?? "house");
  if (!(LAYERS as readonly string[]).includes(layer)) throw bad("Unknown layer");
  // "amenity=cafe": the OSM tag clients may filter on (?tags=amenity:cafe).
  const [osmKey, osmValue] = String(b.category ?? "").trim() ? String(b.category).trim().split("=").map((s) => s.trim()) : ["geopol", "custom"];
  if (!/^[\w:-]{1,60}$/.test(osmKey ?? "") || !/^[\w:-]{1,60}$/.test(osmValue ?? "")) throw bad("The category looks like key=value, e.g. amenity=cafe");
  const altNames = Array.isArray(b.altNames) ? [...new Set(b.altNames.map((n) => str(n, 200)).filter(Boolean))].slice(0, 20) : [];
  const importance = b.importance === undefined ? 0.5 : Number(b.importance);
  if (!Number.isFinite(importance) || importance < 0 || importance > 1) throw bad("Importance should be between 0 and 1");
  const cc = optional(b.countryCode, 2)?.toLowerCase() ?? null;
  if (cc && !/^[a-z]{2}$/.test(cc)) throw bad("The country is a two-letter code (fr, be…)");
  return {
    name,
    names: altNames.length ? { alt: altNames } : {},
    layer,
    osmKey: osmKey!,
    osmValue: osmValue!,
    housenumber: optional(b.housenumber, 20),
    street: optional(b.street, 200),
    postcode: optional(b.postcode, 20),
    district: optional(b.district, 200),
    city: optional(b.city, 200),
    state: optional(b.state, 200),
    countryCode: cc,
    importance,
    lat,
    lon,
    note: str(b.note, 500),
  };
}

export const places = new Hono<AppEnv>();

places.get("/", async (c) => c.json(await listPlaces()));

places.post("/", requireAdmin, async (c) => {
  const b = await body(c);
  const f = fields(b);
  const keys = await keyIds(b.keys);
  const [{ id }] = await sql<{ id: string }[]>`SELECT nextval('custom_places_seq')::text AS id`;
  const extra = { note: f.note, keys, updatedBy: c.get("user").id, updatedAt: new Date().toISOString() };
  await sql`
    INSERT INTO features (id, region, osm_type, osm_id, osm_key, osm_value, layer, importance, country_code, name, names,
                          housenumber, street, postcode, district, city, state, extra, centroid)
    VALUES (${id}, ${CUSTOM_REGION}, 'X', ${id}, ${f.osmKey}, ${f.osmValue}, ${f.layer}, ${f.importance}, ${f.countryCode}, ${f.name}, ${sql.json(f.names)},
            ${f.housenumber}, ${f.street}, ${f.postcode}, ${f.district}, ${f.city}, ${f.state}, ${sql.json(extra)},
            ST_SetSRID(ST_MakePoint(${f.lon}, ${f.lat}), 4326))`;
  await loadRestrictions();
  clearCache();
  const [row] = await sql<CustomPlace[]>`SELECT ${COLUMNS} FROM features WHERE region = ${CUSTOM_REGION} AND id = ${id}`;
  return c.json(row, 201);
});

const idOf = (c: Context) => {
  const id = c.req.param("id") ?? "";
  if (!/^\d{1,18}$/.test(id)) throw new HttpError(404, "This place doesn't exist");
  return id;
};

places.put("/:id", requireAdmin, async (c) => {
  const id = idOf(c);
  const b = await body(c);
  const f = fields(b);
  const keys = await keyIds(b.keys);
  const extra = { note: f.note, keys, updatedBy: c.get("user").id, updatedAt: new Date().toISOString() };
  const rows = await sql`
    UPDATE features SET osm_key = ${f.osmKey}, osm_value = ${f.osmValue}, layer = ${f.layer}, importance = ${f.importance},
      country_code = ${f.countryCode}, name = ${f.name}, names = ${sql.json(f.names)}, housenumber = ${f.housenumber}, street = ${f.street},
      postcode = ${f.postcode}, district = ${f.district}, city = ${f.city}, state = ${f.state}, extra = ${sql.json(extra)},
      centroid = ST_SetSRID(ST_MakePoint(${f.lon}, ${f.lat}), 4326)
    WHERE region = ${CUSTOM_REGION} AND id = ${id}
    RETURNING id`;
  if (!rows.length) throw new HttpError(404, "This place doesn't exist");
  await loadRestrictions();
  clearCache();
  const [row] = await sql<CustomPlace[]>`SELECT ${COLUMNS} FROM features WHERE region = ${CUSTOM_REGION} AND id = ${id}`;
  return c.json(row);
});

places.delete("/:id", requireAdmin, async (c) => {
  await sql`DELETE FROM features WHERE region = ${CUSTOM_REGION} AND id = ${idOf(c)}`;
  await loadRestrictions();
  clearCache();
  return c.json({ ok: true });
});

// Geocoding: autocomplete (as you type), search (full words, filters), reverse (a point to an address).
//
// Text queries match the features' search vectors in two tiers: the important places (cities,
// districts, landmarks, ~1% of the rows, in their own small index) and the long tail (streets, shops…)
// capped at a few thousand candidates. A query with a house number also looks for that number on the
// streets that matched. Too few results: a trigram search catches typos ("bruxels").
//
// Benchmarks and the reasoning behind this: docs/spike.md.

import { CUSTOM_REGION, sql, TOP_IMPORTANCE } from "./db.ts";
import { normWord, settings, type Format, type Settings } from "./settings.ts";
import { allowedKeys } from "./places.ts";

/**
 * Who's asking, for private custom places: an API key's id, null without a key, or "all" (the
 * dashboard's playground, which sees everything).
 */
export type Viewer = string | null | "all";

/** A piece of SQL to nest in a query (postgres.js types fragments by their rows, which don't matter here). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fragment = any;

export interface Hit {
  id: string;
  source: "feature" | "address";
  layer: string;
  name: string | null;
  names: Record<string, unknown> | null;
  housenumber: string | null;
  street: string | null;
  postcode: string | null;
  district: string | null;
  city: string | null;
  county: string | null;
  state: string | null;
  addressI18n: Record<string, Record<string, string>> | null;
  countryCode: string | null;
  region: string;
  osmType: string;
  osmId: string;
  osmKey: string;
  osmValue: string;
  importance: number;
  lon: number;
  lat: number;
  extent: number[] | null;
  /** Metres from the point given (reverse). */
  distance?: number;
  score?: number;
}

export interface Filters {
  limit?: number;
  /** Favour results near this point. */
  near?: { lat: number; lon: number };
  /** Only these layers (house, street, city…). */
  layers?: string[];
  /** Only these countries (ISO codes, lowercase). */
  countries?: string[];
  /** [west, south, east, north]. */
  bbox?: [number, number, number, number];
  /** OSM tags: "amenity", "amenity:restaurant", "!highway". */
  tags?: string[];
  /** Who's asking (private places); without it, only what any caller may see. */
  viewer?: Viewer;
}

/** Lowercase, accents off, split into words (letters and digits only, so they're safe in a tsquery). */
export function words(q: string): string[] {
  return (
    q
      .normalize("NFKD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).slice(0, 12);
}

const isHouseNumber = (w: string) => /^\d{1,4}[a-z]?$/.test(w);

// ---------- Synonyms and the blocklist (settings, compiled once per change) ----------

let synonymsFrom: string[][] | null = null;
let synonymMap = new Map<string, string[]>();

/** The other words that mean the same as `w` (Settings → Synonyms). */
function synonymsOf(w: string): string[] {
  const groups = settings().text.synonyms;
  if (groups !== synonymsFrom) {
    synonymsFrom = groups;
    synonymMap = new Map();
    for (const g of groups) for (const word of g) synonymMap.set(word, [...new Set([...(synonymMap.get(word) ?? []), ...g.filter((x) => x !== word)])]);
  }
  return synonymMap.get(w) ?? [];
}

let blockFrom: Settings["blocklist"] | null = null;
let blockIds = new Set<string>();
let blockNames: RegExp[] = [];

/**
 * False for a result the caller may not have: on the blocklist (its OSM id, or a name matching one of
 * the patterns), or a private custom place their key isn't allowed to see.
 */
function allowed(h: Hit, viewer: Viewer = null): boolean {
  if (h.osmType === "X" && viewer !== "all") {
    const keys = allowedKeys(h.osmId);
    if (keys && (viewer === null || !keys.has(viewer))) return false;
  }
  const b = settings().blocklist;
  if (b !== blockFrom) {
    blockFrom = b;
    blockIds = new Set(b.ids);
    blockNames = b.names.map((p) => new RegExp(`^${normWord(p).split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "u"));
  }
  if (blockIds.size && blockIds.has(`${h.osmType}${h.osmId}`)) return false;
  if (blockNames.length && h.name) {
    const name = normWord(h.name);
    if (blockNames.some((re) => re.test(name))) return false;
  }
  return true;
}

const FEATURE_FIELDS = sql`
  id::text, 'feature' AS source, layer, name, names, housenumber, street, postcode, district, city, county, state, address_i18n,
  country_code, region, osm_type, osm_id::text, osm_key, osm_value, importance, ST_X(centroid) AS lon, ST_Y(centroid) AS lat, extent`;

const ADDRESS_FIELDS = sql`
  a.id::text, 'address' AS source, 'house' AS layer, NULL AS name, NULL::jsonb AS names, a.housenumber, a.street, a.postcode, a.district,
  a.city, a.county, a.state, a.address_i18n, a.country_code, a.region, a.osm_type, a.osm_id::text, a.osm_key, a.osm_value, a.importance,
  ST_X(a.centroid) AS lon, ST_Y(a.centroid) AS lat, NULL::real[] AS extent`;

/** How many matches of the long tail (streets, shops…) are scored at most: common words ("rue") match far more. */
const TAIL_CANDIDATES = 3000;

function filterSql(f: Filters) {
  const layers = f.layers?.length ? f.layers : settings().results.layers;
  let out = sql`AND layer = ANY(${layers})`;
  if (f.countries?.length) out = sql`${out} AND country_code = ANY(${f.countries})`;
  if (f.bbox) out = sql`${out} AND centroid && ST_MakeEnvelope(${f.bbox[0]}, ${f.bbox[1]}, ${f.bbox[2]}, ${f.bbox[3]}, 4326)`;
  for (const tag of f.tags ?? []) {
    const not = tag.startsWith("!");
    const [key, value] = tag.replace(/^!/, "").split(":");
    const match = value ? sql`(osm_key = ${key} AND osm_value = ${value})` : sql`osm_key = ${key}`;
    out = not ? sql`${out} AND NOT ${match}` : sql`${out} AND ${match}`;
  }
  return out;
}

function nearBonus(near?: { lat: number; lon: number }) {
  const r = settings().ranking;
  if (!near || !r.near) return sql``;
  return sql`+ ${r.near}::float8 * exp(-ST_Distance(centroid::geography, ST_SetSRID(ST_MakePoint(${near.lon}, ${near.lat}), 4326)::geography) / ${r.nearKm * 1000}::float8)`;
}

/** Metres between two points (equirectangular: plenty at these distances). */
const metres = (a: Hit, b: Hit) => {
  const x = ((b.lon - a.lon) * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180))) * 111_320;
  const y = (b.lat - a.lat) * 110_540;
  return Math.hypot(x, y);
};

/**
 * Same place, said twice: a street cut into segments, a square mapped as a place, an area and a street
 * ("Grand-Place" ×3), a station as a node and a building. Same name less than 300 m apart: one is enough
 * (the first, the best ranked).
 */
function dedupe(hits: Hit[]): Hit[] {
  const kept: Hit[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    const key = [h.layer === "house" && h.source === "feature" ? "poi" : h.layer, (h.name ?? "").toLowerCase(), h.housenumber, h.street, h.city].join("|");
    if (seen.has(key)) continue;
    const name = h.name?.toLowerCase();
    if (name && !h.housenumber && kept.some((k) => k.name?.toLowerCase() === name && metres(k, h) < 300)) continue;
    seen.add(key);
    kept.push(h);
  }
  return kept;
}

export const limitOf = (requested?: number) => {
  const r = settings().results;
  return Math.max(1, Math.min(requested ?? r.defaultLimit, r.maxLimit));
};

/**
 * Text search. `prefix`: the last word may be unfinished (autocomplete). Every word typed must match
 * somewhere; names count most (see the ranking settings).
 */
export async function find(q: string, f: Filters, prefix: boolean): Promise<Hit[]> {
  const wanted = limitOf(f.limit);
  const all = words(q);
  if (!all.length) return [];
  const typingLast = prefix && !/\s$/.test(q);
  let numbers = all.filter(isHouseNumber);
  let text = all.filter((w) => !isHouseNumber(w));
  // Only numbers: a postcode ("9356", "1000"), not a house number.
  if (!text.length) {
    text = numbers;
    numbers = [];
  }
  // With a house number, look at more streets: the number is then searched on them.
  const limit = numbers.length ? Math.max(wanted, 10) : wanted;
  // A word, or any of its synonyms ("st" → "st | saint"); the one being typed matches as a prefix.
  const one = (w: string, prefixed: boolean, weight: string) => (prefixed ? `${w}:*${weight}` : weight ? `${w}:${weight}` : w);
  const term = (w: string, i: number, weight = "") => {
    const typing = i === text.length - 1 && typingLast;
    const alts = synonymsOf(w);
    return alts.length ? `(${[one(w, typing, weight), ...alts.map((a) => one(a, false, weight))].join(" | ")})` : one(w, typing, weight);
  };
  const tsquery = text.map((w, i) => term(w, i)).join(" & ");
  const inName = text.map((w, i) => term(w, i, "A")).join(" & ");
  const phrase = text.join(" ");
  const r = settings().ranking;
  const filters = filterSql(f);
  // Scoring in two stages, so the costly part only runs on a few rows:
  //  1. `base` (importance, every word in the name) + the name-starts-with bonus on the default name;
  //  2. the best few rows get the bonus again on every name they have, in each kept language, punctuation
  //     off ("Rue de la Loi - Wetstraat" is also "Rue de la Loi" in French; "Grand-Place" starts with "grand place").
  const plainOf = (x: Fragment) => sql`regexp_replace(geo_norm(${x}), '[^[:alnum:]]+', ' ', 'g')`;
  const prefixBonus = (names: Fragment) => sql`
    CASE WHEN ${names} LIKE ${"%|" + phrase + "|%"} THEN ${r.prefix * 1.5}::float8
         WHEN ${names} LIKE ${"%|" + phrase + "%"} THEN ${r.prefix}::float8
         WHEN ${names} LIKE ${"% " + phrase + "%"} THEN ${r.prefix / 2}::float8 ELSE 0 END`;
  const base = sql`${r.importance}::float8 * importance
    + CASE WHEN search @@ to_tsquery('simple', ${inName}) THEN ${r.nameMatch}::float8 ELSE 0 END
    ${nearBonus(f.near)}`;
  const cheap = sql`${base} + ${prefixBonus(sql`('|' || ${plainOf(sql`name`)} || '|')`)}`;
  const allNames = sql`('|' || ${plainOf(sql`name`)} || '|' || coalesce((SELECT string_agg(${plainOf(sql`v`)}, '|') FROM jsonb_each_text(names - 'alt') AS e(k, v)), '') || '|')`;
  const shortlist = limit * 5;
  // One or two letters only search the important places (or around the user): everything else matches.
  const short = text.length === 1 && text[0].length < 3;
  const around = f.near ? sql`AND centroid && ST_Expand(ST_SetSRID(ST_MakePoint(${f.near.lon}, ${f.near.lat}), 4326), 0.5)` : sql``;
  /** Stage 2 over a shortlist from stage 1. */
  const rescore = (shortlistSql: Fragment) => sql<Hit[]>`
    SELECT *, base + ${prefixBonus(allNames)} AS score FROM (${shortlistSql}) s
    ORDER BY score DESC LIMIT ${limit * 3}`;

  const [top, tail] = await Promise.all([
    rescore(sql`
      SELECT ${FEATURE_FIELDS}, ${base} AS base
      FROM features, to_tsquery('simple', ${tsquery}) query
      WHERE importance >= ${TOP_IMPORTANCE} AND search @@ query ${filters}
      ORDER BY ${cheap} DESC LIMIT ${shortlist}`),
    short && !f.near
      ? Promise.resolve([] as Hit[])
      : rescore(sql`
      SELECT ${FEATURE_FIELDS}, ${base} AS base
      FROM (
        SELECT * FROM features, to_tsquery('simple', ${tsquery}) query
        WHERE importance < ${TOP_IMPORTANCE} AND search @@ query ${filters} ${short ? around : sql``}
        LIMIT ${TAIL_CANDIDATES}
      ) candidates
      ORDER BY ${cheap} DESC LIMIT ${shortlist}`),
  ]);
  let hits = dedupe([...top, ...tail].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)));

  // "rue de la loi 16": the number on the streets that matched, in the order the streets ranked.
  const layers = f.layers?.length ? f.layers : settings().results.layers;
  if (numbers.length && layers.includes("house")) {
    const streets = hits.filter((h) => h.layer === "street").slice(0, 5);
    if (streets.length) {
      const houses = await sql<Hit[]>`
        SELECT ${ADDRESS_FIELDS}, 2 AS score
        FROM addresses a
        JOIN unnest(${streets.map((s) => s.name!)}::text[], ${streets.map((s) => s.city ?? "")}::text[]) WITH ORDINALITY AS s(name, city, rank)
          ON geo_norm(a.street) = geo_norm(s.name) AND a.city IS NOT DISTINCT FROM nullif(s.city, '')
        WHERE a.housenumber ILIKE ${numbers[0] + "%"}
        ORDER BY s.rank, length(a.housenumber), a.housenumber
        LIMIT ${limit}`;
      hits = [...houses, ...hits];
    }
  }

  // Typos: nothing (or little) matched word for word. The important places first (their own small
  // trigram index); the long tail only within 300 ms (on millions of names a vague typo can take
  // seconds: better a miss than a slow answer).
  if (hits.length < Math.min(3, limit)) {
    // Spelling: the whole name (similarity) and its best-matching words (word_similarity) together, so
    // neither short names ("Brux" for "bruxels") nor long ones ("Cognat-Lyonne" for "lyonn") win on one
    // measure alone; then half the usual weight of importance (Bruxelles, Lyon, and the Atomium over Atos).
    const fuzzyScore = sql`(similarity(geo_norm(name), ${phrase}) + word_similarity(${phrase}, geo_norm(name))) / 2
      + ${r.importance / 2}::float8 * importance ${nearBonus(f.near)}`;
    const top = await sql<(Hit & { sim: number })[]>`
      SELECT ${FEATURE_FIELDS}, ${fuzzyScore} AS score, similarity(geo_norm(name), ${phrase}) AS sim
      FROM features
      WHERE importance >= ${TOP_IMPORTANCE} AND geo_norm(name) % ${phrase} ${filters}
      ORDER BY score DESC
      LIMIT ${limit}`;
    // A close match among the important places is enough ("marsielle" → Marseille); otherwise look further
    // ("atomiun" → the Atomium, a landmark but not among the most important places).
    const close = top.some((h) => h.sim >= 0.4);
    if (!close) {
      const tail = await sql
        .begin(async (tx) => {
          await tx`SET LOCAL statement_timeout = '300ms'`;
          return tx<Hit[]>`
            SELECT ${FEATURE_FIELDS}, ${fuzzyScore} AS score
            FROM features
            WHERE importance < ${TOP_IMPORTANCE} AND geo_norm(name) % ${phrase} ${filters}
            ORDER BY score DESC
            LIMIT ${limit}`;
        })
        .catch(() => [] as Hit[]);
      hits = dedupe([...hits, ...[...top, ...tail].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))]);
    } else hits = dedupe([...hits, ...top]);
  }
  return hits.filter((h) => allowed(h, f.viewer)).slice(0, wanted);
}

export interface ReverseOptions {
  /** Metres. */
  radius?: number;
  limit?: number;
  layers?: string[];
  viewer?: Viewer;
}

/**
 * What's at a point: the nearest house number and street within the radius, then the areas the
 * point is in, from the smallest (district) to the country.
 */
export async function reverse(lat: number, lon: number, o: ReverseOptions = {}): Promise<Hit[]> {
  const radius = o.radius ?? settings().results.reverseRadius;
  const layers = o.layers?.length ? o.layers : settings().results.layers;
  const pt = sql`ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)`;
  const want = (l: string) => layers.includes(l);
  const areaLayers = layers.filter((l) => ["locality", "district", "city", "county", "state", "country"].includes(l));
  const [houses, pois, streets, areas] = await Promise.all([
    want("house")
      ? sql<Hit[]>`
      SELECT * FROM (
        SELECT ${ADDRESS_FIELDS}, ST_Distance(a.centroid::geography, ${pt}::geography) AS distance
        FROM addresses a ORDER BY a.centroid <-> ${pt} LIMIT 5
      ) x WHERE distance <= ${radius} ORDER BY distance LIMIT 1`
      : Promise.resolve([] as Hit[]),
    want("house")
      ? sql<Hit[]>`
      SELECT * FROM (
        SELECT ${FEATURE_FIELDS}, ST_Distance(centroid::geography, ${pt}::geography) AS distance
        FROM features WHERE layer = 'house' AND (housenumber IS NOT NULL OR region = ${CUSTOM_REGION}) ORDER BY centroid <-> ${pt} LIMIT 5
      ) x WHERE distance <= ${radius} ORDER BY distance LIMIT 1`
      : Promise.resolve([] as Hit[]),
    want("street")
      ? sql<Hit[]>`
      SELECT * FROM (
        SELECT ${FEATURE_FIELDS}, ST_Distance(geom::geography, ${pt}::geography) AS distance
        FROM features WHERE layer = 'street' AND geom IS NOT NULL ORDER BY geom <-> ${pt} LIMIT 10
      ) x WHERE distance <= ${radius} ORDER BY distance LIMIT 1`
      : Promise.resolve([] as Hit[]),
    areaLayers.length
      ? sql<Hit[]>`
      SELECT ${FEATURE_FIELDS}, 0 AS distance
      FROM features
      WHERE layer = ANY(${areaLayers}) AND geom && ${pt} AND ST_Intersects(geom, ${pt})
      ORDER BY array_position(ARRAY['locality', 'district', 'city', 'county', 'state', 'country'], layer), ST_Area(geom)`
      : Promise.resolve([] as Hit[]),
  ]);
  // The closer of an address and a named place with a number (a shop at that address), or a custom place.
  const ok = (h: Hit) => allowed(h, o.viewer);
  const house = [...houses, ...pois].filter(ok).sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0)).slice(0, 1);
  return [...house, ...streets.filter(ok), ...areas.filter(ok)].slice(0, o.limit ?? 10);
}

// ---------- Output ----------

let countryNames = new Map<string, Record<string, string>>();

/** Country names, for labels (reloaded after an import). */
export async function loadCountries() {
  const rows = await sql<{ code: string; names: Record<string, string> }[]>`SELECT code, names FROM countries`;
  countryNames = new Map(rows.map((r) => [r.code, r.names]));
}

function country(code: string | null, lang: string): string | null {
  if (!code) return null;
  const n = countryNames.get(code);
  return n?.[`name:${lang}`] ?? n?.["name:en"] ?? n?.name ?? code.toUpperCase();
}

/** A hit in the requested language: its own name and address parts when the region kept them. */
function localized(h: Hit, lang: string) {
  const i18n = h.addressI18n?.[lang] ?? {};
  const name = (h.names?.[lang] as string | undefined) ?? h.name;
  return {
    name,
    street: i18n.street ?? h.street,
    district: i18n.district ?? h.district,
    city: i18n.city ?? h.city,
    county: i18n.county ?? h.county,
    state: i18n.state ?? h.state,
    country: country(h.countryCode, lang),
  };
}

const AREA_LAYERS = new Set(["city", "county", "state", "country"]);

/** "Rue de la Loi 16, 1000 Bruxelles, Belgique". */
function label(h: Hit, l: ReturnType<typeof localized>): string {
  const streetLine = l.street ? [l.street, h.housenumber].filter(Boolean).join(" ") : null;
  const place = [h.postcode, l.city].filter(Boolean).join(" ");
  const parts = AREA_LAYERS.has(h.layer) ? [l.name, l.state !== l.name ? l.state : null, l.country] : [l.name, streetLine, place || l.district, l.country];
  return [...new Set(parts.filter((p): p is string => !!p))].join(", ");
}

/** GeoPol's own format (/v1/…). */
export function toResults(hits: Hit[], lang: string) {
  return hits.map((h) => {
    const l = localized(h, lang);
    return {
      id: `${h.osmType}${h.osmId}`,
      layer: h.layer,
      label: label(h, l),
      name: l.name,
      address: {
        housenumber: h.housenumber,
        street: l.street,
        postcode: h.postcode,
        district: l.district,
        city: l.city,
        county: l.county,
        state: l.state,
        country: l.country,
        countryCode: h.countryCode?.toUpperCase() ?? null,
      },
      lat: h.lat,
      lon: h.lon,
      extent: h.extent,
      ...(h.distance !== undefined ? { distance: Math.round(h.distance) } : {}),
      osm: { type: h.osmType, id: Number(h.osmId), key: h.osmKey, value: h.osmValue },
      region: h.region,
    };
  });
}

/**
 * /v1/… in the format asked for (?format=, else the default in Settings → Results):
 * GeoPol's own, GeoJSON with GeoPol's fields as properties, Photon's GeoJSON, or a compact list.
 */
export function formatted(hits: Hit[], lang: string, format: Format) {
  if (format === "photon") return toPhoton(hits, lang);
  const results = toResults(hits, lang);
  if (format === "geojson")
    return {
      type: "FeatureCollection",
      features: results.map(({ lat, lon, extent, ...properties }) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lon, lat] },
        // GeoJSON's bbox is west, south, east, north (extent: west, north, east, south).
        ...(extent ? { bbox: [extent[0], extent[3], extent[2], extent[1]] } : {}),
        properties,
      })),
    };
  if (format === "compact") return { results: results.map((r) => ({ id: r.id, layer: r.layer, label: r.label, lat: r.lat, lon: r.lon, ...(r.distance !== undefined ? { distance: r.distance } : {}) })) };
  return { results };
}

/** Photon's GeoJSON (/api, /reverse): what gps, llip, concerts and maps already read. */
export function toPhoton(hits: Hit[], lang: string) {
  return {
    type: "FeatureCollection",
    features: hits.map((h) => {
      const l = localized(h, lang);
      const props: Record<string, unknown> = {
        osm_type: h.osmType,
        osm_id: Number(h.osmId),
        osm_key: h.osmKey,
        osm_value: h.osmValue,
        type: h.layer,
        name: l.name,
        housenumber: h.housenumber,
        street: l.street,
        postcode: h.postcode,
        district: l.district,
        city: l.city,
        county: l.county,
        state: l.state,
        country: l.country,
        countrycode: h.countryCode?.toUpperCase(),
        extent: h.extent,
      };
      for (const k of Object.keys(props)) if (props[k] === null || props[k] === undefined) delete props[k];
      return { type: "Feature", geometry: { type: "Point", coordinates: [h.lon, h.lat] }, properties: props };
    }),
  };
}

// Geocoding queries: autocomplete (as you type), reverse (a point to an address).
//
// Autocomplete matches the words typed against the features' search vectors, the last word as a
// prefix ("rue de riv" → rue & de & riv:*). When the query has a house number, it also looks for that
// number on the streets that match. Too few results: a trigram search catches typos ("bruxels").

import { sql } from "./db.ts";

export interface Hit {
  id: string;
  source: "feature" | "address";
  layer: string;
  name: string | null;
  housenumber: string | null;
  street: string | null;
  postcode: string | null;
  district: string | null;
  city: string | null;
  county: string | null;
  state: string | null;
  countryCode: string | null;
  osmType: string;
  osmId: string;
  osmKey: string;
  osmValue: string;
  importance: number;
  lon: number;
  lat: number;
  extent: number[] | null;
  /** Metres from the point given (reverse, or the location bias). */
  distance?: number;
  score?: number;
}

export interface AutocompleteOptions {
  limit?: number;
  /** Favour results near this point. */
  near?: { lat: number; lon: number };
  countries?: string[];
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

const FEATURE_FIELDS = sql`
  id::text, 'feature' AS source, layer, name, housenumber, street, postcode, district, city, county, state, country_code,
  osm_type, osm_id::text, osm_key, osm_value, importance, ST_X(centroid) AS lon, ST_Y(centroid) AS lat, extent`;

const ADDRESS_FIELDS = sql`
  a.id::text, 'address' AS source, 'house' AS layer, NULL AS name, a.housenumber, a.street, a.postcode, a.district, a.city, a.county, a.state,
  a.country_code, a.osm_type, a.osm_id::text, a.osm_key, a.osm_value, a.importance, ST_X(a.centroid) AS lon, ST_Y(a.centroid) AS lat, NULL::real[] AS extent`;

/** How much nearness counts, as a bonus that fades over ~50 km. */
const nearBonus = (near?: { lat: number; lon: number }) =>
  near ? sql`+ 0.5 * exp(-ST_Distance(centroid::geography, ST_SetSRID(ST_MakePoint(${near.lon}, ${near.lat}), 4326)::geography) / 50000.0)` : sql``;

/** Places at least this important (cities, districts, landmarks: ~1% of features) are searched first, in their own small index. */
export const TOP_IMPORTANCE = 0.15;
/** How many matches of the long tail (streets, shops…) are scored at most: common words ("rue") match far more. */
const TAIL_CANDIDATES = 3000;

/** Same place, said twice (a street cut into segments, a station mapped as a node and an area): one is enough. */
function dedupe(hits: Hit[]): Hit[] {
  const seen = new Set<string>();
  return hits.filter((h) => {
    const key = [h.layer === "house" && h.source === "feature" ? "poi" : h.layer, (h.name ?? "").toLowerCase(), h.housenumber, h.street, h.city].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function autocomplete(q: string, o: AutocompleteOptions = {}): Promise<Hit[]> {
  const limit = Math.min(o.limit ?? 8, 50);
  const all = words(q);
  if (!all.length) return [];
  const typingLast = !/\s$/.test(q);
  const numbers = all.filter(isHouseNumber);
  const text = all.filter((w) => !isHouseNumber(w));
  if (!text.length) return [];
  const tsquery = text.map((w, i) => (i === text.length - 1 && typingLast ? `${w}:*` : w)).join(" & ");
  const phrase = text.join(" ");
  const countries = o.countries?.length ? sql`AND country_code = ANY(${o.countries})` : sql``;
  // Every word in the name itself (weight A) beats words found in the address ("antwerpen centr" → the
  // station, not a place in the province of Antwerp); a name that starts with what was typed counts most
  // ("br" → Brussels before "Rue de Bruges"). Punctuation doesn't count ("Grand-Place" starts with "grand place").
  const inName = text.map((w, i) => (i === text.length - 1 && typingLast ? `${w}:*A` : `${w}:A`)).join(" & ");
  const plain = sql`regexp_replace(geo_norm(name), '[^[:alnum:]]+', ' ', 'g')`;
  const score = sql`importance
    + CASE WHEN search @@ to_tsquery('simple', ${inName}) THEN 0.4 ELSE 0 END
    + CASE WHEN ${plain} LIKE ${phrase + "%"} THEN 0.6 WHEN ${plain} LIKE ${"% " + phrase + "%"} THEN 0.3 ELSE 0 END
    ${nearBonus(o.near)}`;
  // A single letter or two only searches the important places (or around the user): everything else matches.
  const short = text.length === 1 && text[0].length < 3;
  const around = o.near ? sql`AND centroid && ST_Expand(ST_SetSRID(ST_MakePoint(${o.near.lon}, ${o.near.lat}), 4326), 0.5)` : sql``;

  const [top, tail] = await Promise.all([
    sql<Hit[]>`
      SELECT ${FEATURE_FIELDS}, ${score} AS score
      FROM features, to_tsquery('simple', ${tsquery}) query
      WHERE importance >= ${TOP_IMPORTANCE} AND search @@ query ${countries}
      ORDER BY score DESC LIMIT ${limit * 3}`,
    short && !o.near
      ? Promise.resolve([] as Hit[])
      : sql<Hit[]>`
      SELECT * FROM (
        SELECT ${FEATURE_FIELDS}, ${score} AS score
        FROM (
          SELECT * FROM features, to_tsquery('simple', ${tsquery}) query
          WHERE importance < ${TOP_IMPORTANCE} AND search @@ query ${countries} ${around}
          LIMIT ${TAIL_CANDIDATES}
        ) candidates
      ) scored ORDER BY score DESC LIMIT ${limit * 3}`,
  ]);
  let hits = dedupe([...top, ...tail].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)));

  // "rue de la loi 16": the number on the streets that matched.
  if (numbers.length) {
    const streets = hits.filter((h) => h.layer === "street").slice(0, 5);
    if (streets.length) {
      // In the order the streets ranked, the exact number first ("16" before "160").
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

  // Typos: nothing (or little) matched word for word.
  if (hits.length < Math.min(3, limit)) {
    const fuzzy = await sql<Hit[]>`
      SELECT ${FEATURE_FIELDS}, similarity(geo_norm(name), ${phrase}) + importance ${nearBonus(o.near)} AS score
      FROM features
      WHERE geo_norm(name) % ${phrase} ${countries}
      ORDER BY score DESC
      LIMIT ${limit}`;
    hits = dedupe([...hits, ...fuzzy]);
  }
  return hits.slice(0, limit);
}

export interface ReverseOptions {
  /** Metres. */
  radius?: number;
  limit?: number;
}

/** The nearest house number, street and the areas the point is in. */
export async function reverse(lat: number, lon: number, o: ReverseOptions = {}) {
  const radius = o.radius ?? 1000;
  const pt = sql`ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)`;
  const [houses, streets, areas] = await Promise.all([
    sql<Hit[]>`
      SELECT * FROM (
        SELECT ${ADDRESS_FIELDS}, ST_Distance(a.centroid::geography, ${pt}::geography) AS distance
        FROM addresses a ORDER BY a.centroid <-> ${pt} LIMIT 5
      ) x WHERE distance <= ${radius} ORDER BY distance LIMIT ${o.limit ?? 1}`,
    sql<Hit[]>`
      SELECT * FROM (
        SELECT ${FEATURE_FIELDS}, ST_Distance(geom::geography, ${pt}::geography) AS distance
        FROM features WHERE layer = 'street' AND geom IS NOT NULL ORDER BY geom <-> ${pt} LIMIT 10
      ) x WHERE distance <= ${radius} ORDER BY distance LIMIT ${o.limit ?? 1}`,
    sql<Hit[]>`
      SELECT ${FEATURE_FIELDS}, 0 AS distance
      FROM features
      WHERE layer IN ('district', 'city', 'county', 'state', 'country') AND geom && ${pt} AND ST_Intersects(geom, ${pt})
      ORDER BY array_position(ARRAY['district', 'city', 'county', 'state', 'country'], layer)`,
  ]);
  return { houses, streets, areas };
}

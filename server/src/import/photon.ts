// Turns a Photon dump (JSONL, zstd-compressed, from download1.graphhopper.com/public/…) into rows
// for the features and addresses tables.
//
// A dump starts with a NominatimDumpFile header and a CountryInfo line, then one Place per line
// (sometimes several in one line). Each place has its centroid, bbox, importance, address type
// ("house", "street", "city"…), names and address parts in every language, and its geometry.

export interface PhotonPlace {
  place_id: string;
  object_type: string;
  object_id: number;
  osm_key: string;
  osm_value: string;
  address_type: string;
  importance: number;
  name?: Record<string, string>;
  address?: Record<string, string | string[]>;
  extra?: Record<string, string>;
  housenumber?: string;
  postcode?: string;
  country_code?: string;
  centroid: [number, number];
  bbox?: [number, number, number, number];
  geometry?: { type: string; coordinates: unknown };
}

export interface ImportOptions {
  region: string;
  /** Languages kept besides the default name ("fr", "en"…). */
  languages: string[];
  /** Keep house numbers (most of the data). */
  houseNumbers: boolean;
}

/** Layers whose lines and areas are kept: reverse geocoding finds the nearest street, the city a point is in. */
const GEOMETRY_LAYERS = new Set(["street", "locality", "district", "city", "county", "state", "country"]);
const ADDRESS_PARTS = ["street", "district", "city", "county", "state"] as const;
/** Alternative names a query should also match. */
const ALT_NAMES = ["alt_name", "int_name", "short_name", "official_name", "loc_name", "old_name"];
/** The few extra tags worth keeping (the rest is noise for geocoding). */
const EXTRA_KEYS = ["wikidata", "population", "admin_level", "website", "opening_hours", "phone"];

// ---------- COPY text format ----------

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
const cell = (v: unknown): string => (v === null || v === undefined || v === "" ? "\\N" : typeof v === "string" ? esc(v) : esc(String(v)));
const json = (v: object) => esc(JSON.stringify(v));

// ---------- Geometry ----------

const coords = (c: number[]) => `${c[0]} ${c[1]}`;
const line = (l: number[][]) => `(${l.map(coords).join(",")})`;
const poly = (p: number[][][]) => `(${p.map(line).join(",")})`;

/** GeoJSON to EWKT, which PostGIS reads straight from COPY. */
export function toEwkt(g: { type: string; coordinates: unknown }): string | null {
  const c = g.coordinates as never;
  switch (g.type) {
    case "Point":
      return `SRID=4326;POINT(${coords(c)})`;
    case "LineString":
      return `SRID=4326;LINESTRING${line(c)}`;
    case "MultiLineString":
      return `SRID=4326;MULTILINESTRING(${(c as number[][][]).map(line).join(",")})`;
    case "Polygon":
      return `SRID=4326;POLYGON${poly(c)}`;
    case "MultiPolygon":
      return `SRID=4326;MULTIPOLYGON(${(c as number[][][][]).map(poly).join(",")})`;
    default:
      return null;
  }
}

// ---------- Mapping ----------

const str = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

function names(p: PhotonPlace, languages: string[]) {
  const n = p.name ?? {};
  const out: Record<string, unknown> = {};
  for (const lang of languages) if (n[`name:${lang}`]) out[lang] = n[`name:${lang}`];
  const alt = ALT_NAMES.flatMap((k) => (n[k] ? n[k].split(";").map((s) => s.trim()) : [])).filter(Boolean);
  if (alt.length) out.alt = [...new Set(alt)];
  return out;
}

function addressI18n(p: PhotonPlace, languages: string[]) {
  const a = p.address ?? {};
  const out: Record<string, Record<string, string>> = {};
  for (const lang of languages) {
    const parts: Record<string, string> = {};
    for (const part of ADDRESS_PARTS) {
      const v = str(a[`${part}:${lang}`]);
      if (v && v !== str(a[part])) parts[part] = v;
    }
    if (Object.keys(parts).length) out[lang] = parts;
  }
  return out;
}

export interface Rows {
  feature?: string;
  address?: string;
}

/** One place as COPY lines for the features or addresses table (or nothing, for unnamed places without a number). */
export function placeRows(p: PhotonPlace, o: ImportOptions): Rows {
  const a = p.address ?? {};
  const centroid = `SRID=4326;POINT(${p.centroid[0]} ${p.centroid[1]})`;
  // Postcodes are made up by Photon, not OSM objects: no type or id of their own ("P" + Photon's place id).
  const common = [
    p.place_id,
    o.region,
    p.object_type ?? "P",
    p.object_id ?? p.place_id,
    p.osm_key,
    p.osm_value,
  ];
  const name = p.name?.name ?? Object.values(p.name ?? {})[0];
  if (name) {
    const extra: Record<string, string> = {};
    for (const k of EXTRA_KEYS) if (p.extra?.[k]) extra[k] = p.extra[k];
    const geom = p.geometry && GEOMETRY_LAYERS.has(p.address_type) && p.geometry.type !== "Point" ? toEwkt(p.geometry) : null;
    const row = [
      ...common.map(cell),
      cell(p.address_type),
      cell(p.importance ?? 0),
      cell(p.country_code),
      cell(name),
      json(names(p, o.languages)),
      cell(p.housenumber),
      cell(str(a.street)),
      cell(p.postcode),
      cell(str(a.suburb) ?? str(a.district) ?? str(a.neighbourhood)),
      cell(str(a.city)),
      cell(str(a.county)),
      cell(str(a.state)),
      json(addressI18n(p, o.languages)),
      json(extra),
      centroid,
      p.bbox ? `{${p.bbox.join(",")}}` : "\\N",
      geom ?? "\\N",
    ];
    return { feature: row.join("\t") + "\n" };
  }
  if (p.housenumber && o.houseNumbers) {
    const row = [
      ...common.map(cell),
      cell(p.importance ?? 0),
      cell(p.country_code),
      cell(p.housenumber),
      cell(str(a.street)),
      cell(p.postcode),
      cell(str(a.suburb) ?? str(a.district) ?? str(a.neighbourhood)),
      cell(str(a.city)),
      cell(str(a.county)),
      cell(str(a.state)),
      json(addressI18n(p, o.languages)),
      centroid,
    ];
    return { address: row.join("\t") + "\n" };
  }
  return {};
}

export const FEATURE_COLUMNS =
  "id, region, osm_type, osm_id, osm_key, osm_value, layer, importance, country_code, name, names, housenumber, street, postcode, district, city, county, state, address_i18n, extra, centroid, extent, geom";
export const ADDRESS_COLUMNS =
  "id, region, osm_type, osm_id, osm_key, osm_value, importance, country_code, housenumber, street, postcode, district, city, county, state, address_i18n, centroid";

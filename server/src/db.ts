// PostgreSQL + PostGIS connection and schema migrations.
//
// Columns are snake_case in the database and camelCase in JS (postgres.camel transform).

import postgres from "postgres";
import { DATABASE_URL } from "./config.ts";

export const sql = postgres(DATABASE_URL, {
  max: Number(process.env.DATABASE_POOL_MAX ?? 10),
  idle_timeout: 60,
  onnotice: () => {},
  transform: postgres.camel,
});

export type Sql = typeof sql;

/** Layers, from the most precise to the widest (Photon's address_type). */
export const LAYERS = ["house", "street", "locality", "district", "city", "county", "state", "country", "other"] as const;
export type Layer = (typeof LAYERS)[number];

const MIGRATIONS: string[] = [
  /* 1: geocoding data */ `
  CREATE EXTENSION IF NOT EXISTS postgis;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS unaccent;

  -- unaccent() isn't IMMUTABLE (its dictionary could change), so it can't go in an index or a generated
  -- column as is. This wrapper pins the dictionary, which makes it safe to declare IMMUTABLE.
  CREATE FUNCTION geo_norm(text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
    RETURN lower(public.unaccent('public.unaccent'::regdictionary, $1));

  -- A region: one Photon dump (a country, or a group of them), imported on its own so it can be
  -- added, refreshed or removed without touching the others.
  CREATE TABLE regions (
    id text PRIMARY KEY,
    name text NOT NULL,
    source_url text NOT NULL,
    dump_date timestamptz,
    imported_at timestamptz,
    features integer NOT NULL DEFAULT 0,
    addresses integer NOT NULL DEFAULT 0
  );

  -- Country names in every language, from the dumps' CountryInfo line (for labels and filters).
  CREATE TABLE countries (
    code text PRIMARY KEY,
    names jsonb NOT NULL
  );

  -- Named things: countries, states, cities, districts, localities, streets, points of interest.
  -- Small enough to search on every keystroke.
  CREATE TABLE features (
    id bigint NOT NULL,
    region text NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
    osm_type char(1) NOT NULL,
    osm_id bigint NOT NULL,
    osm_key text NOT NULL,
    osm_value text NOT NULL,
    layer text NOT NULL,
    importance real NOT NULL DEFAULT 0,
    country_code text,
    name text NOT NULL,
    -- {"fr": "...", "en": "...", "alt": ["...", ...]}, only the languages the admin keeps.
    names jsonb NOT NULL DEFAULT '{}',
    housenumber text,
    street text,
    postcode text,
    district text,
    city text,
    county text,
    state text,
    -- The same address parts in the kept languages: {"fr": {"city": "...", ...}, ...}
    address_i18n jsonb NOT NULL DEFAULT '{}',
    extra jsonb NOT NULL DEFAULT '{}',
    centroid geometry(Point, 4326) NOT NULL,
    -- [west, north, east, south], as Photon's "extent"
    extent real[],
    -- Lines and areas, for streets and administrative areas only (reverse geocoding, containment).
    geom geometry(Geometry, 4326),
    -- Everything a query can match: names in every kept language, then the address.
    search tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('simple', geo_norm(name || ' ' || (jsonb_path_query_array(names, '$.*') #>> '{}'))), 'A') ||
      setweight(to_tsvector('simple', geo_norm(coalesce(street, '') || ' ' || coalesce(housenumber, '') || ' ' || coalesce(postcode, ''))), 'B') ||
      setweight(to_tsvector('simple', geo_norm(coalesce(district, '') || ' ' || coalesce(city, '') || ' ' || coalesce(county, '') || ' ' || coalesce(state, ''))), 'C')
    ) STORED
  );

  -- House numbers without a name of their own: most of the data, only searched when a query has a number.
  CREATE TABLE addresses (
    id bigint NOT NULL,
    region text NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
    osm_type char(1) NOT NULL,
    osm_id bigint NOT NULL,
    osm_key text NOT NULL,
    osm_value text NOT NULL,
    importance real NOT NULL DEFAULT 0,
    country_code text,
    housenumber text NOT NULL,
    street text,
    postcode text,
    district text,
    city text,
    county text,
    state text,
    address_i18n jsonb NOT NULL DEFAULT '{}',
    centroid geometry(Point, 4326) NOT NULL
  );
  `,
];

/** Indexes, created after a bulk import (much faster than maintaining them row by row). */
export const INDEXES = `
  CREATE INDEX IF NOT EXISTS features_search ON features USING gin (search);
  -- Autocomplete's first tier: the important places (see TOP_IMPORTANCE in geocode.ts; keep the two in step).
  CREATE INDEX IF NOT EXISTS features_search_top ON features USING gin (search) WHERE importance >= 0.15;
  CREATE INDEX IF NOT EXISTS features_name_trgm ON features USING gin (geo_norm(name) gin_trgm_ops);
  CREATE INDEX IF NOT EXISTS features_centroid ON features USING gist (centroid);
  CREATE INDEX IF NOT EXISTS features_geom ON features USING gist (geom) WHERE geom IS NOT NULL;
  CREATE INDEX IF NOT EXISTS features_region ON features (region);
  CREATE INDEX IF NOT EXISTS addresses_centroid ON addresses USING gist (centroid);
  CREATE INDEX IF NOT EXISTS addresses_street ON addresses (geo_norm(street), housenumber);
  CREATE INDEX IF NOT EXISTS addresses_region ON addresses (region);
`;

export async function migrate() {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(4242030)`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    const [{ v }] = await tx<{ v: number }[]>`SELECT coalesce(max(version), 0)::int AS v FROM schema_migrations`;
    for (let i = v; i < MIGRATIONS.length; i++) {
      await tx.unsafe(MIGRATIONS[i]);
      await tx`INSERT INTO schema_migrations (version) VALUES (${i + 1})`;
      console.log(`Database migrated to version ${i + 1}`);
    }
  });
}

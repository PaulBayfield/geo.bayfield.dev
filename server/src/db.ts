// PostgreSQL + PostGIS connection and schema migrations.
//
// Columns are snake_case in the database and camelCase in JS (postgres.camel transform).
//
// The geocoding data (features, addresses) is partitioned by region: a region is imported into a
// table of its own, indexed, then attached in one quick step (see import/run.ts). Updating a region
// never slows the others down, and removing one is a DROP TABLE.

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

/** Places at least this important (cities, districts, landmarks: ~1% of features) get their own small search index. */
export const TOP_IMPORTANCE = 0.15;

/**
 * The indexes of a region's tables, built after its rows are in (much faster than row by row).
 * The parents carry the same definitions, so attaching a region's tables adopts them as they are.
 */
export function regionIndexes(features: string, addresses: string): string {
  return `
    CREATE INDEX ON ${features} USING gin (search);
    CREATE INDEX ON ${features} USING gin (search) WHERE importance >= ${TOP_IMPORTANCE};
    CREATE INDEX ON ${features} USING gin (geo_norm(name) gin_trgm_ops);
    CREATE INDEX ON ${features} USING gist (centroid);
    CREATE INDEX ON ${features} USING gist (geom) WHERE geom IS NOT NULL;
    CREATE INDEX ON ${features} (layer);
    CREATE INDEX ON ${addresses} USING gist (centroid);
    CREATE INDEX ON ${addresses} (geo_norm(street), housenumber);
  `;
}

const MIGRATIONS: string[] = [
  /* 1: initial schema */ `
  CREATE EXTENSION IF NOT EXISTS postgis;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS unaccent;

  -- unaccent() isn't IMMUTABLE (its dictionary could change), so it can't go in an index or a generated
  -- column as is. This wrapper pins the dictionary, which makes it safe to declare IMMUTABLE.
  CREATE FUNCTION geo_norm(text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
    RETURN lower(public.unaccent('public.unaccent'::regdictionary, $1));

  -- ---------- Accounts (the dashboard) ----------

  CREATE TABLE users (
    id text PRIMARY KEY,
    name text NOT NULL DEFAULT '',
    email text UNIQUE,
    oidc_sub text UNIQUE,
    role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz
  );

  CREATE TABLE sessions (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    method text NOT NULL,
    user_agent text NOT NULL DEFAULT '',
    ip text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE oidc_states (
    state text PRIMARY KEY,
    verifier text NOT NULL,
    nonce text NOT NULL,
    expires_at timestamptz NOT NULL
  );

  -- ---------- The service: settings, API keys, usage ----------

  -- Everything set in the dashboard, one row per setting (see settings.ts for the keys and defaults).
  CREATE TABLE settings (
    key text PRIMARY KEY,
    value jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  -- Only the SHA-256 of a key is stored; the key itself is shown once, when it's created.
  CREATE TABLE api_keys (
    id text PRIMARY KEY,
    name text NOT NULL,
    -- The key's first characters, to tell keys apart in the dashboard ("geo_Ab3d…").
    prefix text NOT NULL,
    key_hash text NOT NULL UNIQUE,
    -- Endpoints the key may call (autocomplete, search, reverse, photon); empty: all of them.
    scopes text[] NOT NULL DEFAULT '{}',
    -- Requests per minute, and per day; null: no limit of its own (the global limits still apply).
    rate_per_minute integer,
    daily_quota integer,
    -- Websites (Origin) and IP addresses allowed to use the key; empty: any.
    origins text[] NOT NULL DEFAULT '{}',
    ips text[] NOT NULL DEFAULT '{}',
    expires_at timestamptz,
    disabled boolean NOT NULL DEFAULT false,
    created_by text REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz
  );

  -- Requests per day, key (empty: without a key) and endpoint.
  CREATE TABLE api_usage (
    day date NOT NULL,
    key_id text NOT NULL DEFAULT '',
    endpoint text NOT NULL,
    requests integer NOT NULL DEFAULT 0,
    errors integer NOT NULL DEFAULT 0,
    PRIMARY KEY (day, key_id, endpoint)
  );

  -- ---------- Regions and their imports ----------

  -- A region: one Photon dump (a country, a group of them, or a whole continent).
  CREATE TABLE regions (
    id text PRIMARY KEY,
    name text NOT NULL,
    path text NOT NULL,
    source_url text NOT NULL,
    dump_date timestamptz,
    imported_at timestamptz,
    features integer NOT NULL DEFAULT 0,
    addresses integer NOT NULL DEFAULT 0,
    languages text[] NOT NULL DEFAULT '{}',
    house_numbers boolean NOT NULL DEFAULT true,
    auto_update boolean NOT NULL DEFAULT true
  );

  CREATE TABLE jobs (
    id bigserial PRIMARY KEY,
    region text NOT NULL,
    name text NOT NULL,
    path text NOT NULL,
    action text NOT NULL CHECK (action IN ('install', 'update')),
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
    options jsonb NOT NULL DEFAULT '{}',
    progress jsonb NOT NULL DEFAULT '{}',
    error text,
    created_by text REFERENCES users(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz
  );
  CREATE INDEX jobs_recent ON jobs(created_at DESC);

  -- Country names in every language, from the dumps' CountryInfo line (labels, filters).
  CREATE TABLE countries (
    code text PRIMARY KEY,
    names jsonb NOT NULL
  );

  -- ---------- Geocoding data, partitioned by region ----------

  -- Named things: countries, states, cities, districts, localities, streets, points of interest.
  CREATE TABLE features (
    id bigint NOT NULL,
    region text NOT NULL,
    osm_type char(1) NOT NULL,
    osm_id bigint NOT NULL,
    osm_key text NOT NULL,
    osm_value text NOT NULL,
    layer text NOT NULL,
    importance real NOT NULL DEFAULT 0,
    country_code text,
    name text NOT NULL,
    -- {"fr": "...", "en": "...", "alt": ["...", ...]}, only the languages kept for the region.
    names jsonb NOT NULL DEFAULT '{}',
    housenumber text,
    street text,
    postcode text,
    district text,
    city text,
    county text,
    state text,
    -- The address parts in the kept languages: {"fr": {"city": "...", ...}, ...}
    address_i18n jsonb NOT NULL DEFAULT '{}',
    extra jsonb NOT NULL DEFAULT '{}',
    centroid geometry(Point, 4326) NOT NULL,
    -- [west, north, east, south], as Photon's "extent"
    extent real[],
    -- Lines and areas, for streets and administrative areas only (reverse geocoding, containment).
    geom geometry(Geometry, 4326),
    -- Everything a query can match: names in every kept language (A), the street (B), the area (C).
    search tsvector GENERATED ALWAYS AS (
      setweight(to_tsvector('simple', geo_norm(name || ' ' || (jsonb_path_query_array(names, '$.*') #>> '{}'))), 'A') ||
      setweight(to_tsvector('simple', geo_norm(coalesce(street, '') || ' ' || coalesce(housenumber, '') || ' ' || coalesce(postcode, ''))), 'B') ||
      setweight(to_tsvector('simple', geo_norm(coalesce(district, '') || ' ' || coalesce(city, '') || ' ' || coalesce(county, '') || ' ' || coalesce(state, ''))), 'C')
    ) STORED
  ) PARTITION BY LIST (region);

  -- House numbers without a name of their own: most of the data, only searched when a query has a number.
  CREATE TABLE addresses (
    id bigint NOT NULL,
    region text NOT NULL,
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
  ) PARTITION BY LIST (region);

  -- The parents' partitioned indexes: the same definitions as each region's (see regionIndexes).
  ${regionIndexes("features", "addresses")}
  `,
];

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

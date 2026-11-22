// Everything set in the dashboard, live: kept in the settings table, cached here, applied at once.

import { DUMP_BASE_URL } from "./config.ts";
import { sql } from "./db.ts";
import { bad } from "./http.ts";

/** The API's endpoints, for keys' scopes and the "require a key" switches. */
export const ENDPOINTS = ["autocomplete", "search", "reverse", "photon"] as const;
export type Endpoint = (typeof ENDPOINTS)[number];

export interface Settings {
  access: {
    /** Require an API key on every endpoint… */
    requireKey: boolean;
    /** …or only on these (when requireKey is off). */
    requireKeyFor: Endpoint[];
    /** Requests per minute per IP address without a key (0: unlimited). */
    ipPerMinute: number;
    /** Requests per minute per key, unless the key sets its own (0: unlimited). */
    keyPerMinute: number;
    /** Websites allowed to call the API from a browser (CORS); "*" for any, empty for none. */
    corsOrigins: string[];
  };
  results: {
    defaultLimit: number;
    maxLimit: number;
    /** Languages answers default to, the first one first ("fr", "en"…). */
    defaultLanguage: string;
    /** Layers returned unless a request asks for others. */
    layers: string[];
    /** The reverse geocoder's default radius, in metres. */
    reverseRadius: number;
  };
  ranking: {
    /** How much a place's importance counts (0–2). */
    importance: number;
    /** Bonus when the name starts with what was typed. */
    prefix: number;
    /** Bonus when every word typed is in the name itself (not only in the address). */
    nameMatch: number;
    /** Bonus for being near the location given (fades over `nearKm`). */
    near: number;
    nearKm: number;
  };
  data: {
    /** Languages kept for new imports, besides each place's default name. */
    languages: string[];
    /** Keep house numbers in new imports (most of the data). */
    houseNumbers: boolean;
    /** Where the Photon dumps come from: GraphHopper's server, or a mirror with the same layout. */
    dumpBaseUrl: string;
    /** Photon dump version to download ("1.0"). */
    dumpVersion: string;
    /** Update regions automatically every this many days (0: never). */
    updateEveryDays: number;
  };
}

export const DEFAULTS: Settings = {
  access: { requireKey: false, requireKeyFor: [], ipPerMinute: 120, keyPerMinute: 600, corsOrigins: ["*"] },
  results: { defaultLimit: 8, maxLimit: 50, defaultLanguage: "fr", layers: ["house", "street", "locality", "district", "city", "county", "state", "country", "other"], reverseRadius: 1000 },
  ranking: { importance: 1, prefix: 0.6, nameMatch: 0.4, near: 0.5, nearKm: 50 },
  data: { languages: ["fr", "en", "de", "nl"], houseNumbers: true, dumpBaseUrl: DUMP_BASE_URL, dumpVersion: "1.0", updateEveryDays: 7 },
};

let current: Settings = structuredClone(DEFAULTS);

export const settings = () => current;

export async function loadSettings() {
  const rows = await sql<{ key: keyof Settings; value: object }[]>`SELECT key, value FROM settings`;
  const next = structuredClone(DEFAULTS);
  for (const { key, value } of rows) if (key in next) Object.assign(next[key], value);
  current = next;
}

// ---------- Validation ----------

const LANG = /^[a-z]{2,3}$/;
const num = (v: unknown, min: number, max: number, name: string) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${name} should be between ${min} and ${max}`);
  return n;
};
const bool = (v: unknown, name: string) => {
  if (typeof v !== "boolean") throw bad(`${name} should be true or false`);
  return v;
};
const strings = (v: unknown, name: string, test: (s: string) => boolean) => {
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string" && test(s))) throw bad(`${name} isn't valid`);
  return [...new Set(v as string[])];
};

/** An http(s) URL without a trailing slash, for the dump server. */
function dumpUrl(v: unknown): string {
  const s = String(v ?? "").trim().replace(/\/+$/, "");
  try {
    const u = new URL(s);
    if ((u.protocol === "https:" || u.protocol === "http:") && !u.search && !u.hash) return s;
  } catch {
    // Reported below.
  }
  throw bad("The download server should be an http(s) address, like https://download1.graphhopper.com/public");
}

/** Checks a section sent by the dashboard and returns it complete (missing fields keep their value). */
function validate<K extends keyof Settings>(key: K, input: Record<string, unknown>): Settings[K] {
  const merged = { ...current[key], ...input } as Record<string, unknown>;
  switch (key) {
    case "access":
      return {
        requireKey: bool(merged.requireKey, "Require a key"),
        requireKeyFor: strings(merged.requireKeyFor, "Endpoints", (s) => (ENDPOINTS as readonly string[]).includes(s)) as Endpoint[],
        ipPerMinute: num(merged.ipPerMinute, 0, 100_000, "Requests per minute per IP"),
        keyPerMinute: num(merged.keyPerMinute, 0, 1_000_000, "Requests per minute per key"),
        corsOrigins: strings(merged.corsOrigins, "Allowed websites", (s) => s === "*" || /^https?:\/\/[^/\s]+$/.test(s)),
      } as Settings[K];
    case "results": {
      const maxLimit = num(merged.maxLimit, 1, 200, "Maximum results");
      return {
        defaultLimit: num(merged.defaultLimit, 1, maxLimit, "Default results"),
        maxLimit,
        defaultLanguage: LANG.test(String(merged.defaultLanguage)) ? String(merged.defaultLanguage) : (() => { throw bad("Default language isn't valid"); })(),
        layers: strings(merged.layers, "Layers", (s) => /^[a-z]+$/.test(s)),
        reverseRadius: num(merged.reverseRadius, 10, 100_000, "Reverse radius"),
      } as Settings[K];
    }
    case "ranking":
      return {
        importance: num(merged.importance, 0, 5, "Importance"),
        prefix: num(merged.prefix, 0, 5, "Name starts with"),
        nameMatch: num(merged.nameMatch, 0, 5, "Words in the name"),
        near: num(merged.near, 0, 5, "Nearness"),
        nearKm: num(merged.nearKm, 1, 5000, "Nearness distance"),
      } as Settings[K];
    case "data":
      return {
        languages: strings(merged.languages, "Languages", (s) => LANG.test(s)),
        houseNumbers: bool(merged.houseNumbers, "House numbers"),
        dumpBaseUrl: dumpUrl(merged.dumpBaseUrl),
        dumpVersion: /^[\w.-]{1,20}$/.test(String(merged.dumpVersion)) ? String(merged.dumpVersion) : (() => { throw bad("Dump version isn't valid"); })(),
        updateEveryDays: num(merged.updateEveryDays, 0, 365, "Update every"),
      } as Settings[K];
  }
  throw bad("Unknown settings");
}

export async function updateSettings(key: string, input: unknown) {
  if (!(key in DEFAULTS)) throw bad("Unknown settings");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad();
  const k = key as keyof Settings;
  const value = validate(k, input as Record<string, unknown>);
  await sql`INSERT INTO settings (key, value) VALUES (${k}, ${sql.json(value as never)})
            ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`;
  (current as unknown as Record<string, unknown>)[k] = value;
  return current;
}

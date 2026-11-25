// Talking to the GeoPol server (same origin; Vite proxies /api in development).

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    if (res.status === 401 && path.startsWith("/app/")) window.dispatchEvent(new Event("geopol:signed-out"));
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const query = (params: Record<string, string | number | undefined | null>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

// --- Types (mirroring the server) ---

export const ROLES = ["user", "admin"] as const;
export type Role = (typeof ROLES)[number];
export const isAdmin = (u: { role: Role }) => u.role === "admin";

export const ENDPOINTS = ["autocomplete", "search", "reverse", "photon"] as const;
export type Endpoint = (typeof ENDPOINTS)[number];

export const LAYERS = ["house", "street", "locality", "district", "city", "county", "state", "country", "other"] as const;

export interface Me {
  id: string;
  name: string;
  email: string | null;
  role: Role;
  ssoLinked: boolean;
  createdAt: string;
}

export interface AuthConfig {
  oidc: { name: string } | null;
  dev: boolean;
}

export interface ServerInfo {
  oidc: { name: string; adminGroups: boolean } | null;
  version: string;
  importWorkers: number;
  /** Where the API answers (for the examples). */
  publicUrl: string;
}

export interface UpdateStatus {
  current: string;
  latest: { version: string; url: string; publishedAt: string | null } | null;
  available: boolean;
  releasesUrl: string;
  checkedAt: string | null;
  disabled?: boolean;
  error?: string;
}

export interface Session {
  id: string;
  method: string;
  userAgent: string;
  ip: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

export interface AdminUser {
  id: string;
  name: string;
  email: string | null;
  role: Role;
  ssoLinked: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}

/** An installed region. */
export interface Region {
  id: string;
  name: string;
  path: string;
  sourceUrl: string;
  dumpDate: string | null;
  importedAt: string | null;
  features: number;
  addresses: number;
  languages: string[];
  houseNumbers: boolean;
  autoUpdate: boolean;
  bytes: number;
  /** ISO codes of the countries it holds (lowercase). */
  countries: string[];
}

/** A region that can be installed (GraphHopper's Photon dumps). */
export interface CatalogRegion {
  id: string;
  path: string;
  name: string;
  continent: string;
  isContinent: boolean;
  url: string;
  bytes: number | null;
  updatedAt: string | null;
}

export interface JobProgress {
  phase?: "download" | "rows" | "indexes" | "swap" | "done";
  lines?: number;
  features?: number;
  addresses?: number;
  bytes?: number;
  totalBytes?: number | null;
}

export interface Job {
  id: string;
  region: string;
  name: string;
  path: string;
  action: "install" | "update";
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  options: { languages: string[]; houseNumbers: boolean; url: string };
  progress: JobProgress;
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: Endpoint[];
  ratePerMinute: number | null;
  dailyQuota: number | null;
  origins: string[];
  ips: string[];
  expiresAt: string | null;
  disabled: boolean;
  createdBy: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  requestsToday?: number;
  requests30d?: number;
  /** Only when it's created. */
  key?: string;
}

/** The shapes /v1/… can answer in. */
export const FORMATS = ["geopol", "geojson", "photon", "compact"] as const;
export type Format = (typeof FORMATS)[number];

export interface ServiceSettings {
  access: { requireKey: boolean; requireKeyFor: Endpoint[]; ipPerMinute: number; keyPerMinute: number; corsOrigins: string[] };
  results: { defaultLimit: number; maxLimit: number; defaultLanguage: string; layers: string[]; reverseRadius: number; format: Format };
  ranking: { importance: number; prefix: number; nameMatch: number; near: number; nearKm: number };
  data: { languages: string[]; houseNumbers: boolean; dumpBaseUrl: string; dumpVersion: string; updateEveryDays: number };
  /** Groups of words that mean the same in a query. */
  text: { synonyms: string[][] };
  /** Results never returned: OSM ids ("N123", "X4" for a custom place) and name patterns ("*test*"). */
  blocklist: { ids: string[]; names: string[] };
  cache: { enabled: boolean; ttlSeconds: number; maxEntries: number };
}

export interface CacheStats {
  entries: number;
  hits: number;
  misses: number;
  hitRate: number | null;
  since: string;
}

/** A place added in the dashboard (OSM type "X"). */
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

export type UsageGrain = "daily" | "weekly" | "monthly";
export interface UsageRow {
  period: string;
  endpoint: Endpoint;
  requests: number;
  errors: number;
}

export interface Overview {
  totals: { regions: number; features: number; addresses: number; databaseBytes: number };
  /** Requests per period (YYYY-MM-DD: a day, the Monday of a week, the 1st of a month) and endpoint. */
  usage: Record<UsageGrain, UsageRow[]>;
  /** The keys used most over 30 days (id "": requests without a key; name null: a deleted key). */
  topKeys: { id: string; name: string | null; prefix: string | null; requests: number; errors: number }[];
  keys: { total: number; active: number };
  latency: Partial<Record<Endpoint, { samples: number; p50: number | null; p95: number | null; max: number | null }>>;
  job: { id: number; progress: JobProgress | null } | null;
}

/** A geocoding result (GeoPol's own format, /v1/…). */
export interface GeoResult {
  id: string;
  layer: string;
  label: string;
  name: string | null;
  address: {
    housenumber: string | null;
    street: string | null;
    postcode: string | null;
    district: string | null;
    city: string | null;
    county: string | null;
    state: string | null;
    country: string | null;
    countryCode: string | null;
  };
  lat: number;
  lon: number;
  extent: number[] | null;
  distance?: number;
  osm: { type: string; id: number; key: string; value: string };
  region: string;
}

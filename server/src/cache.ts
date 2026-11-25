// The API's response cache: identical requests within the TTL get the answer the first one computed,
// from memory, without touching the database. Least recently used answers go first when it's full.
//
// Anything that could change an answer empties it: a settings change, a custom place or blocklist
// edit, an import or a region removed. Access checks, limits and usage counting still run on a hit.

import { settings } from "./settings.ts";

interface Entry {
  body: unknown;
  until: number;
}

const entries = new Map<string, Entry>();
let hits = 0;
let misses = 0;
let since = new Date();

/** The cache key: the path and its parameters, sorted, without the API key. */
export function cacheKey(path: string, params: URLSearchParams): string {
  const kept = [...params.entries()].filter(([k]) => k !== "api_key").sort(([a, x], [b, y]) => a.localeCompare(b) || x.localeCompare(y));
  return `${path}?${new URLSearchParams(kept).toString()}`;
}

export function cached(key: string): unknown | undefined {
  const c = settings().cache;
  if (!c.enabled) return undefined;
  const e = entries.get(key);
  if (!e || e.until <= Date.now()) {
    if (e) entries.delete(key);
    misses++;
    return undefined;
  }
  // Most recently used last.
  entries.delete(key);
  entries.set(key, e);
  hits++;
  return e.body;
}

export function remember(key: string, body: unknown) {
  const c = settings().cache;
  if (!c.enabled || c.ttlSeconds <= 0) return;
  entries.delete(key);
  entries.set(key, { body, until: Date.now() + c.ttlSeconds * 1000 });
  while (entries.size > c.maxEntries) entries.delete(entries.keys().next().value!);
}

/** Forgets every answer (something they depend on changed). */
export function clearCache() {
  entries.clear();
}

/** Forgets the answers and the counters. */
export function resetCache() {
  entries.clear();
  hits = 0;
  misses = 0;
  since = new Date();
}

export function cacheStats() {
  const now = Date.now();
  let live = 0;
  for (const e of entries.values()) if (e.until > now) live++;
  return { entries: live, hits, misses, hitRate: hits + misses ? hits / (hits + misses) : null, since: since.toISOString() };
}

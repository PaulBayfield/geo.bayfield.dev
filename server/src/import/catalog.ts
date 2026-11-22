// The regions that can be installed: GraphHopper publishes a Photon dump per continent and per country
// (or group of countries) at <server>/<continent>/<country>/photon-dump-<country>-<version>-latest.jsonl.zst.
// The server is set in Settings → Data (GeoPol's default: DUMP_BASE_URL, GraphHopper's mirror); any mirror
// with the same layout works.
// Read from its index pages, with each dump's size and date (HEAD), cached for a few hours.

import { HttpError } from "../http.ts";
import { settings } from "../settings.ts";

export interface CatalogRegion {
  /** "europe-belgium", or "europe" for a whole continent. */
  id: string;
  /** "europe/belgium". */
  path: string;
  name: string;
  continent: string;
  /** A whole continent's dump. */
  isContinent: boolean;
  url: string;
  bytes: number | null;
  updatedAt: string | null;
}

/** Names that don't read well from the folder name. */
const NAMES: Record<string, string> = {
  "france-monacco": "France & Monaco",
  "british-islands": "British Isles",
  "switzerland-liechtenstein": "Switzerland & Liechtenstein",
  "iceland-faroe": "Iceland & Faroe Islands",
  "bosnia-herzegovina": "Bosnia & Herzegovina",
  luxemburg: "Luxembourg",
  macedonia: "North Macedonia",
  baltics: "Baltic states",
  "australia-oceania": "Australia & Oceania",
  "north-america": "North America",
  "south-america": "South America",
  "central-america": "Central America",
  "us-midwest": "US Midwest",
  "us-northeast": "US Northeast",
  "us-pacific": "US Pacific",
  "us-south": "US South",
  "us-west": "US West",
  "gcc-states": "Gulf states",
  "israel-and-palestine": "Israel & Palestine",
  "malaysia-singapore-brunei": "Malaysia, Singapore & Brunei",
  "senegal-and-gambia": "Senegal & Gambia",
  "congo-democratic-republic": "DR Congo",
  "congo-brazzaville": "Congo",
  "ivory-coast": "Côte d'Ivoire",
  "haiti-and-domrep": "Haiti & Dominican Republic",
  kenia: "Kenya",
  isreal: "Israel & Palestine",
  "africa-eastern-islands": "Madagascar & islands",
  "south-america-north": "Venezuela, Guyana & Suriname",
  "south-atlantic": "Falklands & South Georgia",
};

const title = (slug: string) => NAMES[slug] ?? slug.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

/** The folders an index page links to, under `base`. */
async function folders(base: string): Promise<string[]> {
  const res = await fetch(`${base}/index.html`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`it answered ${res.status}`);
  const html = await res.text();
  const out = new Set<string>();
  for (const m of html.matchAll(/href="([^"]+)\/index\.html"/g)) {
    const href = m[1];
    if (href.startsWith(base + "/") && !href.slice(base.length + 1).includes("/")) out.add(href.slice(base.length + 1));
  }
  return [...out];
}

async function head(url: string): Promise<{ bytes: number | null; updatedAt: string | null } | null> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const length = Number(res.headers.get("content-length"));
    const modified = res.headers.get("last-modified");
    return { bytes: Number.isFinite(length) ? length : null, updatedAt: modified ? new Date(modified).toISOString() : null };
  } catch {
    return null;
  }
}

/** Runs `fn` on every item, `n` at a time. */
async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const dumpUrl = (base: string, path: string, version: string) => `${base}/${path}/photon-dump-${path.split("/").at(-1)}-${version}-latest.jsonl.zst`;

let cached: { regions: CatalogRegion[]; key: string; until: number } | null = null;
let pending: Promise<CatalogRegion[]> | null = null;

export async function catalog(force = false): Promise<CatalogRegion[]> {
  const { dumpVersion: version, dumpBaseUrl: base } = settings().data;
  // Read again when the server or the version changes.
  const key = `${base}|${version}`;
  if (!force && cached && cached.key === key && cached.until > Date.now()) return cached.regions;
  pending ??= (async () => {
    try {
      const continents = await folders(base).catch((e: Error) => {
        throw new HttpError(503, `The download server ${base} couldn't be read (${e.message}): check Settings → Data`);
      });
      const candidates: Omit<CatalogRegion, "bytes" | "updatedAt">[] = [];
      for (const continent of continents) {
        candidates.push({ id: continent, path: continent, name: title(continent), continent, isContinent: true, url: dumpUrl(base, continent, version) });
        for (const country of await folders(`${base}/${continent}`).catch(() => [])) {
          const path = `${continent}/${country}`;
          candidates.push({ id: `${continent}-${country}`, path, name: title(country), continent, isContinent: false, url: dumpUrl(base, path, version) });
        }
      }
      const sizes = await pool(candidates, 8, (c) => head(c.url));
      // A region without a dump of this version isn't offered.
      const regions = candidates.flatMap((c, i) => (sizes[i] ? [{ ...c, ...sizes[i] }] : []));
      regions.sort((a, b) => a.continent.localeCompare(b.continent) || Number(b.isContinent) - Number(a.isContinent) || a.name.localeCompare(b.name));
      cached = { regions, key, until: Date.now() + 6 * 60 * 60_000 };
      return regions;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

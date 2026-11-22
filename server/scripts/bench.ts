// Spike benchmark: autocomplete and reverse timings on the imported data.
//   node --env-file-if-exists=.env scripts/bench.ts

import { sql } from "../src/db.ts";
import { autocomplete, reverse, type Hit } from "../src/geocode.ts";

const label = (h: Hit) =>
  [h.name ?? [h.street, h.housenumber].filter(Boolean).join(" "), h.name && h.street ? `${h.street} ${h.housenumber ?? ""}`.trim() : null, h.postcode, h.city]
    .filter(Boolean)
    .join(", ") + ` [${h.layer}${h.distance !== undefined ? ` ${Math.round(h.distance)} m` : ""}]`;

async function time<T>(fn: () => Promise<T>, runs = 5): Promise<{ result: T; best: number; median: number }> {
  const times: number[] = [];
  let result!: T;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    result = await fn();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return { result, best: times[0], median: times[Math.floor(times.length / 2)] };
}

const brussels = { lat: 50.8467, lon: 4.3525 };
const queries: [string, Parameters<typeof autocomplete>[1]?][] = [
  ["b"],
  ["br"],
  ["brux"],
  ["bruxelles"],
  ["anvers"],
  ["antwerpen centr"],
  ["rue de la loi"],
  ["rue de la loi 16"],
  ["avenue louise 54", { near: brussels }],
  ["grand place", { near: brussels }],
  ["gare liege"],
  ["rue"],
  ["rue de"],
  ["bruxels"],
  ["atomiun"],
  ["manneken"],
];

console.log("Autocomplete (best / median of 5, ms)");
for (const [q, o] of queries) {
  const { result, best, median } = await time(() => autocomplete(q, { limit: 5, ...o }));
  console.log(`${best.toFixed(1).padStart(7)} ${median.toFixed(1).padStart(7)}  ${JSON.stringify(q).padEnd(22)} → ${result.slice(0, 3).map(label).join(" | ") || "—"}`);
}

const points: [string, number, number][] = [
  ["Grand-Place, Brussels", 50.8467, 4.3525],
  ["Antwerp Central", 51.2172, 4.4211],
  ["Liège-Guillemins", 50.6245, 5.5667],
  ["Ardennes forest", 50.0606, 5.4586],
  ["North Sea (offshore)", 51.45, 2.8],
];
console.log("\nReverse (best / median of 5, ms)");
for (const [name, lat, lon] of points) {
  const { result, best, median } = await time(() => reverse(lat, lon, { radius: 2000 }));
  const parts = [result.houses[0] && label(result.houses[0]), result.streets[0] && label(result.streets[0]), result.areas.map((a) => `${a.name} (${a.layer})`).join(" < ")];
  console.log(`${best.toFixed(1).padStart(7)} ${median.toFixed(1).padStart(7)}  ${name.padEnd(24)} → ${parts.filter(Boolean).join(" · ")}`);
}

const sizes = await sql`
  SELECT relname AS name, pg_size_pretty(pg_total_relation_size(c.oid)) AS total, pg_size_pretty(pg_relation_size(c.oid)) AS heap
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'i') ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 14`;
console.log("\nSizes");
for (const s of sizes) console.log(`  ${String(s.name).padEnd(22)} ${String(s.total).padStart(9)}  (heap ${s.heap})`);
const [db] = await sql`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`;
console.log(`  database total: ${db.size}`);
await sql.end();

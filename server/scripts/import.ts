// Imports a region from the command line:
//   npm run import -- <file.jsonl.zst | https://…> --region be --name Belgium --languages fr,en,nl,de [--no-house-numbers]

import { parseArgs } from "node:util";
import { migrate, sql } from "../src/db.ts";
import { importRegion } from "../src/import/run.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    region: { type: "string" },
    name: { type: "string" },
    languages: { type: "string", default: "fr,en" },
    "no-house-numbers": { type: "boolean", default: false },
  },
});

const source = positionals[0];
if (!source || !values.region) {
  console.error("Usage: npm run import -- <file.jsonl.zst | url> --region <id> [--name <name>] [--languages fr,en] [--no-house-numbers]");
  process.exit(1);
}

await migrate();
const started = Date.now();
const secs = () => ((Date.now() - started) / 1000).toFixed(0);
const result = await importRegion({
  source,
  region: values.region,
  name: values.name ?? values.region,
  languages: values.languages.split(",").map((s) => s.trim()).filter(Boolean),
  houseNumbers: !values["no-house-numbers"],
  onProgress: (p) => {
    const pct = p.totalBytes ? ` ${((p.bytes / p.totalBytes) * 100).toFixed(1)}%` : "";
    process.stdout.write(`\r[${secs()}s] ${p.phase}${pct} · ${p.lines} lines · ${p.features} features · ${p.addresses} addresses   `);
  },
});
console.log(`\nDone in ${secs()}s: ${result.features} features, ${result.addresses} addresses`);
await sql.end();

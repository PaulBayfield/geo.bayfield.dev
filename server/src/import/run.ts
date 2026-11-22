// Imports one region from a Photon dump: streams it (zstd → lines → rows) straight into PostgreSQL
// with COPY, two streams at once (features, addresses), then builds the indexes.

import fs from "node:fs";
import readline from "node:readline";
import { Readable, type Writable } from "node:stream";
import zlib from "node:zlib";
import { INDEXES, sql } from "../db.ts";
import { ADDRESS_COLUMNS, FEATURE_COLUMNS, placeRows, type ImportOptions, type PhotonPlace } from "./photon.ts";

export interface Progress {
  phase: "download" | "rows" | "indexes" | "analyze" | "done";
  lines: number;
  features: number;
  addresses: number;
  /** Compressed bytes read so far, and the total when known. */
  bytes: number;
  totalBytes: number | null;
}

export interface ImportRequest extends ImportOptions {
  name: string;
  /** A local .jsonl.zst file or an https:// URL. */
  source: string;
  onProgress?: (p: Progress) => void;
}

/** Writes a line, waiting when the stream's buffer is full. */
function write(w: Writable, chunk: string): Promise<void> | void {
  if (!w.write(chunk)) return new Promise((resolve) => w.once("drain", resolve));
}

const finish = (w: Writable) => new Promise<void>((resolve, reject) => w.end((err?: Error | null) => (err ? reject(err) : resolve())));

async function open(source: string): Promise<{ stream: Readable; total: number | null }> {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) from ${source}`);
    const length = Number(res.headers.get("content-length"));
    return { stream: Readable.fromWeb(res.body as never), total: Number.isFinite(length) && length > 0 ? length : null };
  }
  return { stream: fs.createReadStream(source), total: fs.statSync(source).size };
}

export async function importRegion(req: ImportRequest) {
  const progress: Progress = { phase: "download", lines: 0, features: 0, addresses: 0, bytes: 0, totalBytes: null };
  const report = () => req.onProgress?.({ ...progress });

  // Spike: replace the region in place. (The app will import into staging tables and swap.)
  await sql`INSERT INTO regions (id, name, source_url) VALUES (${req.region}, ${req.name}, ${req.source})
            ON CONFLICT (id) DO UPDATE SET name = excluded.name, source_url = excluded.source_url`;
  await sql`DELETE FROM features WHERE region = ${req.region}`;
  await sql`DELETE FROM addresses WHERE region = ${req.region}`;

  const features = await sql`COPY features (${sql.unsafe(FEATURE_COLUMNS)}) FROM STDIN`.writable();
  const addresses = await sql`COPY addresses (${sql.unsafe(ADDRESS_COLUMNS)}) FROM STDIN`.writable();

  progress.phase = "rows";
  // Opened only now, with the pipe and the byte counter attached together: a stream starts flowing as
  // soon as something listens, and bytes read before the decompressor is attached would be lost.
  const { stream, total } = await open(req.source);
  progress.totalBytes = total;
  const input = stream.pipe(zlib.createZstdDecompress());
  stream.on("data", (chunk: Buffer) => (progress.bytes += chunk.length));
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let dumpDate: string | null = null;
  let last = 0;
  for await (const text of lines) {
    progress.lines++;
    const record = JSON.parse(text) as { type: string; content: unknown };
    if (record.type === "Place") {
      for (const p of record.content as PhotonPlace[]) {
        const rows = placeRows(p, req);
        if (rows.feature) {
          progress.features++;
          await write(features, rows.feature);
        } else if (rows.address) {
          progress.addresses++;
          await write(addresses, rows.address);
        }
      }
    } else if (record.type === "NominatimDumpFile") {
      dumpDate = (record.content as { data_timestamp?: string }).data_timestamp ?? null;
    } else if (record.type === "CountryInfo") {
      for (const c of record.content as { country_code: string; name: Record<string, string> }[]) {
        await sql`INSERT INTO countries (code, names) VALUES (${c.country_code}, ${sql.json(c.name)})
                  ON CONFLICT (code) DO UPDATE SET names = excluded.names`;
      }
    }
    if (Date.now() - last > 1000) {
      last = Date.now();
      report();
    }
  }
  await Promise.all([finish(features), finish(addresses)]);

  progress.phase = "indexes";
  report();
  await sql.unsafe(INDEXES);
  progress.phase = "analyze";
  report();
  await sql`ANALYZE features`;
  await sql`ANALYZE addresses`;
  await sql`UPDATE regions SET dump_date = ${dumpDate}, imported_at = now(), features = ${progress.features}, addresses = ${progress.addresses} WHERE id = ${req.region}`;
  progress.phase = "done";
  report();
  return progress;
}

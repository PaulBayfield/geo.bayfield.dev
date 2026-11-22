// Imports one region from a Photon dump, without downtime:
//
//   1. stream the dump (download → zstd → lines), parse it on several threads, COPY the rows into
//      two tables of its own (features_<region>_new, addresses_<region>_new)
//   2. build their indexes, analyze them
//   3. swap: detach and drop the region's old tables, attach the new ones (a quick metadata change)
//
// Until the swap, the region's old data keeps answering; if anything fails, the new tables are
// dropped and nothing changes.

import fs from "node:fs";
import readline from "node:readline";
import { Readable, type Writable } from "node:stream";
import { Worker } from "node:worker_threads";
import zlib from "node:zlib";
import { IMPORT_WORKERS } from "../config.ts";
import { regionIndexes, sql } from "../db.ts";
import { ADDRESS_COLUMNS, FEATURE_COLUMNS, type ImportOptions } from "./photon.ts";
import type { Batch, BatchResult } from "./worker.ts";

export interface Progress {
  phase: "download" | "rows" | "indexes" | "swap" | "done";
  lines: number;
  features: number;
  addresses: number;
  /** Compressed bytes read so far, and the total when known. */
  bytes: number;
  totalBytes: number | null;
}

export interface ImportRequest extends ImportOptions {
  name: string;
  path: string;
  /** A local .jsonl.zst file or an https:// URL. */
  source: string;
  onProgress?: (p: Progress) => void;
  signal?: AbortSignal;
}

/** The region's tables: letters, digits and underscores only (region ids come from the catalog). */
export function regionTables(region: string) {
  const slug = region.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40);
  return { features: `features_r_${slug}`, addresses: `addresses_r_${slug}` };
}

const BATCH_LINES = 2000;

/** Writes a chunk, waiting when the stream's buffer is full (and failing if the stream does). */
function write(w: Writable, chunk: string): Promise<void> | void {
  if (w.errored) throw w.errored;
  if (chunk && !w.write(chunk))
    return new Promise((resolve, reject) => {
      const done = () => {
        w.off("drain", done);
        w.off("error", done);
        if (w.errored) reject(w.errored);
        else resolve();
      };
      w.once("drain", done);
      w.once("error", done);
    });
}

const finish = (w: Writable) => new Promise<void>((resolve, reject) => w.end((err?: Error | null) => (err ? reject(err) : resolve())));

async function open(source: string, signal?: AbortSignal): Promise<{ stream: Readable; total: number | null }> {
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source, { signal });
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) from ${source}`);
    const length = Number(res.headers.get("content-length"));
    return { stream: Readable.fromWeb(res.body as never), total: Number.isFinite(length) && length > 0 ? length : null };
  }
  return { stream: fs.createReadStream(source), total: fs.statSync(source).size };
}

/** A small pool of parsing threads; `parse` resolves with the batch's COPY text. */
function parsers(count: number) {
  const idle: Worker[] = [];
  const waiting: ((w: Worker) => void)[] = [];
  const all: Worker[] = [];
  for (let i = 0; i < count; i++) {
    const w = new Worker(new URL("./worker.ts", import.meta.url));
    all.push(w);
    idle.push(w);
  }
  const take = () => new Promise<Worker>((resolve) => (idle.length ? resolve(idle.pop()!) : waiting.push(resolve)));
  const give = (w: Worker) => (waiting.length ? waiting.shift()!(w) : idle.push(w));
  return {
    async parse(batch: Batch): Promise<BatchResult> {
      const w = await take();
      return new Promise((resolve, reject) => {
        const onMessage = (r: BatchResult) => {
          w.off("error", onError);
          give(w);
          resolve(r);
        };
        const onError = (e: Error) => {
          w.off("message", onMessage);
          reject(e);
        };
        w.once("message", onMessage);
        w.once("error", onError);
        w.postMessage(batch);
      });
    },
    close: () => Promise.all(all.map((w) => w.terminate())),
  };
}

export async function importRegion(req: ImportRequest): Promise<Progress> {
  const progress: Progress = { phase: "download", lines: 0, features: 0, addresses: 0, bytes: 0, totalBytes: null };
  const report = () => req.onProgress?.({ ...progress });
  const final = regionTables(req.region);
  const staging = { features: `${final.features}_new`, addresses: `${final.addresses}_new` };
  const ident = (name: string) => sql(name);

  await sql`DROP TABLE IF EXISTS ${ident(staging.features)}, ${ident(staging.addresses)}`;
  await sql`CREATE TABLE ${ident(staging.features)} (LIKE features INCLUDING DEFAULTS INCLUDING GENERATED)`;
  await sql`CREATE TABLE ${ident(staging.addresses)} (LIKE addresses INCLUDING DEFAULTS)`;
  const pool = parsers(IMPORT_WORKERS);

  try {
    const features = await sql`COPY ${ident(staging.features)} (${sql.unsafe(FEATURE_COLUMNS)}) FROM STDIN`.writable();
    const addresses = await sql`COPY ${ident(staging.addresses)} (${sql.unsafe(ADDRESS_COLUMNS)}) FROM STDIN`.writable();
    // A row Postgres refuses fails the import (not the server): the error is kept and thrown below.
    let copyError: Error | null = null;
    for (const w of [features, addresses]) w.on("error", (e: Error) => (copyError ??= e));

    // Opened only now, with the pipe and the byte counter attached together: a stream starts flowing as
    // soon as something listens, and bytes read before the decompressor is attached would be lost.
    const { stream, total } = await open(req.source, req.signal);
    progress.totalBytes = total;
    progress.phase = "rows";
    const input = stream.pipe(zlib.createZstdDecompress());
    stream.on("data", (chunk: Buffer) => (progress.bytes += chunk.length));
    const lines = readline.createInterface({ input, crlfDelay: Infinity });

    let dumpDate: string | null = null;
    const countries: NonNullable<BatchResult["countries"]> = [];
    const inFlight = new Set<Promise<void>>();
    let failure: Error | null = null;
    let batch: string[] = [];
    let id = 0;
    let last = 0;
    const options: ImportOptions = { region: req.region, languages: req.languages, houseNumbers: req.houseNumbers };

    const send = (lines: string[]) => {
      const p = pool.parse({ id: id++, lines, options }).then(async (r) => {
        if (r.error) throw new Error(`The dump couldn't be read: ${r.error}`);
        if (r.dumpDate) dumpDate = r.dumpDate;
        if (r.countries) countries.push(...r.countries);
        progress.features += r.featureCount;
        progress.addresses += r.addressCount;
        await write(features, r.features);
        await write(addresses, r.addresses);
      });
      const tracked: Promise<void> = p
        .catch((e: Error) => {
          failure ??= e;
        })
        .finally(() => inFlight.delete(tracked));
      inFlight.add(tracked);
    };

    for await (const text of lines) {
      if (req.signal?.aborted) throw new Error("Cancelled");
      if (failure) throw failure;
      if (copyError) throw copyError;
      progress.lines++;
      batch.push(text);
      if (batch.length >= BATCH_LINES) {
        send(batch);
        batch = [];
        // Keep a couple of batches per thread in flight, no more (memory).
        if (inFlight.size >= IMPORT_WORKERS * 2) await Promise.race(inFlight);
      }
      if (Date.now() - last > 1000) {
        last = Date.now();
        report();
      }
    }
    if (batch.length) send(batch);
    await Promise.all(inFlight);
    if (failure) throw failure;
    if (copyError) throw copyError;
    await Promise.all([finish(features), finish(addresses)]);
    if (copyError) throw copyError;
    if (!progress.features && !progress.addresses) throw new Error("The dump had no places");

    progress.phase = "indexes";
    report();
    await sql.unsafe(regionIndexes(`"${staging.features}"`, `"${staging.addresses}"`));
    // Lets the swap attach them without scanning every row again.
    await sql.unsafe(`ALTER TABLE "${staging.features}" ADD CHECK (region = '${req.region.replace(/'/g, "''")}')`);
    await sql.unsafe(`ALTER TABLE "${staging.addresses}" ADD CHECK (region = '${req.region.replace(/'/g, "''")}')`);
    await sql`ANALYZE ${ident(staging.features)}`;
    await sql`ANALYZE ${ident(staging.addresses)}`;

    progress.phase = "swap";
    report();
    await sql.begin(async (tx) => {
      for (const kind of ["features", "addresses"] as const) {
        const [attached] = await tx`
          SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
          WHERE p.relname = ${kind} AND c.relname = ${final[kind]}`;
        if (attached) await tx.unsafe(`ALTER TABLE ${kind} DETACH PARTITION "${final[kind]}"`);
        await tx.unsafe(`DROP TABLE IF EXISTS "${final[kind]}"`);
        await tx.unsafe(`ALTER TABLE "${staging[kind]}" RENAME TO "${final[kind]}"`);
        await tx.unsafe(`ALTER TABLE ${kind} ATTACH PARTITION "${final[kind]}" FOR VALUES IN ('${req.region.replace(/'/g, "''")}')`);
      }
      for (const c of countries) {
        await tx`INSERT INTO countries (code, names) VALUES (${c.country_code}, ${tx.json(c.name)})
                 ON CONFLICT (code) DO UPDATE SET names = excluded.names`;
      }
      await tx`
        INSERT INTO regions (id, name, path, source_url, dump_date, imported_at, features, addresses, languages, house_numbers)
        VALUES (${req.region}, ${req.name}, ${req.path}, ${req.source}, ${dumpDate}, now(), ${progress.features}, ${progress.addresses}, ${req.languages}, ${req.houseNumbers})
        ON CONFLICT (id) DO UPDATE SET name = excluded.name, path = excluded.path, source_url = excluded.source_url, dump_date = excluded.dump_date,
          imported_at = excluded.imported_at, features = excluded.features, addresses = excluded.addresses,
          languages = excluded.languages, house_numbers = excluded.house_numbers`;
    });
    progress.phase = "done";
    report();
    return progress;
  } catch (e) {
    await sql`DROP TABLE IF EXISTS ${ident(staging.features)}, ${ident(staging.addresses)}`.catch(() => {});
    throw e;
  } finally {
    await pool.close();
  }
}

/** Removes a region: its tables go, the others don't notice. */
export async function removeRegion(region: string) {
  const t = regionTables(region);
  await sql.begin(async (tx) => {
    for (const kind of ["features", "addresses"] as const) {
      const [attached] = await tx`
        SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = ${kind} AND c.relname = ${t[kind]}`;
      if (attached) await tx.unsafe(`ALTER TABLE ${kind} DETACH PARTITION "${t[kind]}"`);
      await tx.unsafe(`DROP TABLE IF EXISTS "${t[kind]}", "${t[kind]}_new"`);
    }
    await tx`DELETE FROM regions WHERE id = ${region}`;
  });
}

/** Disk used by each region (its two tables and their indexes). */
export async function regionSizes(): Promise<Record<string, number>> {
  const rows = await sql<{ region: string; bytes: number }[]>`
    SELECT r.id AS region, coalesce(sum(pg_total_relation_size(c.oid)), 0)::float8 AS bytes
    FROM regions r
    LEFT JOIN pg_class c ON c.relname IN ('features_r_' || regexp_replace(lower(r.id), '[^a-z0-9]+', '_', 'g'), 'addresses_r_' || regexp_replace(lower(r.id), '[^a-z0-9]+', '_', 'g'))
    GROUP BY r.id`;
  return Object.fromEntries(rows.map((r) => [r.region, r.bytes]));
}

// Imports one region from a Photon dump, without downtime:
//
//   1. download the dump to a temporary file (resumed if the connection drops: a big country is a
//      long download, and streaming it straight into the database tied the two together)
//   2. read it (zstd → lines), parse it on several threads, COPY the rows into two tables of its own
//      (features_<region>_new, addresses_<region>_new)
//   3. build their indexes, analyze them
//   4. swap: detach and drop the region's old tables, attach the new ones (a quick metadata change)
//
// Until the swap, the region's old data keeps answering; if anything fails, the new tables are
// dropped and nothing changes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { pipeline, type Writable } from "node:stream";
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
  /** Records that couldn't be read (malformed), skipped; and the first reason. */
  skipped?: number;
  skipReason?: string;
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
/** …or fewer, when lines are big (building outlines): a batch's size is capped too (memory). */
const BATCH_BYTES = 8 * 1024 * 1024;
/** A download that receives nothing for this long is retried (resuming where it stopped). */
const STALL_MS = 60_000;
const DOWNLOAD_ATTEMPTS = 6;
/** No progress at all for this long while downloading or reading: the import fails rather than hang. */
const WATCHDOG_MS = 15 * 60_000;

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

/**
 * Downloads `url` to `file`, resuming with Range requests when the connection drops or stalls (nothing
 * received for STALL_MS). Calls `onBytes` with the bytes written so far and the total size.
 */
async function download(url: string, file: string, signal: AbortSignal, onBytes: (bytes: number, total: number | null) => void) {
  let bytes = 0;
  let total: number | null = null;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    if (signal.aborted) throw new Error("Cancelled");
    const stall = new AbortController();
    const abort = () => stall.abort();
    signal.addEventListener("abort", abort, { once: true });
    let timer = setTimeout(abort, STALL_MS);
    try {
      const res = await fetch(url, { signal: stall.signal, headers: bytes > 0 ? { Range: `bytes=${bytes}-` } : {} });
      if (res.status === 416 && total !== null && bytes >= total) return;
      if (!res.ok || !res.body) throw new Error(`the server answered ${res.status}`);
      // The server ignored the range: start over.
      if (bytes > 0 && res.status !== 206) bytes = 0;
      const length = Number(res.headers.get("content-length"));
      if (Number.isFinite(length) && length > 0) total = bytes + length;
      const out = fs.createWriteStream(file, { flags: bytes > 0 ? "a" : "w" });
      try {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          clearTimeout(timer);
          timer = setTimeout(abort, STALL_MS);
          bytes += value.length;
          if (!out.write(value)) await new Promise((r) => out.once("drain", r));
          onBytes(bytes, total);
        }
      } finally {
        await new Promise<void>((r) => out.end(() => r()));
      }
      if (total !== null && bytes < total) throw new Error(`the download stopped at ${bytes} of ${total} bytes`);
      return;
    } catch (e) {
      if (signal.aborted) throw new Error("Cancelled");
      lastError = stall.signal.aborted ? new Error(`nothing received for ${STALL_MS / 1000} s`) : (e as Error);
      console.warn(`Download of ${url} interrupted (attempt ${attempt}/${DOWNLOAD_ATTEMPTS}, ${bytes} bytes): ${lastError.message}`);
      await new Promise((r) => setTimeout(r, Math.min(30_000, 2000 * attempt)));
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
  throw new Error(`Download failed after ${DOWNLOAD_ATTEMPTS} attempts: ${lastError?.message ?? "unknown error"}`);
}

/**
 * The lines of a JSON Lines stream, split on line feeds only. (readline also breaks on a lone carriage
 * return, and some OSM names contain one: France's dump has a hotel whose name readline cut in two.)
 */
async function* jsonLines(input: AsyncIterable<Buffer>): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8");
  let rest = "";
  for await (const chunk of input) {
    const text = rest + decoder.decode(chunk, { stream: true });
    let start = 0;
    let end: number;
    while ((end = text.indexOf("\n", start)) !== -1) {
      if (end > start) yield text.slice(start, end);
      start = end + 1;
    }
    rest = text.slice(start);
  }
  rest += decoder.decode();
  // Complete dumps end with a line feed; a last line cut short means the file is incomplete (the zstd
  // decoder doesn't notice a truncated file: it just stops), and importing it would lose places quietly.
  if (rest.trim()) throw new Error("The dump ends in the middle of a record: the file is incomplete");
}

/** Where dumps wait between download and import (deleted afterwards). */
const IMPORT_DIR = process.env.IMPORT_DIR?.trim() || path.join(os.tmpdir(), "geopol-imports");

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
  // Fails the import if nothing moves for WATCHDOG_MS while downloading or reading (never hang).
  const stop = new AbortController();
  const signal = req.signal ? AbortSignal.any([req.signal, stop.signal]) : stop.signal;
  let moved = Date.now();
  let stalled = false;
  const watchdog = setInterval(() => {
    if ((progress.phase === "download" || progress.phase === "rows") && Date.now() - moved > WATCHDOG_MS) {
      stalled = true;
      stop.abort();
    }
  }, 30_000);
  const remote = /^https?:\/\//.test(req.source);
  const file = remote ? path.join(IMPORT_DIR, `${final.features}.jsonl.zst`) : req.source;

  // The COPY streams, kept out here so a failure can close them (an open COPY holds locks on the
  // tables, and the cleanup's DROP TABLE would wait on it forever).
  let copies: Writable[] = [];

  try {
    if (remote) {
      fs.mkdirSync(IMPORT_DIR, { recursive: true });
      await download(req.source, file, signal, (bytes, total) => {
        progress.bytes = bytes;
        progress.totalBytes = total;
        moved = Date.now();
        report();
      });
    }

    const features = await sql`COPY ${ident(staging.features)} (${sql.unsafe(FEATURE_COLUMNS)}) FROM STDIN`.writable();
    const addresses = await sql`COPY ${ident(staging.addresses)} (${sql.unsafe(ADDRESS_COLUMNS)}) FROM STDIN`.writable();
    copies = [features, addresses];
    // A row Postgres refuses fails the import (not the server): the error is kept and thrown below.
    let copyError: Error | null = null;
    for (const w of [features, addresses]) w.on("error", (e: Error) => (copyError ??= e));

    // Read from disk. pipeline() passes errors on (pipe() doesn't: a failed read used to leave the
    // import waiting forever); the byte counter is attached with it, before anything flows.
    progress.phase = "rows";
    progress.bytes = 0;
    progress.totalBytes = fs.statSync(file).size;
    const stream = fs.createReadStream(file);
    const input = zlib.createZstdDecompress();
    stream.on("data", (chunk: Buffer | string) => {
      progress.bytes += chunk.length;
      moved = Date.now();
    });
    pipeline(stream, input, (err) => err && input.destroy(err));
    const lines = jsonLines(input);

    let dumpDate: string | null = null;
    const countries: NonNullable<BatchResult["countries"]> = [];
    const inFlight = new Set<Promise<void>>();
    let failure: Error | null = null;
    let batch: string[] = [];
    let batchBytes = 0;
    let id = 0;
    let last = 0;
    const options: ImportOptions = { region: req.region, languages: req.languages, houseNumbers: req.houseNumbers };

    const send = (lines: string[]) => {
      const p = pool.parse({ id: id++, lines, options }).then(async (r) => {
        if (r.error) throw new Error(`The dump couldn't be read: ${r.error}`);
        if (r.skipped) {
          progress.skipped = (progress.skipped ?? 0) + r.skipped;
          progress.skipReason ??= r.skipReason;
        }
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
      if (signal.aborted) throw new Error(stalled ? "stalled" : "Cancelled");
      if (failure) throw failure;
      if (copyError) throw copyError;
      progress.lines++;
      batch.push(text);
      batchBytes += text.length;
      if (batch.length >= BATCH_LINES || batchBytes >= BATCH_BYTES) {
        send(batch);
        batch = [];
        batchBytes = 0;
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
    // A few malformed records are skipped; a dump that's mostly unreadable isn't imported.
    if ((progress.skipped ?? 0) > (progress.features + progress.addresses) / 100) {
      throw new Error(`Too many records couldn't be read (${progress.skipped}): ${progress.skipReason}`);
    }
    if (progress.skipped) console.warn(`${req.name}: skipped ${progress.skipped} malformed records (first: ${progress.skipReason})`);

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
    console.warn(`Import of ${req.name} failed (${progress.phase}, ${progress.lines} lines):`, e);
    await dropStaging(copies, staging);
    if (stalled) throw new Error(`The import stalled: no progress for ${WATCHDOG_MS / 60_000} minutes (${progress.phase})`);
    throw e;
  } finally {
    clearInterval(watchdog);
    await pool.close();
    if (remote) fs.rmSync(file, { force: true });
  }
}

/**
 * After a failure: closes the COPY streams and drops the half-filled tables. A COPY connection that
 * still holds its lock after a few seconds is terminated, so the DROP can never block the job.
 */
async function dropStaging(copies: Writable[], staging: { features: string; addresses: string }) {
  for (const w of copies) if (!w.destroyed) w.destroy(new Error("Import failed"));
  const drop = () => sql.begin(async (tx) => {
    await tx`SET LOCAL lock_timeout = '5s'`;
    await tx`DROP TABLE IF EXISTS ${tx(staging.features)}, ${tx(staging.addresses)}`;
  });
  try {
    await drop();
  } catch {
    await sql`
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE pid <> pg_backend_pid() AND datname = current_database()
        AND (query LIKE ${`COPY "${staging.features}"%`} OR query LIKE ${`COPY "${staging.addresses}"%`})`.catch(() => {});
    await drop().catch((e) => console.warn("Couldn't drop the import's tables (the next import of this region will):", e));
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

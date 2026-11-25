// Region imports, one at a time, in the background: queued from the dashboard (install, update) or by
// the scheduler (Settings → Data → update every N days). Progress is written to the jobs table every
// couple of seconds and kept in memory for the dashboard's live view.

import { clearCache } from "../cache.ts";
import { sql } from "../db.ts";
import { loadCountries } from "../geocode.ts";
import { HttpError } from "../http.ts";
import { settings } from "../settings.ts";
import { catalog } from "./catalog.ts";
import { importRegion, removeRegion, type Progress } from "./run.ts";

export interface Job {
  id: number;
  region: string;
  name: string;
  path: string;
  action: "install" | "update";
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  options: { languages: string[]; houseNumbers: boolean; url: string };
  progress: Partial<Progress>;
  error: string | null;
  createdBy: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** The running job's live progress, and how to stop it. */
let running: { id: number; progress: Progress | null; abort: AbortController } | null = null;

export const liveProgress = () => (running ? { id: running.id, progress: running.progress } : null);

/** Queues an install or update of a catalog region (or does nothing if one is already queued or running). */
export async function enqueue(regionId: string, by: string | null, opts: { languages?: string[]; houseNumbers?: boolean } = {}): Promise<Job> {
  const region = (await catalog()).find((r) => r.id === regionId);
  if (!region) throw new HttpError(404, "This region isn't in the catalog (any more)");
  const [busy] = await sql<Job[]>`SELECT * FROM jobs WHERE region = ${regionId} AND status IN ('queued', 'running')`;
  if (busy) return busy;
  const [installed] = await sql<{ languages: string[]; houseNumbers: boolean }[]>`SELECT languages, house_numbers FROM regions WHERE id = ${regionId}`;
  const d = settings().data;
  const options = {
    languages: opts.languages ?? installed?.languages ?? d.languages,
    houseNumbers: opts.houseNumbers ?? installed?.houseNumbers ?? d.houseNumbers,
    url: region.url,
  };
  const [job] = await sql<Job[]>`
    INSERT INTO jobs (region, name, path, action, options, created_by)
    VALUES (${regionId}, ${region.name}, ${region.path}, ${installed ? "update" : "install"}, ${sql.json(options)}, ${by})
    RETURNING *`;
  void runNext();
  return job;
}

export async function cancel(id: number) {
  if (running?.id === id) running.abort.abort();
  await sql`UPDATE jobs SET status = 'cancelled', finished_at = now() WHERE id = ${id} AND status = 'queued'`;
}

export async function remove(regionId: string) {
  const [busy] = await sql`SELECT 1 FROM jobs WHERE region = ${regionId} AND status = 'running'`;
  if (busy) throw new HttpError(409, "This region is being imported: cancel the import first");
  await sql`UPDATE jobs SET status = 'cancelled', finished_at = now() WHERE region = ${regionId} AND status = 'queued'`;
  await removeRegion(regionId);
  clearCache();
}

let draining = false;

async function runNext() {
  if (draining || running) return;
  draining = true;
  try {
    for (;;) {
      const [job] = await sql<Job[]>`SELECT * FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1`;
      if (!job) return;
      await run(job);
    }
  } finally {
    draining = false;
  }
}

async function run(job: Job) {
  const abort = new AbortController();
  running = { id: job.id, progress: null, abort };
  await sql`UPDATE jobs SET status = 'running', started_at = now() WHERE id = ${job.id}`;
  let saved = 0;
  try {
    const result = await importRegion({
      region: job.region,
      name: job.name,
      path: job.path,
      source: job.options.url,
      languages: job.options.languages,
      houseNumbers: job.options.houseNumbers,
      signal: abort.signal,
      onProgress: (p) => {
        if (running) running.progress = p;
        if (Date.now() - saved > 2000) {
          saved = Date.now();
          void sql`UPDATE jobs SET progress = ${sql.json(p as never)} WHERE id = ${job.id}`.catch(() => {});
        }
      },
    });
    await sql`UPDATE jobs SET status = 'done', progress = ${sql.json(result as never)}, finished_at = now() WHERE id = ${job.id}`;
    await loadCountries();
    clearCache();
    console.log(`Imported ${job.name}: ${result.features} features, ${result.addresses} addresses`);
  } catch (e) {
    const cancelled = abort.signal.aborted;
    const message = cancelled ? "Cancelled" : (e as Error).message;
    console.warn(`Import of ${job.name} failed:`, e);
    await sql`UPDATE jobs SET status = ${cancelled ? "cancelled" : "failed"}, error = ${message}, finished_at = now() WHERE id = ${job.id}`;
  } finally {
    running = null;
  }
}

/** At startup: an import that was running when the server stopped won't finish. Then resume the queue. */
export async function resumeJobs() {
  await sql`UPDATE jobs SET status = 'failed', error = 'Interrupted: the server restarted', finished_at = now() WHERE status = 'running'`;
  void runNext();
}

/** Every hour: queue an update for regions older than the setting (Settings → Data). */
export function startScheduler() {
  const tick = async () => {
    const days = settings().data.updateEveryDays;
    if (!days) return;
    const due = await sql<{ id: string }[]>`
      SELECT id FROM regions WHERE auto_update AND imported_at < now() - make_interval(days => ${days})
        AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.region = regions.id AND status IN ('queued', 'running'))`;
    for (const r of due) await enqueue(r.id, null).catch((e) => console.warn(`Scheduled update of ${r.id} failed to queue:`, e));
  };
  setInterval(() => void tick().catch(() => {}), 60 * 60_000);
}

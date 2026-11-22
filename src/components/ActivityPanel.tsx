// The side panel: imports, the running one with its live progress, then the recent ones.

import type { Job } from "../lib/api";
import { api } from "../lib/api";
import { useApp } from "../lib/app";
import { useSettings } from "../lib/settings";
import { useToast } from "./common";
import { X } from "./icons";

export function ActivityPanel() {
  const { t, f } = useSettings();
  const { jobs, togglePanel } = useApp();
  return (
    <aside className="panel">
      <div className="panel-header">
        <span className="panel-label">{t("activity")}</span>
        <div className="toolbar-spacer" />
        <button className="icon-button small" aria-label={t("close")} onClick={togglePanel}>
          <X />
        </button>
      </div>
      <div className="panel-body">
        {jobs?.length === 0 && <p className="muted small panel-empty">{t("noJobs")}</p>}
        {(jobs ?? []).map((j) => (
          <JobRow key={j.id} job={j} />
        ))}
        {jobs && jobs.length > 0 && <p className="small muted panel-foot">{t("jobsHint", { n: f.number(jobs.length) })}</p>}
      </div>
    </aside>
  );
}

export function JobRow({ job }: { job: Job }) {
  const { t, f } = useSettings();
  const { admin, reloadJobs } = useApp();
  const toast = useToast();
  const p = job.progress ?? {};
  const pct = p.totalBytes ? Math.min(100, (100 * (p.bytes ?? 0)) / p.totalBytes) : null;
  const active = job.status === "running" || job.status === "queued";
  const elapsed = job.startedAt ? (new Date(job.finishedAt ?? Date.now()).getTime() - new Date(job.startedAt).getTime()) / 1000 : null;
  return (
    <div className={`job job-${job.status}`}>
      <div className="job-head">
        <span className="job-name">{job.name}</span>
        <span className={`badge job-badge ${job.status}`}>{t(`job_${job.status}`)}</span>
      </div>
      <div className="small muted">
        {t(job.action === "install" ? "jobInstall" : "jobUpdate")}
        {job.status === "running" && p.phase && ` · ${t(`phase_${p.phase}`)}`}
        {elapsed !== null && ` · ${f.duration(elapsed)}`}
      </div>
      {job.status === "running" && (
        <>
          <div className="progress" aria-hidden="true">
            <span style={{ width: `${p.phase === "rows" || p.phase === "download" ? (pct ?? 5) : 100}%` }} className={p.phase === "indexes" || p.phase === "swap" ? "indeterminate" : ""} />
          </div>
          <div className="small muted tabular">
            {pct !== null && p.phase === "rows" && `${f.bytes(p.bytes ?? 0)} / ${f.bytes(p.totalBytes ?? 0)} · `}
            {t("jobCounts", { features: f.number(p.features ?? 0), addresses: f.number(p.addresses ?? 0) })}
          </div>
        </>
      )}
      {job.status === "done" && <div className="small muted tabular">{t("jobCounts", { features: f.number(p.features ?? 0), addresses: f.number(p.addresses ?? 0) })}</div>}
      {job.error && <div className="small error-text">{job.error}</div>}
      {active && admin && (
        <button
          className="text-button small"
          onClick={async () => {
            try {
              await api(`/app/jobs/${job.id}/cancel`, { method: "POST" });
              reloadJobs();
            } catch (e) {
              toast((e as Error).message, "error");
            }
          }}
        >
          {t("cancel")}
        </button>
      )}
    </div>
  );
}

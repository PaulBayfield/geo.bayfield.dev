// GeoPol server: the geocoding API, the dashboard and its API.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { DEV_LOGIN_USER, DIST_DIR, IMPORT_WORKERS, PORT, PUBLIC_URL, oidc, umami } from "./config.ts";
import { migrate, sql } from "./db.ts";
import { api } from "./api.ts";
import { authRoutes, sameOrigin } from "./auth.ts";
import { geo } from "./geo.ts";
import { HttpError } from "./http.ts";
import { flushUsage } from "./access.ts";
import { loadCountries } from "./geocode.ts";
import { loadSettings } from "./settings.ts";
import { resumeJobs, startScheduler } from "./import/jobs.ts";

await migrate();
await loadSettings();
await loadCountries();

const indexPath = resolve(DIST_DIR, "index.html");
const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const umamiTag = umami
  ? `<script defer src="${attr(umami.scriptUrl)}" data-website-id="${attr(umami.websiteId)}"` +
    (umami.hostUrl ? ` data-host-url="${attr(umami.hostUrl)}"` : "") +
    (umami.domains.length ? ` data-domains="${attr(umami.domains.join(","))}"` : "") +
    `></script>`
  : "";
const indexHtml = existsSync(indexPath) ? readFileSync(indexPath, "utf8").replace("</head>", `${umamiTag}</head>`) : null;
const UMAMI_ORIGINS = umami ? [...new Set([new URL(umami.scriptUrl).origin, ...(umami.hostUrl ? [new URL(umami.hostUrl).origin] : [])])] : [];
// index.html applies the theme in a tiny inline script before the bundle loads (no flash of the
// wrong theme). The policy allows exactly that script, by hash.
const inlineScripts = [...(indexHtml ?? "").matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
  (m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`,
);
/** The dashboard's maps: CARTO's base maps (styles, tiles, fonts, sprites). */
const MAP_ORIGINS = ["https://basemaps.cartocdn.com", "https://*.basemaps.cartocdn.com"];

const app = new Hono();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: "Internal error" }, 500);
});

app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", ...inlineScripts, ...UMAMI_ORIGINS],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", ...MAP_ORIGINS],
      connectSrc: ["'self'", ...MAP_ORIGINS, ...UMAMI_ORIGINS, "https://prefs.bayfield.dev"],
      // MapLibre decodes tiles in web workers it creates from blobs.
      workerSrc: ["'self'", "blob:"],
      childSrc: ["blob:"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      baseUri: ["'self'"],
    },
    referrerPolicy: "strict-origin-when-cross-origin",
    // The API is called from other sites (with CORS, see access.ts).
    crossOriginResourcePolicy: false,
  }),
);
app.use("/api/*", bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "Request too large" }, 413) }));
app.use("/api/*", sameOrigin);

app.get("/api/health", async (c) => {
  await sql`SELECT 1`;
  return c.json({ ok: true });
});

app.route("/api/auth", authRoutes);
app.route("/api/app", api);
// The geocoding API: /v1/*, and Photon's /api and /reverse.
app.route("/", geo);
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
app.all("/v1/*", (c) => c.json({ error: "Not found" }, 404));

if (indexHtml) {
  const index = indexHtml;
  app.use("/assets/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "public, max-age=31536000, immutable");
  });
  const page = (c: Context) => {
    c.header("Cache-Control", "no-cache");
    return c.html(index);
  };
  app.get("/", page);
  app.get("/index.html", page);
  app.use("/*", serveStatic({ root: relative(process.cwd(), DIST_DIR) }));
  app.get("*", page);
} else {
  console.warn(`No web build at ${DIST_DIR}; only the API is served. Run \`npm run build\` in the project root.`);
}

setInterval(
  () => {
    void sql`DELETE FROM sessions WHERE expires_at < now()`.catch(() => {});
    void sql`DELETE FROM oidc_states WHERE expires_at < now()`.catch(() => {});
  },
  60 * 60_000,
);
setInterval(() => void flushUsage().catch((e) => console.warn("Usage flush failed:", e)), 10_000);
await resumeJobs();
startScheduler();

serve({ fetch: app.fetch, port: PORT }, ({ port }) => {
  console.log(`GeoPol on http://localhost:${port} (public URL ${PUBLIC_URL})`);
  console.log(`  sign-in: ${[oidc && `SSO (${oidc.name})`, DEV_LOGIN_USER && `development sign-in as ${DEV_LOGIN_USER}`].filter(Boolean).join(", ")}`);
  console.log(`  imports: ${IMPORT_WORKERS} parsing threads`);
});

// Server configuration, read once from the environment (see server/.env.example).
// Everything about the geocoding itself (regions, API keys, limits, ranking…) is set live in the
// dashboard and kept in the database (see settings.ts): this is only what the server needs to start.

import { availableParallelism } from "node:os";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name} (see server/.env.example)`);
  return value;
}

const flag = (name: string, fallback: boolean) => {
  const v = process.env[name]?.trim().toLowerCase();
  return v ? v === "true" || v === "1" || v === "yes" : fallback;
};

const list = (name: string) =>
  (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const PUBLIC_URL = required("PUBLIC_URL").replace(/\/+$/, "");
export const PORT = Number(process.env.PORT ?? 8840);
export const DATABASE_URL = required("DATABASE_URL");
export const DIST_DIR = resolve(process.env.DIST_DIR ?? resolve(import.meta.dirname, "../../dist"));
export const SECURE_COOKIES = PUBLIC_URL.startsWith("https://");

/** Set by the Docker build; when running from a checkout, the root package.json's version. */
export const APP_VERSION = (() => {
  const env = process.env.APP_VERSION?.trim();
  if (env && env !== "dev") return env;
  try {
    return (JSON.parse(readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8")) as { version?: string }).version ?? "dev";
  } catch {
    return "dev";
  }
})();

/** Look on GitHub for a newer release (shown in Settings → About). */
export const UPDATE_CHECK = flag("UPDATE_CHECK", true);

/**
 * Local development only: signs straight in as this user, without the identity provider.
 * Ignored unless PUBLIC_URL is localhost, so it can't be switched on in production by mistake.
 */
export const DEV_LOGIN_USER = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(PUBLIC_URL) ? process.env.DEV_LOGIN_USER?.trim() || null : null;

if (!process.env.OIDC_ISSUER && !DEV_LOGIN_USER) {
  throw new Error("Set OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET: the GeoPol dashboard signs in through your identity provider (see server/.env.example)");
}

/** Sign in with Authentik (or any OIDC provider): the only way into the dashboard. */
export const oidc = process.env.OIDC_ISSUER
  ? {
      issuer: process.env.OIDC_ISSUER.trim()
        .replace(/^["']|["']$/g, "")
        .replace(/\/+$/, ""),
      clientId: required("OIDC_CLIENT_ID"),
      clientSecret: required("OIDC_CLIENT_SECRET"),
      name: process.env.OIDC_NAME ?? "Authentik",
      redirectUri: `${PUBLIC_URL}/api/auth/oidc/callback`,
      autoCreate: flag("OIDC_AUTO_CREATE", true),
      allowedGroups: list("OIDC_ALLOWED_GROUPS"),
      adminGroups: list("OIDC_ADMIN_GROUPS"),
    }
  : null;

/** Header your reverse proxy puts the visitor IP in (e.g. cf-connecting-ip). Unset: the TCP peer. */
export const CLIENT_IP_HEADER = process.env.CLIENT_IP_HEADER?.toLowerCase();

/** How long a session lasts without being used. */
export const SESSION_IDLE_DAYS = Number(process.env.SESSION_IDLE_DAYS ?? 30);

/** Where the Photon dumps come from (GraphHopper publishes them, per continent and country). */
export const DUMP_BASE_URL = (process.env.DUMP_BASE_URL ?? "https://download1.graphhopper.com/public").trim().replace(/\/+$/, "");

/** Threads parsing a dump during an import (it's the slow part). Default: the cores minus one, at most 8. */
export const IMPORT_WORKERS = Math.max(1, Number(process.env.IMPORT_WORKERS ?? Math.min(8, availableParallelism() - 1)));

/** An http(s) URL from the environment, or null when unset; anything else stops the server. */
function httpUrl(name: string): URL | null {
  const v = process.env[name]?.trim();
  if (!v) return null;
  try {
    const url = new URL(v);
    if (url.protocol === "https:" || url.protocol === "http:") return url;
  } catch {
    // Reported below.
  }
  throw new Error(`${name} should be an http(s) URL`);
}

/** Umami analytics on the dashboard pages (not the API), when UMAMI_WEBSITE_ID and UMAMI_SCRIPT_URL are set. */
export const umami = (() => {
  const websiteId = process.env.UMAMI_WEBSITE_ID?.trim();
  const scriptUrl = httpUrl("UMAMI_SCRIPT_URL");
  if (!websiteId && !scriptUrl) return null;
  if (!websiteId || !scriptUrl) throw new Error("Umami needs both UMAMI_WEBSITE_ID and UMAMI_SCRIPT_URL");
  if (!/^[\w-]{1,64}$/.test(websiteId)) throw new Error("UMAMI_WEBSITE_ID should be the website's id from Umami (a UUID)");
  return {
    websiteId,
    scriptUrl: scriptUrl.href,
    hostUrl: httpUrl("UMAMI_HOST_URL")?.href.replace(/\/+$/, "") ?? null,
    domains: list("UMAMI_DOMAINS"),
  };
})();

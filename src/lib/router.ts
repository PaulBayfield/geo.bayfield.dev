// Address-bar routing: / overview, /regions, /playground, /keys, /docs.

import { useCallback, useEffect, useState } from "react";

export const PAGES = ["overview", "regions", "playground", "keys", "docs"] as const;
export type Page = (typeof PAGES)[number];
export type Route = { name: Page };

export function parseRoute(path: string): Route {
  const first = path.replace(/^\/+|\/+$/g, "").split("/")[0];
  return { name: (PAGES as readonly string[]).includes(first) ? (first as Page) : "overview" };
}

export const routePath = (r: Route) => (r.name === "overview" ? "/" : `/${r.name}`);

const readQuery = () => Object.fromEntries(new URLSearchParams(location.search));

export function useRouter() {
  const [state, setState] = useState(() => ({ route: parseRoute(location.pathname), query: readQuery() }));

  useEffect(() => {
    const onPop = () => setState({ route: parseRoute(location.pathname), query: readQuery() });
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((route: Route, replace = false) => {
    history[replace ? "replaceState" : "pushState"](null, "", routePath(route));
    setState({ route, query: {} });
  }, []);

  const setQuery = useCallback((patch: Record<string, string | undefined>, replace = false) => {
    setState((s) => {
      const q = { ...s.query };
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete q[k];
        else q[k] = v;
      }
      const search = new URLSearchParams(q).toString();
      history[replace ? "replaceState" : "pushState"](null, "", location.pathname + (search ? `?${search}` : ""));
      return { ...s, query: q };
    });
  }, []);

  return { route: state.route, query: state.query, navigate, setQuery };
}

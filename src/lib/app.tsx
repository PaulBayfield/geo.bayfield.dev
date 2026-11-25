// What every part of the signed-in app can reach: the user, navigation, the imports.

import { createContext, useContext } from "react";
import type { Job, Me, ServerInfo } from "./api";
import type { Route } from "./router";

export type SettingsPage = "profile" | "preferences" | "security" | "access" | "results" | "ranking" | "synonyms" | "blocklist" | "cache" | "data" | "shortcuts" | "users" | "about";

export interface AppContextValue {
  me: Me;
  setMe: (me: Me) => void;
  admin: boolean;
  server: ServerInfo | undefined;
  route: Route;
  navigate: (route: Route, replace?: boolean) => void;
  /** Recent imports, newest first (refreshed every couple of seconds while one runs). */
  jobs: Job[] | undefined;
  reloadJobs: () => void;
  openSettings: (page?: SettingsPage) => void;
  signOut: () => void;
  sidebarVisible: boolean;
  toggleSidebar: () => void;
  panelVisible: boolean;
  togglePanel: () => void;
  openSearch: () => void;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const v = useContext(AppContext);
  if (!v) throw new Error("useApp outside the app");
  return v;
}

import { useCallback, useEffect, useState } from "react";
import { api, ApiError, isAdmin, type Job, type Me, type ServerInfo } from "./lib/api";
import { AppContext, type AppContextValue, type SettingsPage } from "./lib/app";
import { MOBILE_QUERY, invalidate, refreshLive, useApi, useMediaQuery } from "./lib/hooks";
import { PAGES, useRouter } from "./lib/router";
import { SettingsProvider, useSettings } from "./lib/settings";
import { usePrefsSync } from "./lib/prefs";
import { ToastProvider } from "./components/common";
import { Sidebar } from "./components/Sidebar";
import { SignIn } from "./components/SignIn";
import { SettingsDialog } from "./components/SettingsDialog";
import { SearchDialog } from "./components/SearchDialog";
import { RefreshButton, Toolbar } from "./components/Toolbar";
import { ActivityPanel } from "./components/ActivityPanel";
import { OverviewPage } from "./components/OverviewPage";
import { RegionsPage } from "./components/RegionsPage";
import { PlaygroundPage } from "./components/PlaygroundPage";
import { KeysPage } from "./components/KeysPage";
import { DocsPage } from "./components/DocsPage";
import { Plus } from "./components/icons";

export default function App() {
  return (
    <SettingsProvider>
      <ToastProvider>
        <SignedIn />
      </ToastProvider>
    </SettingsProvider>
  );
}

function SignedIn() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [signinError] = useState(() => new URLSearchParams(location.search).get("signin_error"));

  const loadMe = useCallback(() => {
    api<Me>("/auth/me").then(setMe, (e) => (e instanceof ApiError && e.status === 401 ? setMe(null) : setMe(null)));
  }, []);

  useEffect(() => loadMe(), [loadMe]);

  useEffect(() => {
    if (signinError) router.setQuery({ signin_error: undefined }, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onSignedOut = () => setMe(null);
    window.addEventListener("geopol:signed-out", onSignedOut);
    return () => window.removeEventListener("geopol:signed-out", onSignedOut);
  }, []);

  if (me === undefined) return <div className="splash" />;
  if (me === null) return <SignIn error={signinError} onSignedIn={loadMe} />;
  return <Shell me={me} setMe={setMe} router={router} onSignedOut={() => setMe(null)} />;
}

function Shell({ me, setMe, router, onSignedOut }: { me: Me; setMe: (me: Me) => void; router: ReturnType<typeof useRouter>; onSignedOut: () => void }) {
  const { settings, update, t } = useSettings();
  usePrefsSync({ theme: settings.theme, customThemes: settings.customThemes, customTheme: settings.customTheme, language: settings.language }, update);
  const mobile = useMediaQuery(MOBILE_QUERY);
  const [drawer, setDrawer] = useState(false);
  const [mobilePanel, setMobilePanel] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [creatingKey, setCreatingKey] = useState(false);
  const [settingsPage, setSettingsPage] = useState<SettingsPage | null>(() => {
    const p = new URLSearchParams(location.search).get("settings");
    return p ? (p as SettingsPage) : null;
  });
  const server = useApi<ServerInfo>("/app/server").data;
  const jobsReq = useApi<Job[]>("/app/jobs", true);
  const admin = isAdmin(me);
  const r = router.route;

  // While an import runs, follow it closely.
  const active = (jobsReq.data ?? []).some((j) => j.status === "running" || j.status === "queued");
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      invalidate("/app/jobs");
      jobsReq.reload();
    }, 2000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (new URLSearchParams(location.search).has("settings")) router.setQuery({ settings: undefined }, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => setDrawer(false), [r]);

  const sidebarVisible = mobile ? drawer : settings.sidebar;
  const panelVisible = mobile ? mobilePanel : settings.panel;
  const toggleSidebar = () => (mobile ? setDrawer((d) => !d) : update({ sidebar: !settings.sidebar }));
  const togglePanel = () => (mobile ? setMobilePanel((p) => !p) : update({ panel: !settings.panel }));

  const value: AppContextValue = {
    me,
    setMe,
    admin,
    server,
    route: r,
    navigate: router.navigate,
    jobs: jobsReq.data,
    reloadJobs: () => {
      invalidate("/app/jobs");
      jobsReq.reload();
    },
    openSettings: (page) => setSettingsPage(page ?? "profile"),
    signOut: () => {
      void api("/auth/logout", { method: "POST" }).finally(() => {
        invalidate();
        onSignedOut();
      });
    },
    sidebarVisible,
    toggleSidebar,
    panelVisible,
    togglePanel,
    openSearch: () => setSearchOpen(true),
  };

  // The same keys as Calendar and Notes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inField = !!target.closest?.("input, textarea, select, [contenteditable]");
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (ctrl && !e.altKey && !e.shiftKey && (k === "b" || k === "\\")) {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      if (ctrl && !e.altKey && k === "k") {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (ctrl && !e.altKey && e.key === ",") {
        e.preventDefault();
        setSettingsPage((p) => p ?? "profile");
        return;
      }
      if (ctrl && !e.altKey && k === ".") {
        e.preventDefault();
        togglePanel();
        return;
      }
      if (k === "escape" && !settingsPage && !searchOpen && !document.querySelector(".dialog-backdrop, .picker")) {
        if (mobile && (drawer || mobilePanel)) {
          setDrawer(false);
          setMobilePanel(false);
        }
        return;
      }
      if (ctrl || e.altKey || inField || settingsPage || searchOpen) return;
      if (document.querySelector(".dialog-backdrop, .picker")) return;
      if (k === "\\") toggleSidebar();
      else if (k === "/") setSearchOpen(true);
      else if (k === ".") togglePanel();
      else if (k === "r" && r.name === "overview") refreshLive();
      else if (/^[1-5]$/.test(k)) router.navigate({ name: PAGES[Number(k) - 1] });
      else if (k === "n" && admin) {
        router.navigate({ name: "keys" });
        setCreatingKey(true);
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const titles = { overview: t("overview"), regions: t("regions"), playground: t("playground"), keys: t("apiKeys"), docs: t("docs") };
  const actions =
    r.name === "keys" && admin ? (
      <button className="text-button" title={`${t("newKey")} (N)`} onClick={() => setCreatingKey(true)}>
        <Plus size={14} />
        <span className="hide-mobile">{t("newKey")}</span>
      </button>
    ) : r.name === "overview" ? (
      <RefreshButton />
    ) : null;

  return (
    <AppContext.Provider value={value}>
      <div className="app">
        {sidebarVisible && (
          <>
            {mobile && <div className="sidebar-backdrop" onClick={() => setDrawer(false)} />}
            <Sidebar />
          </>
        )}
        <main className="main">
          <Toolbar title={titles[r.name]} loading={jobsReq.loading && !jobsReq.data} actions={actions} />
          <div className={`content${r.name === "playground" ? " full-bleed" : ""}`}>
            {r.name === "overview" && <OverviewPage />}
            {r.name === "regions" && <RegionsPage />}
            {r.name === "playground" && <PlaygroundPage />}
            {r.name === "keys" && <KeysPage creating={creatingKey} setCreating={setCreatingKey} />}
            {r.name === "docs" && <DocsPage />}
          </div>
        </main>
        {panelVisible && <ActivityPanel />}
      </div>
      {searchOpen && <SearchDialog onClose={() => setSearchOpen(false)} />}
      {settingsPage && <SettingsDialog page={settingsPage} onClose={() => setSettingsPage(null)} />}
    </AppContext.Provider>
  );
}

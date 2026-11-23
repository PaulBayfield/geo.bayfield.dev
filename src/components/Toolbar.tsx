// The top bar, laid out like Calendar's and Notes': title on the left; the page's action, account and
// the side panel toggle on the right.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useApp } from "../lib/app";
import { refreshLive, useFetching } from "../lib/hooks";
import { useSettings } from "../lib/settings";
import { Dropdown as Floating } from "./pickers";
import { PanelLeft, PanelRight, RefreshCw } from "./icons";

export function Toolbar({ title, loading, actions }: { title: ReactNode; loading?: boolean; actions?: ReactNode }) {
  const { t } = useSettings();
  const { sidebarVisible, toggleSidebar, panelVisible, togglePanel } = useApp();
  return (
    <header className="toolbar">
      {!sidebarVisible && (
        <button className="icon-button" title={`${t("toggleSidebar")} (Ctrl+B)`} aria-label={t("toggleSidebar")} onClick={toggleSidebar}>
          <PanelLeft />
        </button>
      )}
      <h1 className="toolbar-title">{title}</h1>
      {loading && <span className="spinner" aria-label={t("loading")} />}
      <div className="toolbar-spacer" />
      {actions}
      {/* The profile last, right before the side panel toggle (as in every bayfield.dev app). */}
      <AccountMenu />
      <button
        className={`icon-button panel-toggle${panelVisible ? " active" : ""}`}
        title={`${t("togglePanel")} (.)`}
        aria-label={t("togglePanel")}
        aria-pressed={panelVisible}
        onClick={togglePanel}
      >
        <PanelRight />
      </button>
    </header>
  );
}

/** Refetches the page's live data now; spins while anything is loading (a turn at least, when clicked). */
export function RefreshButton() {
  const { t, f } = useSettings();
  const fetching = useFetching();
  const [clicked, setClicked] = useState(false);
  const [updated, setUpdated] = useState(() => new Date());
  useEffect(() => {
    if (!fetching) setUpdated(new Date());
  }, [fetching]);
  useEffect(() => {
    if (!clicked) return;
    const timer = window.setTimeout(() => setClicked(false), 700);
    return () => window.clearTimeout(timer);
  }, [clicked]);
  const busy = fetching || clicked;
  return (
    <button
      className={`icon-button refresh-button${busy ? " busy" : ""}`}
      title={`${t("refresh")} (R) · ${t("updatedAt", { time: f.time(updated) })}`}
      aria-label={t("refresh")}
      aria-busy={busy}
      onClick={() => {
        setClicked(true);
        refreshLive();
      }}
    >
      <RefreshCw size={16} />
    </button>
  );
}

function AccountMenu() {
  const { t } = useSettings();
  const { me, openSettings, signOut } = useApp();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <div className="menu-anchor">
      <button ref={anchor} className="avatar" title={me.email ?? me.id} aria-haspopup="menu" onClick={() => setOpen(!open)}>
        {(me.name.trim()[0] ?? "?").toUpperCase()}
      </button>
      {open && (
        <Floating anchor={anchor} onClose={() => setOpen(false)} className="menu-floating">
          <div className="menu" role="menu">
            <div className="menu-label">{me.email ?? me.id}</div>
            <button
              onClick={() => {
                setOpen(false);
                openSettings("profile");
              }}
            >
              <span>{t("settings")}</span>
              <span className="keys">
                <kbd>Ctrl</kbd> <kbd>,</kbd>
              </span>
            </button>
            <button onClick={signOut}>{t("signOut")}</button>
          </div>
        </Floating>
      )}
    </div>
  );
}

// Custom places: places of your own (a venue, an office, a nickname for somewhere), found by every
// endpoint like the imported ones and kept across region updates. Admins add and edit them; the map
// shows them all, a click on it places the one being edited.

import { useEffect, useMemo, useRef, useState } from "react";
import { LAYERS, api, type ApiKey, type CustomPlace } from "../lib/api";
import { useApp } from "../lib/app";
import { invalidate, useApi } from "../lib/hooks";
import { useSettings } from "../lib/settings";
import { ConfirmDialog, Dialog, Flags, useToast } from "./common";
import { Lock, MapPin, Pencil, Plus, Search, Trash } from "./icons";
import { MapCanvas, maplibregl, type MapInstance } from "./MapCanvas";

const address = (p: CustomPlace) => [[p.street, p.housenumber].filter(Boolean).join(" "), [p.postcode, p.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");

export function PlacesPage({ creating, setCreating }: { creating: boolean; setCreating: (v: boolean) => void }) {
  const { t, f } = useSettings();
  const { admin } = useApp();
  const req = useApi<CustomPlace[]>("/app/places", true);
  const [editing, setEditing] = useState<CustomPlace | null>(null);
  const [deleting, setDeleting] = useState<CustomPlace | null>(null);
  const [filter, setFilter] = useState("");
  const map = useRef<MapInstance | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  const reload = () => {
    invalidate("/app/places");
    req.reload();
  };

  const list = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (req.data ?? []).filter((p) => !q || `${p.name} ${p.altNames.join(" ")} ${p.osmKey}=${p.osmValue} ${address(p)}`.toLowerCase().includes(q));
  }, [req.data, filter]);

  // Every place on the map, framed once they're loaded.
  const framed = useRef(false);
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    for (const mk of markers.current) mk.remove();
    markers.current = list.map((p) => {
      const el = document.createElement("div");
      el.className = "place-marker";
      el.title = p.name;
      el.onclick = (e) => {
        e.stopPropagation();
        if (admin) setEditing(p);
      };
      return new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(m);
    });
    if (!framed.current && list.length) {
      framed.current = true;
      const b = new maplibregl.LngLatBounds();
      for (const p of list) b.extend([p.lon, p.lat]);
      // Once the map has its size (framing a map that hasn't loaded yet lands anywhere).
      const frame = () => m.fitBounds(b, { padding: 60, maxZoom: 14, duration: 0 });
      if (m.loaded()) frame();
      else m.once("load", frame);
    }
  }, [list, admin]);

  const focus = (p: CustomPlace) => map.current?.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.current.getZoom(), 15), duration: 600 });

  return (
    <div className="page places-page">
      <p className="muted small">{t("customPlacesHint")}</p>
      <div className="places-map">
        <MapCanvas onReady={(m) => (map.current = m)} />
      </div>

      {req.data?.length === 0 ? (
        <div className="empty-state">
          <MapPin size={28} />
          <h2>{t("noPlaces")}</h2>
          <p className="muted">{t("noPlacesHint")}</p>
          {admin && (
            <button className="primary-button" onClick={() => setCreating(true)}>
              <Plus size={14} />
              {t("newPlace")}
            </button>
          )}
        </div>
      ) : (
        req.data && (
          <>
            <div className="search-field small places-filter">
              <Search size={14} />
              <input className="text-field" value={filter} placeholder={t("filterPlaces")} aria-label={t("filterPlaces")} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t("name")}</th>
                    <th>{t("category")}</th>
                    <th>{t("address")}</th>
                    <th className="num">{t("importance")}</th>
                    <th>{t("updated")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {list.map((p) => (
                    <tr key={p.id} className="clickable" onClick={() => focus(p)}>
                      <td>
                        <strong>{p.name}</strong>
                        {p.keys.length > 0 && (
                          <span className="badge" title={t("privatePlaceHint")}>
                            <Lock size={11} />
                            {p.keys.length === 1 ? t("oneKeyOnly") : t("nKeysOnly", { n: p.keys.length })}
                          </span>
                        )}
                        <div className="small muted">
                          <code>X{p.id}</code> · {t(`layer_${p.layer}` as never) || p.layer}
                          {p.altNames.length > 0 && ` · ${p.altNames.join(", ")}`}
                        </div>
                      </td>
                      <td className="small">
                        <code>
                          {p.osmKey}={p.osmValue}
                        </code>
                      </td>
                      <td className="small">
                        <Flags codes={[p.countryCode]} size={11} />
                        {address(p) || <span className="muted">{`${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`}</span>}
                      </td>
                      <td className="num tabular">{p.importance.toFixed(2)}</td>
                      <td className="small">{p.updatedAt ? f.relative(p.updatedAt, t) : "—"}</td>
                      <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                        {admin && (
                          <>
                            <button className="icon-button small" title={t("edit")} onClick={() => setEditing(p)}>
                              <Pencil size={14} />
                            </button>
                            <button className="icon-button small danger" title={t("delete")} onClick={() => setDeleting(p)}>
                              <Trash size={14} />
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {list.length === 0 && <p className="muted small table-empty">{t("noResults")}</p>}
            </div>
          </>
        )
      )}

      {(creating || editing) && (
        <PlaceDialog
          initial={editing}
          center={map.current && map.current.getZoom() >= 6 ? [map.current.getCenter().lng, map.current.getCenter().lat] : undefined}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={reload}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={t("deletePlace")}
          text={t("deletePlaceHint", { name: deleting.name })}
          action={t("delete")}
          onConfirm={async () => {
            await api(`/app/places/${deleting.id}`, { method: "DELETE" });
            reload();
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function PlaceDialog({ initial, center, onClose, onSaved }: { initial: CustomPlace | null; center?: [number, number]; onClose: () => void; onSaved: () => void }) {
  const { t } = useSettings();
  const toast = useToast();
  const [v, setV] = useState({
    name: initial?.name ?? "",
    altNames: initial?.altNames.join(", ") ?? "",
    layer: initial?.layer ?? "house",
    category: initial ? `${initial.osmKey}=${initial.osmValue}` : "",
    housenumber: initial?.housenumber ?? "",
    street: initial?.street ?? "",
    postcode: initial?.postcode ?? "",
    city: initial?.city ?? "",
    countryCode: initial?.countryCode ?? "",
    importance: initial?.importance ?? 0.5,
    lat: initial ? String(initial.lat) : "",
    lon: initial ? String(initial.lon) : "",
    note: initial?.note ?? "",
    keys: initial?.keys ?? ([] as string[]),
  });
  const [restricted, setRestricted] = useState((initial?.keys.length ?? 0) > 0);
  const apiKeys = useApi<ApiKey[]>("/app/keys").data;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<typeof v>) => setV((s) => ({ ...s, ...patch }));
  const marker = useRef<maplibregl.Marker | null>(null);
  const map = useRef<MapInstance | null>(null);
  const [mapReady, setMapReady] = useState(false);

  // The point on the little map: click to place it, drag to adjust.
  const point = Number.isFinite(parseFloat(v.lat)) && Number.isFinite(parseFloat(v.lon)) ? ([parseFloat(v.lon), parseFloat(v.lat)] as [number, number]) : null;
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (!point) {
      marker.current?.remove();
      marker.current = null;
      return;
    }
    if (!marker.current) {
      const el = document.createElement("div");
      el.className = "place-marker editing";
      marker.current = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(point).addTo(m);
      marker.current.on("dragend", () => {
        const p = marker.current!.getLngLat();
        set({ lat: p.lat.toFixed(6), lon: p.lng.toFixed(6) });
      });
    } else marker.current.setLngLat(point);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [point?.[0], point?.[1], mapReady]);

  return (
    <Dialog title={initial ? t("editPlace") : t("newPlace")} onClose={onClose} wide>
      <form
        className="dialog-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          const body = {
            ...v,
            altNames: v.altNames.split(",").map((s) => s.trim()).filter(Boolean),
            keys: restricted ? v.keys : [],
            lat: parseFloat(v.lat),
            lon: parseFloat(v.lon),
          };
          try {
            if (initial) await api(`/app/places/${initial.id}`, { method: "PUT", body });
            else await api("/app/places", { body });
            onSaved();
            toast(t("saved"));
            onClose();
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <div className="place-picker">
          <MapCanvas
            center={point ?? center ?? [10, 48]}
            zoom={point ? 15 : center ? 12 : 4}
            onReady={(m) => {
              map.current = m;
              setMapReady(true);
            }}
            onClick={(e) => set({ lat: e.lngLat.lat.toFixed(6), lon: e.lngLat.lng.toFixed(6) })}
          />
          {!point && <span className="place-picker-hint">{t("pickOnMap")}</span>}
        </div>
        <div className="field-row">
          <label className="field">
            {t("latitude")}
            <input className="text-field" inputMode="decimal" value={v.lat} onChange={(e) => set({ lat: e.target.value })} required />
          </label>
          <label className="field">
            {t("longitude")}
            <input className="text-field" inputMode="decimal" value={v.lon} onChange={(e) => set({ lon: e.target.value })} required />
          </label>
        </div>
        <label className="field">
          {t("name")}
          <input className="text-field" value={v.name} onChange={(e) => set({ name: e.target.value })} maxLength={200} required autoFocus />
        </label>
        <label className="field">
          {t("altNames")}
          <input className="text-field" value={v.altNames} onChange={(e) => set({ altNames: e.target.value })} placeholder={t("altNamesPlaceholder")} />
          <span className="small muted">{t("altNamesHint")}</span>
        </label>
        <div className="field-row">
          <label className="field">
            {t("layer")}
            <select className="text-field" value={v.layer} onChange={(e) => set({ layer: e.target.value })}>
              {LAYERS.map((l) => (
                <option key={l} value={l}>
                  {t(`layer_${l}` as never)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {t("category")}
            <input className="text-field" value={v.category} onChange={(e) => set({ category: e.target.value })} placeholder="amenity=cafe" />
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            {t("street")}
            <input className="text-field" value={v.street} onChange={(e) => set({ street: e.target.value })} />
          </label>
          <label className="field narrow">
            {t("housenumber")}
            <input className="text-field" value={v.housenumber} onChange={(e) => set({ housenumber: e.target.value })} maxLength={20} />
          </label>
        </div>
        <div className="field-row">
          <label className="field narrow">
            {t("postcode")}
            <input className="text-field" value={v.postcode} onChange={(e) => set({ postcode: e.target.value })} maxLength={20} />
          </label>
          <label className="field">
            {t("city")}
            <input className="text-field" value={v.city} onChange={(e) => set({ city: e.target.value })} />
          </label>
          <label className="field narrow">
            {t("countryCode")}
            <input className="text-field" value={v.countryCode} onChange={(e) => set({ countryCode: e.target.value.toLowerCase() })} maxLength={2} placeholder="fr" />
          </label>
        </div>
        <label className="field">
          {t("importance")} <span className="tabular muted">{v.importance.toFixed(2)}</span>
          <input type="range" min={0} max={1} step={0.05} value={v.importance} onChange={(e) => set({ importance: Number(e.target.value) })} />
          <span className="small muted">{t("importanceHint")}</span>
        </label>
        <div className="field">
          {t("placeAccess")}
          <label className="checkbox">
            <input type="radio" name="place-access" checked={!restricted} onChange={() => setRestricted(false)} />
            {t("placePublic")}
          </label>
          <label className="checkbox">
            <input type="radio" name="place-access" checked={restricted} onChange={() => setRestricted(true)} />
            {t("placeKeysOnly")}
          </label>
          {restricted && (
            <div className="place-keys">
              {apiKeys?.length === 0 && <span className="small muted">{t("placeNoKeys")}</span>}
              {apiKeys?.map((k) => (
                <label key={k.id} className="checkbox">
                  <input type="checkbox" checked={v.keys.includes(k.id)} onChange={(e) => set({ keys: e.target.checked ? [...v.keys, k.id] : v.keys.filter((x) => x !== k.id) })} />
                  {k.name} <code className="small muted">{k.prefix}…</code>
                </label>
              ))}
              {/* A key deleted since: still listed, so it can be unticked (saving checks the keys exist). */}
              {v.keys
                .filter((id) => apiKeys && !apiKeys.some((k) => k.id === id))
                .map((id) => (
                  <label key={id} className="checkbox muted">
                    <input type="checkbox" checked onChange={() => set({ keys: v.keys.filter((x) => x !== id) })} />
                    {t("deletedKey")}
                  </label>
                ))}
            </div>
          )}
          <span className="small muted">{t("placeAccessHint")}</span>
        </div>
        <label className="field">
          {t("note")}
          <textarea className="text-field area" rows={2} value={v.note} onChange={(e) => set({ note: e.target.value })} maxLength={500} placeholder={t("notePlaceholder")} />
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="text-button" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="primary-button" disabled={busy || !v.name.trim() || !point || (restricted && v.keys.length === 0)}>
            {initial ? t("save") : t("create")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

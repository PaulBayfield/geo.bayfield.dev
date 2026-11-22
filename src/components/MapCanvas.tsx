// A MapLibre map with CARTO's base maps (light or dark with the theme), as in Llip. Pages draw on it
// through `onStyle`, called on every style load (first load, theme change), and `onReady`.

import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useSettings } from "../lib/settings";

maplibregl.setWorkerUrl(workerUrl);

const STYLES = {
  light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
};

export type MapInstance = maplibregl.Map;
export { maplibregl };

export function MapCanvas({
  center = [10, 48],
  zoom = 3,
  onReady,
  onStyle,
  onClick,
  className = "",
}: {
  center?: [number, number];
  zoom?: number;
  onReady?: (map: maplibregl.Map) => void;
  /** (Re)adds the page's sources and layers: called after every style load. */
  onStyle?: (map: maplibregl.Map, dark: boolean) => void;
  onClick?: (e: maplibregl.MapMouseEvent, map: maplibregl.Map) => void;
  className?: string;
}) {
  const { dark } = useSettings();
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const latest = useRef({ onStyle, onClick, dark });
  latest.current = { onStyle, onClick, dark };

  useEffect(() => {
    const m = new maplibregl.Map({
      container: container.current!,
      style: dark ? STYLES.dark : STYLES.light,
      center,
      zoom,
      attributionControl: { compact: true },
      renderWorldCopies: false,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    m.on("style.load", () => latest.current.onStyle?.(m, latest.current.dark));
    m.on("click", (e) => latest.current.onClick?.(e, m));
    map.current = m;
    onReady?.(m);
    const resize = new ResizeObserver(() => m.resize());
    resize.observe(container.current!);
    return () => {
      resize.disconnect();
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The theme changed: the matching base map (style.load then redraws the page's layers).
  useEffect(() => {
    map.current?.setStyle(dark ? STYLES.dark : STYLES.light);
  }, [dark]);

  return <div ref={container} className={`map-canvas ${className}`} />;
}

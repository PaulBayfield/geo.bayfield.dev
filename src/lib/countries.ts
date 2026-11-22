// Country shapes for the region map (Natural Earth 1:110m, from world-atlas), and which catalog regions
// cover which countries. GraphHopper names its folders in English ("germany", "france-monacco"), so
// most match a country's name; the rest are listed here.

import { feature } from "topojson-client";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { Topology, GeometryCollection } from "topojson-specification";
import world from "world-atlas/countries-110m.json";
import type { CatalogRegion } from "./api";

export type CountryShape = Feature<Geometry, { name: string }>;

let shapes: FeatureCollection<Geometry, { name: string }> | null = null;

type Ring = number[][];

/**
 * A ring that crosses the antimeridian (Russia's far east, Fiji) jumps from +180° to −180°, and the map
 * would draw it the long way round, as a band across the whole world. Shifting its western points by
 * +360° keeps it in one piece, just east of 180°.
 */
function unwrap(ring: Ring): Ring {
  const crosses = ring.some((p, i) => i > 0 && Math.abs(p[0] - ring[i - 1][0]) > 180);
  return crosses ? ring.map(([lon, lat]) => [lon < 0 ? lon + 360 : lon, lat]) : ring;
}

function unwrapGeometry(g: Geometry): Geometry {
  if (g.type === "Polygon") return { ...g, coordinates: g.coordinates.map(unwrap) };
  if (g.type === "MultiPolygon") return { ...g, coordinates: g.coordinates.map((poly) => poly.map(unwrap)) };
  return g;
}

export function countryShapes(): FeatureCollection<Geometry, { name: string }> {
  if (!shapes) {
    const topo = world as unknown as Topology<{ countries: GeometryCollection<{ name: string }> }>;
    const all = feature(topo, topo.objects.countries) as FeatureCollection<Geometry, { name: string }>;
    shapes = {
      ...all,
      // Antarctica wraps the whole globe (and no dump covers it).
      features: all.features.filter((f) => f.properties.name !== "Antarctica").map((f) => ({ ...f, geometry: unwrapGeometry(f.geometry) })),
    };
  }
  return shapes;
}

/** Folder → Natural Earth country names, when they differ. */
const COVERS: Record<string, string[]> = {
  "france-monacco": ["France"],
  "british-islands": ["United Kingdom", "Ireland"],
  baltics: ["Estonia", "Latvia", "Lithuania"],
  "switzerland-liechtenstein": ["Switzerland"],
  "iceland-faroe": ["Iceland"],
  "bosnia-herzegovina": ["Bosnia and Herz."],
  "czech-republic": ["Czechia"],
  macedonia: ["North Macedonia"],
  luxemburg: ["Luxembourg"],
  "congo-democratic-republic": ["Dem. Rep. Congo"],
  "congo-brazzaville": ["Congo"],
  "ivory-coast": ["Côte d'Ivoire"],
  "south-sudan": ["S. Sudan"],
  "central-african-republic": ["Central African Rep."],
  "equatorial-guinea": ["Eq. Guinea"],
  "haiti-and-domrep": ["Haiti", "Dominican Rep."],
  "senegal-and-gambia": ["Senegal", "Gambia"],
  "israel-and-palestine": ["Israel", "Palestine"],
  "malaysia-singapore-brunei": ["Malaysia", "Brunei"],
  "gcc-states": ["Saudi Arabia", "United Arab Emirates", "Qatar", "Kuwait", "Oman"],
  "north-korea": ["North Korea"],
  "south-korea": ["South Korea"],
  "south-africa": ["South Africa"],
  "western-sahara": ["W. Sahara"],
  "solomon-islands": ["Solomon Is."],
  "new-caledonia": ["New Caledonia"],
  "new-zealand": ["New Zealand"],
  "papua-new-guinea": ["Papua New Guinea"],
  "united-states": ["United States of America"],
  usa: ["United States of America"],
  "east-timor": ["Timor-Leste"],
  "sierra-leone": ["Sierra Leone"],
  "burkina-faso": ["Burkina Faso"],
  "cape-verde": ["Cabo Verde"],
  "costa-rica": ["Costa Rica"],
  "el-salvador": ["El Salvador"],
  "puerto-rico": ["Puerto Rico"],
  "trinidad-and-tobago": ["Trinidad and Tobago"],
  "falklands": ["Falkland Is."],
  "sri-lanka": ["Sri Lanka"],
  "saudi-arabia": ["Saudi Arabia"],
};

/** The Natural Earth countries a catalog region covers (none for continents and unknown folders). */
export function regionCovers(r: Pick<CatalogRegion, "path" | "isContinent" | "name">): string[] {
  if (r.isContinent) return [];
  const folder = r.path.split("/").at(-1)!;
  if (COVERS[folder]) return COVERS[folder];
  const names = new Set(countryShapes().features.map((f) => f.properties.name.toLowerCase()));
  const guess = folder.replace(/-/g, " ");
  return names.has(guess) ? [countryShapes().features.find((f) => f.properties.name.toLowerCase() === guess)!.properties.name] : [];
}

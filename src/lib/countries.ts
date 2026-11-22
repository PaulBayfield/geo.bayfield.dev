// Country shapes for the region map (Natural Earth 1:50m, from world-atlas, loaded with the page), and which catalog regions
// cover which countries. GraphHopper names its folders in English ("germany", "france-monacco"), so
// most match a country's name; the rest are listed here.

import { feature } from "topojson-client";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { Topology, GeometryCollection } from "topojson-specification";
import type { CatalogRegion } from "./api";

export type CountryShape = Feature<Geometry, { name: string }>;

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

export type CountryShapes = FeatureCollection<Geometry, { name: string }>;

let pending: Promise<CountryShapes> | null = null;

/** The shapes (~750 KB): fetched the first time the region map opens, not with the app. */
export function loadCountryShapes(): Promise<CountryShapes> {
  pending ??= import("world-atlas/countries-50m.json").then((m) => {
    const topo = (m.default ?? m) as unknown as Topology<{ countries: GeometryCollection<{ name: string }> }>;
    const all = feature(topo, topo.objects.countries) as CountryShapes;
    return {
      ...all,
      // Antarctica wraps the whole globe (and no dump covers it).
      features: all.features.filter((f) => f.properties.name !== "Antarctica").map((f) => ({ ...f, geometry: unwrapGeometry(f.geometry) })),
    };
  });
  return pending;
}

/** [west, south, east, north] around some shapes (east can pass 180° for shapes unwrapped across it). */
export function boundsOf(features: CountryShape[]): [number, number, number, number] | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const visit = (c: unknown): void => {
    if (typeof (c as number[])[0] === "number") {
      const [lon, lat] = c as number[];
      w = Math.min(w, lon);
      e = Math.max(e, lon);
      s = Math.min(s, lat);
      n = Math.max(n, lat);
    } else for (const x of c as unknown[]) visit(x);
  };
  for (const f of features) if ("coordinates" in f.geometry) visit(f.geometry.coordinates);
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

/**
 * Folder → Natural Earth country names, when they differ. The groups' members were read from the dumps
 * themselves (their places' country codes, November 2026).
 */
const COVERS: Record<string, string[]> = {
  // Groups of countries
  "africa-eastern-islands": ["Madagascar", "Mauritius", "Seychelles", "Comoros"],
  "central-africa": ["Dem. Rep. Congo", "Cameroon", "Angola", "Chad", "Gabon", "Congo", "Central African Rep.", "Eq. Guinea", "São Tomé and Principe"],
  "horn-of-africa": ["Ethiopia", "Somalia", "Somaliland", "Djibouti", "Eritrea"],
  "northern-africa": ["Egypt", "Algeria", "Morocco", "Tunisia", "Sudan", "Libya", "W. Sahara"],
  "southern-africa": ["South Africa", "Namibia", "Botswana", "Lesotho", "eSwatini"],
  "western-africa": ["Côte d'Ivoire", "Ghana", "Mali", "Burkina Faso", "Senegal", "Benin", "Niger", "Togo", "Guinea", "Liberia", "Sierra Leone", "Mauritania", "Cabo Verde", "Gambia", "Guinea-Bissau"],
  "arabian-peninsula": ["Saudi Arabia", "United Arab Emirates", "Kuwait", "Yemen", "Qatar", "Oman", "Bahrain"],
  "asia-indian-ocean": ["Sri Lanka", "Maldives", "Br. Indian Ocean Ter."],
  "central-asia": ["Kazakhstan", "Uzbekistan", "Kyrgyzstan", "Tajikistan", "Turkmenistan"],
  korea: ["South Korea", "North Korea"],
  oceania: ["Papua New Guinea", "Fiji", "Samoa", "Solomon Is.", "Vanuatu", "Micronesia", "Tonga", "Marshall Is.", "Cook Is.", "Kiribati", "Palau", "Niue", "Nauru", "Pitcairn Is."],
  caribbean: ["Trinidad and Tobago", "Cuba", "Dominican Rep.", "Haiti", "Jamaica", "Bahamas", "Barbados", "Saint Lucia", "Cayman Is.", "Dominica", "St. Kitts and Nevis", "Antigua and Barb.", "Grenada", "St. Vin. and Gren.", "Turks and Caicos Is.", "British Virgin Is.", "Anguilla", "Montserrat"],
  "central-america": ["Costa Rica", "Guatemala", "Nicaragua", "Panama", "El Salvador", "Honduras", "Belize"],
  "south-america-north": ["Venezuela", "Suriname", "Guyana"],
  "south-atlantic": ["Falkland Is.", "S. Geo. and the Is."],
  // Folder names spelled differently
  kenia: ["Kenya"],
  isreal: ["Israel", "Palestine"],
  "france-monacco": ["France"],
  "british-islands": ["United Kingdom", "Ireland"],
  baltics: ["Estonia", "Latvia", "Lithuania"],
  "switzerland-liechtenstein": ["Switzerland"],
  "iceland-faroe": ["Iceland"],
  "bosnia-herzegovina": ["Bosnia and Herz."],
  "czech-republic": ["Czechia"],
  macedonia: ["Macedonia"],
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
export function regionCovers(r: Pick<CatalogRegion, "path" | "isContinent" | "name">, shapes: CountryShapes): string[] {
  if (r.isContinent) return [];
  const folder = r.path.split("/").at(-1)!;
  if (COVERS[folder]) return COVERS[folder];
  const guess = folder.replace(/-/g, " ");
  const hit = shapes.features.find((f) => f.properties.name.toLowerCase() === guess);
  return hit ? [hit.properties.name] : [];
}

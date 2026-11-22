// Country flags (flag-icons, MIT): one small SVG per country, each its own file, fetched only when shown.
// Flag emoji would be lighter but Windows shows them as two letters.

import { numericToAlpha2 } from "i18n-iso-countries";
import type { CountryShapes } from "./countries";

const files = import.meta.glob("/node_modules/flag-icons/flags/4x3/*.svg", { query: "?url", import: "default", eager: true }) as Record<string, string>;

/** The flag of an ISO 3166 alpha-2 code ("be", "FR"), or null when there's none. */
export function flagUrl(code: string | null | undefined): string | null {
  if (!code) return null;
  return files[`/node_modules/flag-icons/flags/4x3/${code.toLowerCase()}.svg`] ?? null;
}

/** Shapes without an ISO number in Natural Earth. */
const NO_NUMBER: Record<string, string> = { Kosovo: "xk" };

/** Country name (as on the map) → ISO alpha-2, lowercase. */
export function isoByName(shapes: CountryShapes): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of shapes.features) {
    const code = f.id !== undefined ? numericToAlpha2(String(f.id)) : NO_NUMBER[f.properties.name];
    const fallback = NO_NUMBER[f.properties.name];
    if (code || fallback) out.set(f.properties.name, (code ?? fallback)!.toLowerCase());
  }
  return out;
}

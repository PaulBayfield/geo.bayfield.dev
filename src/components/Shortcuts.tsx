import { useSettings } from "../lib/settings";
import type { StringKey } from "../lib/i18n";

/** Kept in the same order and wording as Calendar's and Notes' lists. */
const SHORTCUTS: [keys: string[], label: StringKey][] = [
  [["Ctrl", "K"], "scSearch"],
  [["1"], "overview"],
  [["2"], "regions"],
  [["3"], "playground"],
  [["4"], "apiKeys"],
  [["5"], "docs"],
  [["N"], "scNewKey"],
  [["Ctrl", "B"], "scSidebar"],
  [["."], "scPanel"],
  [["Ctrl", ","], "settings"],
  [["Esc"], "scClose"],
];

export function ShortcutList() {
  const { t } = useSettings();
  return (
    <div className="shortcut-list">
      {SHORTCUTS.map(([keys, label]) => (
        <div key={label} className="shortcut">
          <span>{t(label)}</span>
          <span className="keys">
            {keys.map((k) => (
              <kbd key={k}>{k}</kbd>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

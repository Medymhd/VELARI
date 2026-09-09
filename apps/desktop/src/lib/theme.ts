/**
 * Theme system — palette switching via a single attribute on <html>.
 * CSS vars do the rest: switching is instant, zero re-render, and every
 * surface (desktop, overlay, future web) reads the same variables.
 *
 * Persistence: localStorage under the brand prefix, shared across all
 * windows of the same origin (desktop main window + overlay).
 */
export type ThemeId = "ocean" | "violet" | "midnight";

export interface ThemeDef {
  id: ThemeId;
  name: string;
  hint: string;
  /** Swatch preview: [from, to] of the accent gradient + the surface. */
  swatch: [string, string];
  surface: string;
}

import { STORAGE_PREFIX } from "brand";

export const THEMES: ThemeDef[] = [
  { id: "ocean", name: "Ocean", hint: "Azure → cyan on deep blue — the Velari default", swatch: ["#4d8dff", "#22d3ee"], surface: "#0e141f" },
  { id: "violet", name: "Violet", hint: "The original periwinkle → violet signature", swatch: ["#6c7bff", "#a06bff"], surface: "#101218" },
  { id: "midnight", name: "Midnight", hint: "Enterprise navy with a steel accent", swatch: ["#5e8bd9", "#8fb8f0"], surface: "#0d1220" },
];

const KEY = `${STORAGE_PREFIX}_theme`;
const DEFAULT_THEME: ThemeId = "ocean";
const VALID = new Set(THEMES.map((t) => t.id));

export function getTheme(): ThemeId {
  const stored = localStorage.getItem(KEY) as ThemeId | null;
  return stored && VALID.has(stored) ? stored : DEFAULT_THEME;
}

export function applyTheme(theme: ThemeId): void {
  document.documentElement.dataset.theme = theme;
  // Broadcast so secondary windows (stealth overlay) restyle live. Tauri's
  // emitter reaches every window; the DOM event is a same-window fallback.
  try {
    void import("@tauri-apps/api/event").then(({ emit }) => emit("theme://changed", { theme })).catch(() => {});
  } catch { /* non-tauri surface */ }
  try {
    window.dispatchEvent(new CustomEvent("velari:theme", { detail: theme }));
  } catch { /* non-fatal */ }
}

export function setTheme(theme: ThemeId): void {
  localStorage.setItem(KEY, theme);
  applyTheme(theme);
}

/** Pre-render: call before React mounts to avoid a wrong-palette flash. */
export function initTheme(): void {
  applyTheme(getTheme());
}

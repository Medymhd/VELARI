import { invoke } from "@tauri-apps/api/core";

export type MasqueradeProfile = "none" | "notepad" | "terminal" | "explorer" | "settings" | "custom";
export interface StealthState {
  captureExclusion: boolean;
  taskbarHidden: boolean;
  masquerade: MasqueradeProfile;
  masqueradeTitle: string | null;
  enforcedAtMs: number;
}

export async function stealthGetState(): Promise<StealthState> {
  try {
    return await invoke<StealthState>("stealth_get_state");
  } catch {
    // Running outside Tauri (vite dev without tauri) — return inert state
    return { captureExclusion: false, taskbarHidden: false, masquerade: "none", masqueradeTitle: null, enforcedAtMs: 0 };
  }
}

export async function stealthSetCapture(enabled: boolean): Promise<StealthState> {
  return invoke<StealthState>("stealth_set_capture_exclusion", { enabled });
}

export async function stealthSetTaskbar(enabled: boolean): Promise<StealthState> {
  return invoke<StealthState>("stealth_set_taskbar_hidden", { enabled });
}

export async function stealthSetMasquerade(profile: MasqueradeProfile, customTitle?: string): Promise<StealthState> {
  return invoke<StealthState>("stealth_set_masquerade", { profile, customTitle: customTitle ?? null });
}

export async function stealthEnforceNow(): Promise<StealthState> {
  return invoke<StealthState>("stealth_enforce_now");
}

export async function vaultWrite(key: string, value: string): Promise<void> {
  await invoke("vault_write", { key, value });
}

export async function vaultRead(key: string): Promise<string | null> {
  try {
    return await invoke<string | null>("vault_read", { key });
  } catch {
    return null;
  }
}

export function isTauri(): boolean {
  return "__TAURI__" in window;
}

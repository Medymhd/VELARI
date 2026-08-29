// Typed wrappers around the native (Rust) audio capture commands and events.
// Only callable inside the Tauri runtime — callers must check isTauri() first.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface NativeAudioDevice {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface NativeAudioBatch {
  channel: "mic" | "system";
  rate: number;
  dataB64: string;
  speech: boolean;
  rms: number;
  atMs: number;
}

export interface NativeCaptureInfo {
  channel: string;
  nativeSampleRate: number;
  startedAtMs: number;
}

export function listInputDevices(): Promise<NativeAudioDevice[]> {
  return invoke("list_input_devices");
}

export function listOutputDevices(): Promise<NativeAudioDevice[]> {
  return invoke("list_output_devices");
}

export function startMicCapture(deviceId?: string): Promise<NativeCaptureInfo> {
  return invoke("start_microphone_capture", { deviceId });
}

export function stopMicCapture(): Promise<void> {
  return invoke("stop_microphone_capture");
}

export function startSystemCapture(deviceId?: string): Promise<NativeCaptureInfo> {
  return invoke("start_system_audio_capture", { deviceId });
}

export function stopSystemCapture(): Promise<void> {
  return invoke("stop_system_audio_capture");
}

export function listenMicBatches(onBatch: (batch: NativeAudioBatch) => void): Promise<UnlistenFn> {
  return listen<NativeAudioBatch>("audio://mic", (e) => onBatch(e.payload));
}

export function listenSystemBatches(onBatch: (batch: NativeAudioBatch) => void): Promise<UnlistenFn> {
  return listen<NativeAudioBatch>("audio://system", (e) => onBatch(e.payload));
}

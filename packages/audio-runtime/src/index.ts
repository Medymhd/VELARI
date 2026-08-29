/**
 * Audio runtime (architecture spec §3): audio chunking, VAD gating, and STT
 * stream normalization. Owns every `SttEngine` implementation and the
 * fallback-chain composition so providers are swappable without touching
 * the realtime pipeline.
 *
 * Native DSP (capture, resampling, silence gating, batching) lives in the
 * Tauri Rust layer (`apps/desktop/src-tauri/src/audio/*`) — this package is
 * the JS-side contract + provider adapters.
 */
export * from "./stt.js";
export * from "./sttStreaming.js";
export * from "./sherpaStreaming.js";
export * from "./moonshineStreaming.js";
export * from "./relay.js";

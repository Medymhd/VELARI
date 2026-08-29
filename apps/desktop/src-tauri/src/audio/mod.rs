pub mod batch;
pub mod capture;
pub mod config;
pub mod resampler;
pub mod silence;

use std::sync::Mutex;

use cpal::traits::{DeviceTrait, HostTrait};
use serde_json::json;
use tauri::AppHandle;

use capture::ChannelSession;
use config::{FRAME_MS, SAMPLE_RATE};

#[derive(serde::Serialize, Clone)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

/// Live capture sessions, one slot per channel. Owned by the Tauri runtime;
/// commands below are the only mutators.
pub struct AudioCaptureState {
    pub mic: Mutex<Option<ChannelSession>>,
    pub system: Mutex<Option<ChannelSession>>,
}

impl AudioCaptureState {
    pub fn new() -> Self {
        Self {
            mic: Mutex::new(None),
            system: Mutex::new(None),
        }
    }
}

impl Default for AudioCaptureState {
    fn default() -> Self {
        Self::new()
    }
}

#[tauri::command]
pub fn list_input_devices() -> Result<Vec<AudioDevice>, String> {
    let host = cpal::default_host();
    let default_name = host.default_input_device().and_then(|d| d.name().ok());
    let devices = host.input_devices().map_err(|e| e.to_string())?;
    let mut out: Vec<AudioDevice> = devices
        .filter_map(|dev| {
            let name = dev.name().ok()?;
            let is_default = Some(&name) == default_name.as_ref();
            Some(AudioDevice { id: name.clone(), name, is_default })
        })
        .collect();
    if out.is_empty() {
        out.push(AudioDevice {
            id: "default".into(),
            name: "Default Microphone".into(),
            is_default: true,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn list_output_devices() -> Result<Vec<AudioDevice>, String> {
    let host = cpal::default_host();
    let default_name = host.default_output_device().and_then(|d| d.name().ok());
    let devices = host.output_devices().map_err(|e| e.to_string())?;
    let mut out: Vec<AudioDevice> = devices
        .filter_map(|dev| {
            let name = dev.name().ok()?;
            let is_default = Some(&name) == default_name.as_ref();
            Some(AudioDevice { id: name.clone(), name, is_default })
        })
        .collect();
    if out.is_empty() {
        out.push(AudioDevice {
            id: "default".into(),
            name: "Default Speakers".into(),
            is_default: true,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn start_microphone_capture(
    app: AppHandle,
    state: tauri::State<AudioCaptureState>,
    device_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut slot = state.mic.lock().map_err(|e| e.to_string())?;
    if slot.is_some() {
        return Err("Microphone capture already running".into());
    }
    let session = capture::start_microphone(&app, device_id)?;
    let info = json!({
        "channel": session.channel,
        "nativeSampleRate": session.native_rate,
        "startedAtMs": session.started_at_ms,
    });
    *slot = Some(session);
    Ok(info)
}

#[tauri::command]
pub fn stop_microphone_capture(state: tauri::State<AudioCaptureState>) -> Result<(), String> {
    if let Some(session) = state.mic.lock().map_err(|e| e.to_string())?.take() {
        session.stop();
    }
    Ok(())
}

/// Real system-audio loopback (WASAPI on Windows; explicit error elsewhere).
#[tauri::command]
pub fn start_system_audio_capture(
    app: AppHandle,
    state: tauri::State<AudioCaptureState>,
    device_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut slot = state.system.lock().map_err(|e| e.to_string())?;
    if slot.is_some() {
        return Err("System audio capture already running".into());
    }
    let session = capture::start_system(&app, device_id)?;
    let info = json!({
        "channel": session.channel,
        "nativeSampleRate": session.native_rate,
        "startedAtMs": session.started_at_ms,
    });
    *slot = Some(session);
    Ok(info)
}

#[tauri::command]
pub fn stop_system_audio_capture(state: tauri::State<AudioCaptureState>) -> Result<(), String> {
    if let Some(session) = state.system.lock().map_err(|e| e.to_string())?.take() {
        session.stop();
    }
    Ok(())
}

#[tauri::command]
pub fn get_audio_health(state: tauri::State<AudioCaptureState>) -> Result<serde_json::Value, String> {
    let host = cpal::default_host();
    let input = host
        .default_input_device()
        .and_then(|d| d.name().ok())
        .unwrap_or_else(|| "none".into());
    let output = host
        .default_output_device()
        .and_then(|d| d.name().ok())
        .unwrap_or_else(|| "none".into());

    let mic = state.mic.lock().map_err(|e| e.to_string())?;
    let system = state.system.lock().map_err(|e| e.to_string())?;

    Ok(json!({
        "status": "ok",
        "sample_rate": SAMPLE_RATE,
        "frame_ms": FRAME_MS,
        "vad": "webrtc-vad (two-stage gate)",
        "resampler": "rubato FftFixedIn",
        "input": input,
        "output": output,
        "mic_active": mic.is_some(),
        "system_active": system.is_some(),
        "mic_native_rate": mic.as_ref().map(|s| s.native_rate),
        "system_native_rate": system.as_ref().map(|s| s.native_rate),
    }))
}

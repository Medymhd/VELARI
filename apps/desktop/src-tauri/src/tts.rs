//! TTS — Piper (local, free, MIT) with Web Speech API fallback on the frontend.
//! Piper produces high-quality neural speech from a ~60 MB voice model.
//! The binary and model are user-provided via env; the module degrades to
//! frontend-only speech synthesis when Piper is not configured.

use base64::Engine;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

static SPEAKING: AtomicBool = AtomicBool::new(false);

fn piper_binary() -> Option<String> {
    std::env::var("PIPER_PATH").ok().filter(|p| !p.is_empty())
}

fn piper_model() -> Option<String> {
    std::env::var("PIPER_MODEL_PATH").ok().filter(|p| !p.is_empty())
}

fn piper_config() -> Option<String> {
    std::env::var("PIPER_CONFIG_PATH").ok().filter(|p| !p.is_empty())
}

/// True when Piper binary + model are configured on this machine.
pub fn piper_available() -> bool {
    static RESULT: OnceLock<bool> = OnceLock::new();
    *RESULT.get_or_init(|| match (piper_binary(), piper_model()) {
        (Some(bin), Some(model)) => std::path::Path::new(&bin).exists() && std::path::Path::new(&model).exists(),
        _ => false,
    })
}

/// Generate WAV audio from text using Piper. Returns base64-encoded WAV.
pub fn synthesize_wav(text: &str) -> Result<String, String> {
    let binary = piper_binary().ok_or("PIPER_PATH not set")?;
    let model = piper_model().ok_or("PIPER_MODEL_PATH not set")?;
    let config = piper_config();

    let output = std::env::temp_dir().join(format!("velari-tts-{:x}.wav", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()));

    let mut cmd = Command::new(&binary);
    cmd.arg("--model").arg(&model);
    if let Some(cfg) = &config {
        cmd.arg("--config").arg(cfg);
    }
    cmd.arg("--output_file").arg(&output);

    let piped = {
        use std::io::Write;
        let mut child = cmd
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Piper spawn failed: {e}"))?;
        if let Some(stdin) = child.stdin.as_mut() {
            stdin.write_all(text.as_bytes()).map_err(|e| format!("Piper stdin: {e}"))?;
        }
        drop(child.stdin.take());
        child.wait_with_output().map_err(|e| format!("Piper wait: {e}"))?
    };

    if !piped.status.success() {
        return Err(format!("Piper exited with {}", piped.status));
    }

    let wav = std::fs::read(&output).map_err(|e| format!("read WAV: {e}"))?;
    let _ = std::fs::remove_file(&output);
    Ok(base64::engine::general_purpose::STANDARD.encode(&wav))
}

/// Speak text aloud — plays the generated WAV through the system audio device.
/// Sets SPEAKING flag so the UI can show a "speaking…" state.
pub fn speak_wav(app: &AppHandle, wav_base64: &str) -> Result<(), String> {
    SPEAKING.store(true, Ordering::SeqCst);
    let _ = app.emit("tts://speaking", true);

    // Write temp file and play via PowerShell (Windows) — no extra crate needed.
    let tmp = std::env::temp_dir().join("velari-tts-play.wav");
    let wav = base64::engine::general_purpose::STANDARD
        .decode(wav_base64)
        .map_err(|e| format!("decode: {e}"))?;
    std::fs::write(&tmp, &wav).map_err(|e| format!("write: {e}"))?;

    let script = format!(
        "Add-Type -AssemblyName presentationCore; $p = New-Object System.Windows.Media.MediaPlayer; $p.Open([Uri]::new('{}')); $p.Play(); Start-Sleep -Milliseconds 500; while ($p.Position -lt $p.Duration -and $p.Position -ne [TimeSpan]::Zero) {{ Start-Sleep -Milliseconds 200 }} $p.Close()",
        tmp.to_string_lossy().replace('\\', "\\\\")
    );

    std::thread::spawn(move || {
        let _ = Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .output();
        SPEAKING.store(false, Ordering::SeqCst);
        let _ = std::fs::remove_file(&tmp);
    });

    Ok(())
}

/// Full pipeline: text → Piper WAV → play. Returns error if Piper unavailable.
pub fn speak(app: &AppHandle, text: &str) -> Result<(), String> {
    let wav = synthesize_wav(text)?;
    speak_wav(app, &wav)
}

#[tauri::command]
pub fn tts_piper_available() -> bool {
    piper_available()
}

#[tauri::command]
pub fn tts_speak(app: AppHandle, text: String) -> Result<(), String> {
    if SPEAKING.load(Ordering::SeqCst) {
        return Err("already speaking".into());
    }
    let wav = synthesize_wav(&text)?;
    speak_wav(&app, &wav)
}

mod audio;
mod overlay;
mod screen;
mod stealth;
mod vault;

use stealth::StealthState;
use std::sync::Mutex;
use tauri::{Listener, Manager};

pub struct AppState {
    stealth: Mutex<StealthState>,
}

#[tauri::command]
fn stealth_get_state(state: tauri::State<AppState>) -> StealthState {
    state.stealth.lock().unwrap().clone()
}

#[tauri::command]
fn stealth_set_capture_exclusion(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    enabled: bool,
) -> Result<StealthState, String> {
    {
        let mut s = state.stealth.lock().unwrap();
        s.capture_exclusion = enabled;
        s.enforced_at_ms = now_ms();
    }
    stealth::apply_capture_exclusion(&app, enabled)?;
    Ok(state.stealth.lock().unwrap().clone())
}

#[tauri::command]
fn stealth_set_taskbar_hidden(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    enabled: bool,
) -> Result<StealthState, String> {
    {
        let mut s = state.stealth.lock().unwrap();
        s.taskbar_hidden = enabled;
        s.enforced_at_ms = now_ms();
    }
    stealth::apply_taskbar_hidden(&app, enabled)?;
    Ok(state.stealth.lock().unwrap().clone())
}

#[tauri::command]
fn stealth_set_masquerade(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    profile: String,
    custom_title: Option<String>,
) -> Result<StealthState, String> {
    {
        let mut s = state.stealth.lock().unwrap();
        s.masquerade = profile.clone();
        s.masquerade_title = custom_title.clone();
        s.enforced_at_ms = now_ms();
    }
    stealth::apply_masquerade(&app, &profile, custom_title)?;
    Ok(state.stealth.lock().unwrap().clone())
}

#[tauri::command]
fn stealth_enforce_now(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> Result<StealthState, String> {
    let s = state.stealth.lock().unwrap().clone();
    stealth::enforce_all(&app, &s)?;
    {
        let mut locked = state.stealth.lock().unwrap();
        locked.enforced_at_ms = now_ms();
        return Ok(locked.clone());
    }
}

#[tauri::command]
fn stealth_enable_for_all_browsers_and_apps(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    foreground_hint: Option<String>,
) -> Result<StealthState, String> {
    // Real foreground-window hint from the OS (a browser UA always says
    // "chrome" and is not the foreground app).
    let hint = foreground_hint.or_else(stealth::foreground_window_title);
    {
        let mut s = state.stealth.lock().unwrap();
        s.capture_exclusion = true;
        s.taskbar_hidden = true;
        if let Some(h) = &hint {
            let profile = if h.contains("chrome") { "chrome" } else if h.contains("zoom") { "zoom" } else if h.contains("teams") { "teams" } else if h.contains("meet") { "meet" } else { "" };
            if !profile.is_empty() {
                s.masquerade = profile.into();
                s.masquerade_title = None;
            }
        }
        s.enforced_at_ms = now_ms();
    }
    let s = state.stealth.lock().unwrap().clone();
    // Universal stealth: WDA + TOOLWINDOW for all our windows Works for any browser/app sharing
    stealth::enforce_all(&app, &s)?;
    if let Some(hint) = hint {
        let _ = stealth::stealth_for_all_browsers_and_apps(&app, Some(hint));
    }
    Ok(s)
}

#[tauri::command]
fn vault_write(key: String, value: String) -> Result<(), String> {
    vault::write(&key, &value)
}

#[tauri::command]
fn vault_read(key: String) -> Result<Option<String>, String> {
    vault::read(&key)
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

pub fn run() {
    let initial = StealthState {
        capture_exclusion: false,
        taskbar_hidden: false,
        masquerade: "none".into(),
        masquerade_title: None,
        enforced_at_ms: 0,
    };

    tauri::Builder::default()
        .manage(AppState {
            stealth: Mutex::new(initial),
        })
        .manage(audio::AudioCaptureState::default())
        .invoke_handler(tauri::generate_handler![
            stealth_get_state,
            stealth_set_capture_exclusion,
            stealth_set_taskbar_hidden,
            stealth_set_masquerade,
            stealth_enforce_now,
            stealth_enable_for_all_browsers_and_apps,
            vault_write,
            vault_read,
            screen::take_screenshot,
            screen::open_cropper,
            screen::cropper_select,
            overlay::overlay_show,
            overlay::overlay_hide,
            audio::list_input_devices,
            audio::list_output_devices,
            audio::start_microphone_capture,
            audio::stop_microphone_capture,
            audio::start_system_audio_capture,
            audio::stop_system_audio_capture,
            audio::get_audio_health,
            stealth::keyboard::stealth_keyboard_start,
            stealth::keyboard::stealth_keyboard_stop,
            stealth::keyboard::is_accessibility_granted,
            stealth::keybind::register_global_chord,
            stealth::keybind::unregister_global_chord
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            app.listen("tauri://window-created", {
                let h = handle.clone();
                move |_| {
                    if let Some(state) = h.try_state::<AppState>() {
                        let s = state.stealth.lock().unwrap().clone();
                        let _ = stealth::enforce_all(&h, &s);
                    }
                }
            });

            // Reassert loop — mirrors rival's _enforceDockState: every 2s verify
            // GetWindowDisplayAffinity / GWL_EXSTYLE and re-apply if drifted.
            let reassert_handle = handle.clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_millis(2000));
                let Some(state) = reassert_handle.try_state::<AppState>() else {
                    continue;
                };
                let s = { state.stealth.lock().unwrap().clone() };
                if !s.capture_exclusion && !s.taskbar_hidden && s.masquerade == "none" {
                    continue;
                }
                if let Err(e) = stealth::enforce_all(&reassert_handle, &s) {
                    eprintln!("[stealth reassert] {e}");
                } else {
                    // update enforced_at_ms without dead-locking (try_lock)
                    if let Ok(mut locked) = state.stealth.try_lock() {
                        locked.enforced_at_ms = now_ms();
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run app");
}

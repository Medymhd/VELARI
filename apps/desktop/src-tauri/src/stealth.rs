// Copyright (c) 2026. All rights reserved.
// Proprietary — see stealth/LICENSE for terms.
// You may READ this code for audit but you may NOT redistribute or reuse it.

pub mod keybind;
pub mod keyboard;

use serde::{Deserialize, Serialize};
use tauri::Manager;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StealthState {
    pub capture_exclusion: bool,
    pub taskbar_hidden: bool,
    pub masquerade: String,
    pub masquerade_title: Option<String>,
    pub enforced_at_ms: u64,
}

pub fn apply_capture_exclusion(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    for w in app.webview_windows().values() {
        set_window_capture_exclusion(w, enabled)?;
    }
    Ok(())
}

pub fn apply_taskbar_hidden(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    for w in app.webview_windows().values() {
        set_taskbar_hidden(w, enabled)?;
    }
    Ok(())
}

pub fn apply_masquerade(
    app: &tauri::AppHandle,
    profile: &str,
    custom_title: Option<String>,
) -> Result<(), String> {
    let title = title_for_profile(profile, custom_title);
    for w in app.webview_windows().values() {
        if !title.is_empty() {
            w.set_title(&title).map_err(|e| e.to_string())?;
        }
        set_window_class_masquerade(w, profile)?;
        // Icon disguise stub — assets at icons/fake/* (port of rival assets/fakeicon)
        // Real: w.set_icon(tauri::image::Image::from_path(icon_path)?)?; kept as probe surface.
        let _ = icon_for_profile(profile);
    }
    Ok(())
}

pub fn enforce_all(app: &tauri::AppHandle, state: &StealthState) -> Result<(), String> {
    for w in app.webview_windows().values() {
        set_window_capture_exclusion(w, state.capture_exclusion)?;
        set_taskbar_hidden(w, state.taskbar_hidden)?;
        if state.masquerade != "none" {
            let title = title_for_profile(&state.masquerade, state.masquerade_title.clone());
            if !title.is_empty() {
                w.set_title(&title).map_err(|e| e.to_string())?;
            }
            set_window_class_masquerade(w, &state.masquerade)?;
        }
    }
    Ok(())
}

fn title_for_profile(profile: &str, custom: Option<String>) -> String {
    if let Some(c) = custom {
        if !c.is_empty() {
            return c;
        }
    }
    match profile {
        "notepad" => "Untitled - Notepad".into(),
        "terminal" => "Command Prompt".into(),
        "explorer" => "File Explorer".into(),
        "settings" => "Settings".into(),
        "activity" => "Activity Monitor".into(),
        "chrome" => "Google Chrome".into(),
        "zoom" => "Zoom Meeting".into(),
        "teams" => "Microsoft Teams".into(),
        "meet" => "Google Meet".into(),
        "custom" => "Document".into(),
        _ => String::new(),
    }
}

fn icon_for_profile(profile: &str) -> Option<String> {
    let base = std::env::current_dir().ok()?.join("icons/fake");
    let name = match profile {
        "notepad" => "notepad.png",
        "terminal" => "terminal.png",
        "settings" => "settings.png",
        "activity" => "activity.png",
        "chrome" => "chrome.png",
        "zoom" => "zoom.png",
        "teams" => "teams.png",
        "meet" => "meet.png",
        _ => return None,
    };
    let p = base.join(name);
    if p.exists() { Some(p.to_string_lossy().into()) } else { None }
}

/// Title of the current foreground window, lowercased — the real hint source
/// for masquerade auto-picking (the desktop's own user-agent says "chrome"
/// on every Chromium browser and is not the foreground app).
#[cfg(windows)]
pub fn foreground_window_title() -> Option<String> {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextW};
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_invalid() {
            return None;
        }
        let mut buf = [0u16; 256];
        let n = GetWindowTextW(hwnd, &mut buf);
        if n <= 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..n as usize]).to_lowercase())
    }
}

#[cfg(not(windows))]
pub fn foreground_window_title() -> Option<String> {
    None
}

/// Stealth on all browsers and apps: enforce capture exclusion regardless of foreground app.
/// This is already universal — WDA_EXCLUDEFROMCAPTURE hides our windows from *any* screen-share
/// client (Chrome getDisplayMedia, Zoom native PrintWindow, Teams clone DXGI). The profiles above
/// let the user masquerade as the foreground app they are actually interviewing in.
pub fn stealth_for_all_browsers_and_apps(app: &tauri::AppHandle, foreground_hint: Option<String>) -> Result<(), String> {
    // If caller hints the foreground is Chrome/Zoom/Meet/Teams, auto-pick that masquerade
    // so taskbar/title blends into the app the interviewer sees.
    if let Some(hint) = foreground_hint {
        let hint = hint.to_ascii_lowercase();
        let profile = if hint.contains("chrome") { "chrome" } else if hint.contains("zoom") { "zoom" } else if hint.contains("teams") { "teams" } else if hint.contains("meet") { "meet" } else { "none" };
        if profile != "none" {
            let _ = apply_masquerade(app, profile, None);
        }
    }
    // Re-enforce WDA + TOOLWINDOW for all our windows — works for *any* browser/app sharing.
    let state = StealthState {
        capture_exclusion: true,
        taskbar_hidden: true,
        masquerade: "none".into(),
        masquerade_title: None,
        enforced_at_ms: 0,
    };
    enforce_all(app, &state)
}

#[cfg(windows)]
fn hwnd_of(window: &tauri::WebviewWindow) -> Result<windows::Win32::Foundation::HWND, String> {
    let raw = window.hwnd().map_err(|e| e.to_string())?;
    Ok(windows::Win32::Foundation::HWND(raw.0))
}

#[cfg(windows)]
fn set_window_capture_exclusion(window: &tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowDisplayAffinity, SetWindowDisplayAffinity, WINDOW_DISPLAY_AFFINITY,
    };
    let hwnd = hwnd_of(window)?;
    let flag = WINDOW_DISPLAY_AFFINITY(if enabled { 0x00000011 } else { 0x00000000 });
    unsafe {
        SetWindowDisplayAffinity(hwnd, flag).map_err(|e| e.to_string())?;
        let mut actual: u32 = 0;
        if GetWindowDisplayAffinity(hwnd, &mut actual).is_ok() && enabled && actual == 0 {
            return Err("display-affinity not applied (permission?)".into());
        }
    }
    Ok(())
}

#[cfg(windows)]
fn set_taskbar_hidden(window: &tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE};
    const WS_EX_TOOLWINDOW: isize = 0x00000080;
    const WS_EX_APPWINDOW: isize = 0x00040000;
    let hwnd = hwnd_of(window)?;
    unsafe {
        let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as isize;
        let next = if enabled {
            (current | WS_EX_TOOLWINDOW) & !WS_EX_APPWINDOW
        } else {
            (current & !WS_EX_TOOLWINDOW) | WS_EX_APPWINDOW
        };
        if next != current {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
        }
    }
    Ok(())
}

#[cfg(windows)]
fn set_window_class_masquerade(_window: &tauri::WebviewWindow, _profile: &str) -> Result<(), String> {
    // Window class is set at creation on Windows; title masquerade is sufficient
    // for the red-team exercise. Class spoof would require recreating the window.
    Ok(())
}

#[cfg(not(windows))]
fn set_window_capture_exclusion(_w: &tauri::WebviewWindow, _e: bool) -> Result<(), String> {
    Ok(())
}
#[cfg(not(windows))]
fn set_taskbar_hidden(_w: &tauri::WebviewWindow, _e: bool) -> Result<(), String> {
    Ok(())
}
#[cfg(not(windows))]
fn set_window_class_masquerade(_w: &tauri::WebviewWindow, _p: &str) -> Result<(), String> {
    Ok(())
}

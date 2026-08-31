//! Per-window overlay system — 3 modes (stealth/assist/none), one window
//! builder. Replaces the fixed 440×430 stealth-only singleton.
//!
//! Each vertical declares its overlay mode in the manifest (`overlay.mode`);
//! this module reads that and builds the window accordingly. `WindowPolicy`
//! derives all window flags from the mode — no per-vertical Rust code.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum OverlayMode {
    /// Capture-excluded, taskbar-hidden, non-activating (interview intelligence).
    Stealth,
    /// Always-on-top but visible and captured (code error lens, spreadsheet assist).
    Assist,
    /// Normal window — full desktop, no overlay behavior (research chat, Studio).
    None,
}

impl OverlayMode {
    pub fn from_str(s: &str) -> Self {
        match s {
            "stealth" => Self::Stealth,
            "assist" => Self::Assist,
            _ => Self::None,
        }
    }

    pub fn capture_exclusion(&self) -> bool {
        matches!(self, Self::Stealth)
    }

    pub fn always_on_top(&self) -> bool {
        matches!(self, Self::Stealth | Self::Assist)
    }

    pub fn skip_taskbar(&self) -> bool {
        matches!(self, Self::Stealth)
    }

    pub fn transparent(&self) -> bool {
        matches!(self, Self::Stealth)
    }

    pub fn no_activate(&self) -> bool {
        matches!(self, Self::Stealth)
    }
}

const DEFAULT_WIDTH: f64 = 440.0;
const DEFAULT_HEIGHT: f64 = 430.0;
const MARGIN: f64 = 24.0;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayParams {
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default = "default_vertical_id")]
    pub vertical_id: String,
    pub width: Option<f64>,
    pub height: Option<f64>,
}

fn default_mode() -> String { "stealth".into() }
fn default_vertical_id() -> String { "interview-intelligence".into() }

#[tauri::command]
pub fn overlay_show(app: AppHandle, params: OverlayParams) -> Result<(), String> {
    let label = format!("overlay:{}", params.vertical_id);
    let mode = OverlayMode::from_str(&params.mode);

    if let Some(existing) = app.get_webview_window(&label) {
        // Re-showing resets passthrough so the panel is interactive by default.
        let _ = overlay_set_passthrough(app.clone(), params.vertical_id.clone(), false);
        let _ = existing.show();
        return Ok(());
    }

    let width = params.width.unwrap_or(DEFAULT_WIDTH);
    let height = params.height.unwrap_or(DEFAULT_HEIGHT);
    let (x, y) = placement(&app, width);

    let builder = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App("overlay.html".into()),
    )
    .title("")
    .decorations(false)
    .always_on_top(mode.always_on_top())
    .skip_taskbar(mode.skip_taskbar())
    .resizable(false)
    .shadow(false)
    .focused(false)
    .position(x, y)
    .inner_size(width, height);

    let builder = if mode.transparent() {
        builder.transparent(true)
    } else {
        builder
    };

    builder.build().map_err(|e| e.to_string())?;

    if mode.no_activate() {
        if let Some(w) = app.get_webview_window(&label) {
            if let Ok(hwnd) = w.hwnd() {
                use windows::Win32::UI::WindowsAndMessaging::{
                    GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
                };
                let raw = windows::Win32::Foundation::HWND(hwnd.0);
                unsafe {
                    let current = GetWindowLongPtrW(raw, GWL_EXSTYLE);
                    SetWindowLongPtrW(raw, GWL_EXSTYLE, current | WS_EX_NOACTIVATE.0 as isize);
                }
            }
        }
    }

    if mode.capture_exclusion() {
        if let Some(w) = app.get_webview_window(&label) {
            if let Ok(hwnd) = w.hwnd() {
                use windows::Win32::UI::WindowsAndMessaging::SetWindowDisplayAffinity;
                use windows::Win32::UI::WindowsAndMessaging::WDA_EXCLUDEFROMCAPTURE;
                unsafe {
                    let _ = SetWindowDisplayAffinity(
                        windows::Win32::Foundation::HWND(hwnd.0),
                        WDA_EXCLUDEFROMCAPTURE,
                    );
                }
            }
        }
    }

    let _ = app.get_webview_window(&label).map(|w| w.show());
    Ok(())
}

#[tauri::command]
pub fn overlay_hide(app: AppHandle, vertical_id: String) -> Result<(), String> {
    let label = format!("overlay:{}", vertical_id);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.hide();
    }
    let _ = app.emit("overlay://hidden", ());
    Ok(())
}

/// Mouse passthrough (rival `syncOverlayInteractionPolicy` parity): when
/// enabled the overlay ignores all clicks (WS_EX_TRANSPARENT) so it floats
/// over a meeting without stealing input; the header 40px band stays live via
/// the frontend calling this again with `enabled:false` — the tray/Show chord
/// also disengages it. Ctrl+Shift+B toggles.
#[tauri::command]
pub fn overlay_set_passthrough(app: AppHandle, vertical_id: String, enabled: bool) -> Result<(), String> {
    let label = format!("overlay:{}", vertical_id);
    let Some(window) = app.get_webview_window(&label) else {
        return Err("overlay window not found".into());
    };
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_TRANSPARENT, WS_EX_LAYERED,
        };
        let raw = windows::Win32::Foundation::HWND(hwnd.0);
        unsafe {
            let current = GetWindowLongPtrW(raw, GWL_EXSTYLE);
            let next = if enabled {
                current | WS_EX_TRANSPARENT.0 as isize | WS_EX_LAYERED.0 as isize
            } else {
                current & !(WS_EX_TRANSPARENT.0 as isize)
            };
            if next != current {
                SetWindowLongPtrW(raw, GWL_EXSTYLE, next);
            }
        }
    }
    let _ = app.emit("overlay://passthrough", enabled);
    Ok(())
}

fn placement(app: &AppHandle, width: f64) -> (f64, f64) {
    let monitor = app.primary_monitor().ok().flatten();
    match monitor {
        Some(m) => {
            let size = m.size();
            let pos = m.position();
            let x = pos.x as f64 + size.width as f64 - width - MARGIN;
            let y = pos.y as f64 + MARGIN;
            (x, y)
        }
        None => (100.0, 100.0),
    }
}

//! Per-window overlay system — 3 modes (stealth/assist/none), one window
//! builder. Replaces the fixed 440×430 stealth-only singleton.
//!
//! Each vertical declares its overlay mode in the manifest (`overlay.mode`);
//! this module reads that and builds the window accordingly. `WindowPolicy`
//! derives all window flags from the mode — no per-vertical Rust code.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU8, Ordering};
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

const DEFAULT_WIDTH: f64 = 732.0; // reference OVERLAY_DEFAULT_WIDTH parity
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
/// async: creating a window from a sync command deadlocks on Windows —
/// build() needs the main thread, and sync commands run ON the main thread.
pub async fn overlay_show(app: AppHandle, params: OverlayParams) -> Result<(), String> {
    let label = format!("overlay:{}", params.vertical_id);
    let mode = OverlayMode::from_str(&params.mode);

    if let Some(existing) = app.get_webview_window(&label) {
        // Re-show resets to the DEFAULT interaction state: fully interactive
        // (click-through OFF) until the user explicitly re-enables it. NOTE:
        // overlay_set_passthrough/typing are async commands — they MUST be
        // awaited here or the reset silently never runs (the pre-fix bug
        // that made Ctrl+Shift+B behave inconsistently across re-shows).
        let _ = overlay_set_passthrough(app.clone(), params.vertical_id.clone(), false).await;
        let _ = overlay_set_typing(app.clone(), params.vertical_id.clone(), false).await;
        let _ = existing.show();
        return Ok(());
    }

    let width = params.width.unwrap_or(DEFAULT_WIDTH);
    let height = params.height.unwrap_or(DEFAULT_HEIGHT);
    let (x, y) = placement(&app, width, placement_state::current());

    let builder = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App("overlay.html".into()),
    )
    .title("")
    .decorations(false)
    .always_on_top(mode.always_on_top())
    .skip_taskbar(mode.skip_taskbar())
    .resizable(true)
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

    let shown = app.get_webview_window(&label);

    if mode.no_activate() {
        if let Some(w) = &shown {
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
        if let Some(w) = &shown {
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

    if let Some(w) = &shown {
        // Position was applied at build; assert it again post-creation (some
        // platform builds clamp or reset initial position for transparent
        // frameless windows), then make visible + topmost.
        let (x, y) = placement(&app, width, placement_state::current());
        let _ = w.set_position(tauri::LogicalPosition::new(x, y));
        let _ = w.show();
        let _ = w.set_focus();
        // Smart passthrough: body click-through (scroll Word beneath the
        // panel), header band interactive on hover.
        #[cfg(windows)]
        spawn_smart_passthrough_poller(app.clone());
        let _ = app.emit("overlay://visibility", true);
        if let Ok(pos) = w.outer_position() {
            println!("[overlay] shown at physical ({}, {}), size {}x{}, spot {}", pos.x, pos.y, width, height, placement_state::current().as_str());
        }
    }
    Ok(())
}

/// Session-persistent overlay placement (not saved to disk — stealth users
/// usually want a fresh default each launch).
mod placement_state {
    use super::OverlayPlacement;
    use std::sync::atomic::{AtomicU8, Ordering};

    // 0 = TopCenter (default), 1 = Right, 2 = Left
    static SPOT: AtomicU8 = AtomicU8::new(0);

    pub fn current() -> OverlayPlacement {
        match SPOT.load(Ordering::Relaxed) {
            1 => OverlayPlacement::Right,
            2 => OverlayPlacement::Left,
            _ => OverlayPlacement::TopCenter,
        }
    }

    pub fn set(spot: OverlayPlacement) {
        SPOT.store(match spot {
            OverlayPlacement::TopCenter => 0,
            OverlayPlacement::Right => 1,
            OverlayPlacement::Left => 2,
        }, Ordering::Relaxed);
    }
}

/// Cycle the overlay position: top-center → right → left → top-center.
/// Applies immediately when the overlay is visible; remembered for next show.
#[tauri::command]
pub async fn overlay_cycle_position(app: AppHandle, vertical_id: String, width: Option<f64>) -> Result<String, String> {
    let next = placement_state::current().next();
    placement_state::set(next);
    let label = format!("overlay:{}", vertical_id);
    if let Some(w) = app.get_webview_window(&label) {
        let width = width.unwrap_or(DEFAULT_WIDTH);
        let (x, y) = placement(&app, width, next);
        let _ = w.set_position(tauri::LogicalPosition::new(x, y));
        let _ = w.show();
    }
    Ok(next.as_str().to_string())
}

#[tauri::command]
pub async fn overlay_hide(app: AppHandle, vertical_id: String) -> Result<(), String> {
    let label = format!("overlay:{}", vertical_id);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.hide();
    }
    let _ = app.emit("overlay://hidden", ());
    let _ = app.emit("overlay://visibility", false);
    Ok(())
}

/// Broadcast an event from Rust's emitter. JS-to-JS cross-webview `emit()` is
/// the least reliable path in the event chain (main-window → overlay delivery
/// silently failed in the field); routing through the same Rust emitter that
/// powers `overlay://visibility` (which provably works) removes that class of
/// failure entirely.
#[tauri::command]
pub async fn overlay_emit(app: AppHandle, event: String, payload: serde_json::Value) -> Result<(), String> {
    app.emit(&event, payload).map_err(|e| e.to_string())
}

/// Typing mode — the overlay ask box is open. The window must become FULLY
/// interactive: smart passthrough otherwise holds WS_EX_TRANSPARENT over
/// everything below the 48px header band, so the ask textarea, its button
/// AND response scrolling are dead (clicks/wheel go to the app beneath).
/// Stealth windows also carry WS_EX_NOACTIVATE — without dropping it the
/// textarea can never take keyboard focus and typing is impossible.
/// Disabling restores smart passthrough + non-activating stealth.
#[tauri::command]
pub async fn overlay_set_typing(app: AppHandle, vertical_id: String, enabled: bool) -> Result<(), String> {
    let label = format!("overlay:{}", vertical_id);
    let Some(window) = app.get_webview_window(&label) else {
        return Err("overlay window not found".into());
    };
    PASSTHROUGH_MODE.store(
        if enabled { PASSTHROUGH_OFF } else { PASSTHROUGH_SMART },
        Ordering::Relaxed,
    );
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
        };
        let raw = windows::Win32::Foundation::HWND(hwnd.0);
        unsafe {
            let current = GetWindowLongPtrW(raw, GWL_EXSTYLE);
            let next = if enabled {
                // Typing mode: interactive + focusable. CRITICALLY also clear
                // WS_EX_TRANSPARENT — if Smart passthrough had left the body
                // click-through when the ask box opened, the textarea (and
                // every click) stayed dead. This was the "can't write on the
                // overlay" half of the bug.
                (current & !(WS_EX_NOACTIVATE.0 as isize)) & !PASSTHROUGH_MASK
            } else {
                (current | WS_EX_NOACTIVATE.0 as isize) & !PASSTHROUGH_MASK
            };
            if next != current {
                SetWindowLongPtrW(raw, GWL_EXSTYLE, next);
            }
        }
        if enabled {
            let _ = window.set_focus();
        }
    }
    let _ = app.emit("overlay://typing", enabled);
    Ok(())
}

/// WS_EX_TRANSPARENT | WS_EX_LAYERED as one bitmask — the click-through pair
/// the smart poller / passthrough setters manage.
#[cfg(windows)]
const PASSTHROUGH_MASK: isize = (0x00000020) | (0x00080000); // WS_EX_TRANSPARENT | WS_EX_LAYERED

/// Authoritative overlay toggle: checks REAL window visibility, not JS state.
/// Registered app-wide in Rust (Ctrl+Shift+O) so it works from any screen —
/// the previous JS-side toggle died whenever LiveSession was unmounted.
#[tauri::command]
pub async fn overlay_toggle(app: AppHandle, vertical_id: String) -> Result<bool, String> {
    let label = format!("overlay:{}", vertical_id);
    let visible = app
        .get_webview_window(&label)
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false);
    if visible {
        overlay_hide(app.clone(), vertical_id.clone()).await?;
        Ok(false)
    } else {
        overlay_show(
            app.clone(),
            OverlayParams {
                mode: "stealth".into(),
                vertical_id,
                width: None,
                height: None,
            },
        )
        .await?;
        let _ = app.emit("overlay://visibility", true);
        Ok(true)
    }
}

/// Chord-side passthrough toggle — runs in RUST so Ctrl+Shift+B works from
/// EVERY screen. The old handler lived in the Live session React component:
/// unmount it (any screen except live) and the chord went dead. No JS
/// involved anymore; the overlay button syncs via the emitted event.
pub fn chord_toggle_passthrough(app: &AppHandle) {
    let Some(window) = app.get_webview_window("overlay:interview-intelligence") else {
        return;
    };
    let enabled = PASSTHROUGH_MODE.load(Ordering::Relaxed) != PASSTHROUGH_SMART;
    PASSTHROUGH_MODE.store(if enabled { PASSTHROUGH_SMART } else { PASSTHROUGH_OFF }, Ordering::Relaxed);
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        // Reset the ex-style to interactive; the smart poller re-adds
        // click-through on its next tick while Smart mode is on.
        set_overlay_click_through(windows::Win32::Foundation::HWND(hwnd.0), false);
    }
    let _ = app.emit("overlay://passthrough", enabled);
    println!("[overlay] passthrough toggled to: {enabled}");
}

/// Mouse passthrough (reference `syncOverlayInteractionPolicy` parity): when
/// enabled the overlay ignores all clicks (WS_EX_TRANSPARENT) so it floats
/// over a meeting without stealing input; the header band stays live via the
/// smart poller. Ctrl+Shift+B toggles (Rust-side); the ● button in the
/// overlay header mirrors the same state.
#[tauri::command]
pub async fn overlay_set_passthrough(app: AppHandle, vertical_id: String, enabled: bool) -> Result<(), String> {
    let label = format!("overlay:{}", vertical_id);
    let Some(window) = app.get_webview_window(&label) else {
        return Err("overlay window not found".into());
    };
    // enabled=false (the DEFAULT) = fully interactive window. enabled=true =
    // Smart mode: body click-through, header + right-edge strip interactive.
    PASSTHROUGH_MODE.store(if enabled { PASSTHROUGH_SMART } else { PASSTHROUGH_OFF }, Ordering::Relaxed);
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        let raw = windows::Win32::Foundation::HWND(hwnd.0);
        set_overlay_click_through(raw, false); // smart poller re-adds it when Smart mode is on
    }
    let _ = app.emit("overlay://passthrough", enabled);
    Ok(())
}

/// Overlay interaction policy (user-facing): **click-through OFF by default**
/// — the overlay is fully clickable/writable until the user enables
/// passthrough (Ctrl+Shift+B or the ● button in the overlay header). While
/// ON, the smart poller keeps the body click-through but the header band and
/// right-edge strip interactive, so the toggle button stays reachable.
/// Typing mode (ask box open) always forces full interactivity.
static PASSTHROUGH_MODE: AtomicU8 = AtomicU8::new(0);

const PASSTHROUGH_OFF: u8 = 0;
const PASSTHROUGH_SMART: u8 = 1;

#[cfg(windows)]
fn set_overlay_click_through(hwnd: windows::Win32::Foundation::HWND, transparent: bool) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_TRANSPARENT, WS_EX_LAYERED,
    };
    unsafe {
        let current = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let next = if transparent {
            current | WS_EX_TRANSPARENT.0 as isize | WS_EX_LAYERED.0 as isize
        } else {
            current & !(WS_EX_TRANSPARENT.0 as isize)
        };
        if next != current {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
        }
    }
}

/// Cursor-poll hover-margin (rival `syncOverlayInteractionPolicy` parity):
/// while Smart mode is on, the overlay body stays click-through (scroll Word
/// beneath it) and becomes interactive only when the cursor hovers the header
/// band — the only region with buttons/drag.
#[cfg(windows)]
fn spawn_smart_passthrough_poller(app: tauri::AppHandle) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(120));
        if PASSTHROUGH_MODE.load(Ordering::Relaxed) != PASSTHROUGH_SMART {
            continue;
        }
        // NOTE: continue (NOT return) on a missing window — the poller is
        // spawned once at window creation and must survive transient None
        // lookups (dev-server reloads, rebuilds). A `return` here killed it
        // permanently and Smart mode silently stopped enforcing click-through
        // (the "I can still write when it's green" bug).
        let Some(w) = app.get_webview_window("overlay:interview-intelligence") else {
            continue;
        };
        if !w.is_visible().unwrap_or(false) {
            continue;
        }
        let Ok(hwnd) = w.hwnd() else { continue };
        let raw = HWND(hwnd.0);
        let mut cursor = windows::Win32::Foundation::POINT::default();
        if unsafe { GetCursorPos(&mut cursor) }.is_err() {
            continue;
        }
        let Ok(pos) = w.outer_position() else { continue };
        let Ok(size) = w.outer_size() else { continue };
        let within = cursor.x >= pos.x
            && cursor.x < pos.x + size.width as i32
            && cursor.y >= pos.y
            && cursor.y < pos.y + size.height as i32;
        // Interactive regions in Smart mode:
        //  - Header band: top 48 logical px = buttons + drag.
        //  - Right-edge strip: ~16 logical px = the response stack's
        //    scrollbar, so previous answers stay scrollable while the body
        //    stays click-through (the whole point of Smart mode).
        let scale = w.scale_factor().unwrap_or(1.0);
        let header_px = (48.0 * scale) as i32;
        let edge_px = (16.0 * scale) as i32;
        let over_header = within && (cursor.y - pos.y) < header_px;
        let over_edge = within && (pos.x + size.width as i32 - cursor.x) < edge_px;
        set_overlay_click_through(raw, !(over_header || over_edge));
    });
}

#[cfg(not(windows))]
fn spawn_smart_passthrough_poller(_app: tauri::AppHandle) {}

/// Content-driven height (reference auto-resize parity): the overlay page reports
/// its panel size and the window grows/shrinks to fit. Height clamped so the
/// panel never runs off-screen.
#[tauri::command]
pub async fn overlay_resize(app: AppHandle, vertical_id: String, height: f64) -> Result<(), String> {
    let label = format!("overlay:{}", vertical_id);
    let Some(window) = app.get_webview_window(&label) else {
        return Err("overlay window not found".into());
    };
    let h = height.clamp(220.0, 880.0); // headroom for the radar "Up next" section
    let size = window
        .inner_size()
        .map_err(|e| e.to_string())?;
    let scale = window.scale_factor().unwrap_or(1.0);
    window
        .set_size(tauri::LogicalSize::new(size.width as f64 / scale, h))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Manual size from the overlay's corner grip — the user took explicit
/// control of the geometry. Width AND height clamped; the content reflows
/// (panel is 100% of the window, the response stack flexes).
#[tauri::command]
pub async fn overlay_set_size(app: AppHandle, vertical_id: String, width: f64, height: f64) -> Result<(), String> {
    let label = format!("overlay:{}", vertical_id);
    let Some(window) = app.get_webview_window(&label) else {
        return Err("overlay window not found".into());
    };
    let w = width.clamp(360.0, 1200.0);
    let h = height.clamp(240.0, 880.0);
    window
        .set_size(tauri::LogicalSize::new(w, h))
        .map_err(|e| e.to_string())
}

/// Overlay placement modes: TopCenter (default), Right (top-right, where the
/// overlay originally lived), Left (top-left). Ctrl+Shift+P cycles through
/// them live; the choice persists for the session.
#[derive(Clone, Copy, PartialEq)]
pub enum OverlayPlacement {
    TopCenter,
    Right,
    Left,
}

impl OverlayPlacement {
    pub fn next(self) -> Self {
        match self {
            OverlayPlacement::TopCenter => OverlayPlacement::Right,
            OverlayPlacement::Right => OverlayPlacement::Left,
            OverlayPlacement::Left => OverlayPlacement::TopCenter,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            OverlayPlacement::TopCenter => "top-center",
            OverlayPlacement::Right => "right",
            OverlayPlacement::Left => "left",
        }
    }
}

fn placement(app: &AppHandle, width: f64, spot: OverlayPlacement) -> (f64, f64) {
    let monitor = app.primary_monitor().ok().flatten();
    match monitor {
        Some(m) => {
            let scale = m.scale_factor();
            let size = m.size(); // PHYSICAL pixels
            let pos = m.position(); // PHYSICAL pixels
            // Tauri window geometry (position/inner_size) is LOGICAL — monitor
            // metrics are PHYSICAL. Mixing them (the old code) pushes the
            // overlay off-screen on any display scaling != 100%, which reads
            // as "the overlay doesn't show up".
            let logical_w = size.width as f64 / scale;
            let monitor_x = pos.x as f64 / scale;
            let x_logical = match spot {
                OverlayPlacement::Right => monitor_x + logical_w - width - MARGIN,
                OverlayPlacement::Left => monitor_x + MARGIN,
                OverlayPlacement::TopCenter => monitor_x + (logical_w - width) / 2.0,
            };
            let y_logical = pos.y as f64 / scale + MARGIN;
            (x_logical.max(monitor_x + MARGIN), y_logical.max(0.0))
        }
        None => (100.0, 100.0),
    }
}

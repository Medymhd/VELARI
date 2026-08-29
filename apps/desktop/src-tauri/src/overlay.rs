//! Stealth overlay — the rival's headline surface: a small always-on-top
//! panel floating over the meeting, excluded from screen capture by the
//! stealth layer (`stealth::enforce_all` covers every webview window).
//! Content arrives via forwarded `overlay://*` events from the main window.

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const WIDTH: f64 = 440.0;
const HEIGHT: f64 = 430.0;
const MARGIN: f64 = 24.0;

#[tauri::command]
pub fn overlay_show(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("overlay") {
        let _ = existing.show();
        return Ok(());
    }
    let (x, y, height) = placement(&app);
    WebviewWindowBuilder::new(&app, "overlay", WebviewUrl::App("overlay.html".into()))
        .title("")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .focused(false)
        .position(x, y)
        .inner_size(WIDTH, height)
        .build()
        .map_err(|e| e.to_string())?;

    // WS_EX_NOACTIVATE: the overlay never becomes the foreground window when
    // clicked — clicks pass through to the meeting app below. Combined with
    // the keyboard tap, users interact without any focus steal that would
    // trigger the meeting app's blur detection.
    if let Some(w) = app.get_webview_window("overlay") {
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
      let _ = w.show();
    }
    Ok(())
}

#[tauri::command]
pub fn overlay_hide(app: AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("overlay") {
        let _ = existing.hide();
    }
    let _ = app.emit("overlay://hidden", ());
    Ok(())
}

/// Top-right of the primary monitor, clamped to its bounds.
fn placement(app: &AppHandle) -> (f64, f64, f64) {
    let monitor = app.primary_monitor().ok().flatten();
    match monitor {
        Some(m) => {
            let size = m.size();
            let pos = m.position();
            let x = pos.x as f64 + size.width as f64 - WIDTH - MARGIN;
            let y = pos.y as f64 + MARGIN;
            let height = (size.height as f64 - 2.0 * MARGIN).min(HEIGHT).max(320.0);
            (x, y, height)
        }
        None => (100.0, 100.0, HEIGHT),
    }
}

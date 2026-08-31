use std::io::Cursor;

use image::{GenericImage, GenericImageView};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use crate::audio::capture::base64_encode;

/// Capture the primary monitor and return base64 PNG
/// (reference `ScreenshotHelper.ts` parity).
#[tauri::command]
pub fn take_screenshot() -> Result<String, String> {
    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    let monitor = monitors.first().ok_or_else(|| "no monitor found".to_string())?;
    let image = monitor.capture_image().map_err(|e| e.to_string())?;
    let mut png = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(base64_encode(&png))
}

/// Fullscreen transparent drag-select overlay (reference `CropperWindowHelper.ts`).
/// The window spans the ENTIRE virtual desktop so one drag can cross monitors;
/// `cropper_select` stitches the per-monitor captures back together.
#[tauri::command]
pub fn open_cropper(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("cropper") {
        let _ = existing.set_focus();
        return Ok(());
    }
    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    if monitors.is_empty() {
        return Err("no monitors found".into());
    }
    // Virtual desktop bounds in physical px (xcap origins are physical).
    let (min_x, min_y) = (
        monitors.iter().map(|m| m.x().unwrap_or(0)).min().unwrap_or(0),
        monitors.iter().map(|m| m.y().unwrap_or(0)).min().unwrap_or(0),
    );
    let (total_w, total_h) = (
        monitors.iter().map(|m| m.x().unwrap_or(0) + m.width().unwrap_or(0) as i32).max().unwrap_or(0) - min_x,
        monitors.iter().map(|m| m.y().unwrap_or(0) + m.height().unwrap_or(0) as i32).max().unwrap_or(0) - min_y,
    );
    if total_w <= 0 || total_h <= 0 {
        return Err("monitors reported no geometry".into());
    }

    // Tauri window geometry is LOGICAL — divide by the primary scale factor.
    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    let (pos_x, pos_y) = (min_x as f64 / scale, min_y as f64 / scale);
    let (size_w, size_h) = (total_w as f64 / scale, total_h as f64 / scale);

    WebviewWindowBuilder::new(&app, "cropper", WebviewUrl::App("cropper.html".into()))
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .position(pos_x, pos_y)
        .inner_size(size_w, size_h)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Capture the region the cropper selected, stitching every intersecting
/// monitor's capture into one canvas (reference `stitchImages` parity).
///
/// Coordinates arrive in virtual-logical px (browser space); Windows places
/// the virtual desktop in primary-monitor DPI space, so the selection is
/// scaled by the primary scale factor into physical px where xcap operates.
#[tauri::command]
pub fn cropper_select(app: tauri::AppHandle, x: i32, y: i32, width: i32, height: i32) -> Result<String, String> {
    if width < 1 || height < 1 {
        return Err("empty selection".into());
    }
    const MAX_DIM: i32 = 10_000; // reference MAX_THUMBNAIL_RATIO guard
    if width > MAX_DIM || height > MAX_DIM {
        return Err("selection too large".into());
    }

    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| m.scale_factor())
        .unwrap_or(1.0);
    // Physical-space selection rect.
    let (px, py) = ((x as f64 * scale).round() as i32, (y as f64 * scale).round() as i32);
    let (pw, ph) = ((width as f64 * scale).round() as i32, (height as f64 * scale).round() as i32);

    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    let mut canvas = image::RgbaImage::new(pw.max(1) as u32, ph.max(1) as u32);
    let mut stitched = 0usize;

    for monitor in &monitors {
        let (mx, my) = (monitor.x().unwrap_or(0), monitor.y().unwrap_or(0));
        let (mw, mh) = (monitor.width().unwrap_or(0) as i32, monitor.height().unwrap_or(0) as i32);
        if mw <= 0 || mh <= 0 {
            continue;
        }
        // Overlap between the selection and this monitor (physical coords).
        let ix = px.max(mx);
        let iy = py.max(my);
        let ir = (px + pw).min(mx + mw);
        let ib = (py + ph).min(my + mh);
        if ir <= ix || ib <= iy {
            continue;
        }

        let capture = monitor.capture_image().map_err(|e| e.to_string())?;
        let local = image::imageops::crop_imm(
            &capture,
            (ix - mx) as u32,
            (iy - my) as u32,
            (ir - ix) as u32,
            (ib - iy) as u32,
        )
        .to_image();
        canvas
            .copy_from(&local, (ix - px) as u32, (iy - py) as u32)
            .map_err(|e| format!("stitch failed: {e}"))?;
        stitched += 1;
    }

    if stitched == 0 {
        return Err("selection outside any monitor".into());
    }

    let mut png = Vec::new();
    canvas
        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(base64_encode(&png))
}

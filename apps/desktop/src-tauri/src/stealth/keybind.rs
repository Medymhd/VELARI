// Copyright (c) 2026. All rights reserved.
// Proprietary — see stealth/LICENSE for terms.
// Global chords — Windows implementation via `RegisterHotKey` (port of
//! reference `KeybindManager.ts` / `winChord.ts` semantics).
//!
//! Threading contract: `WM_HOTKEY` is delivered to the thread that called
//! `RegisterHotKey`, and that thread must pump messages. A single lazy worker
//! owns every registration: commands arrive through a queue drained when the
//! worker is woken by `WM_APP_CHORD`; a `SetTimer` on the worker fires every
//! 10 s to re-register chords other apps may have stolen (reference's health
//! poll). `WM_QUIT` shuts the worker down.

#[cfg(windows)]
mod imp {
    use std::collections::{HashMap, VecDeque};
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{mpsc, Mutex, OnceLock};

    use serde::Serialize;
    use tauri::{AppHandle, Emitter};
    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT,
        MOD_SHIFT, MOD_WIN,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetMessageW, PostThreadMessageW, TranslateMessage, MSG, WM_APP,
        WM_HOTKEY, WM_QUIT,
    };

    pub const EVENT_NAME: &str = "chord://activated";
    const WM_APP_CHORD: u32 = WM_APP + 0x0D;
    const TIMER_ID: usize = 1;
    const HEALTH_POLL_MS: u32 = 10_000;
    const HOTKEY_ID_BASE: i32 = 0xC000; // app-allocated range

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct ChordPayload {
        chord: String,
        action: String,
    }

    enum ChordCmd {
        Register { chord: String, action: String, mods: HOT_KEY_MODIFIERS, vk: u32, reply: mpsc::Sender<Result<(), String>> },
        Unregister { chord: String, reply: mpsc::Sender<Result<(), String>> },
        Recheck,
    }

    struct Worker {
        app: AppHandle,
        next_id: i32,
        /// hotkey id → (chord, action)
        by_id: HashMap<i32, (String, String)>,
    }

    struct Shared {
        queue: Mutex<VecDeque<ChordCmd>>,
        thread_id: AtomicU32,
    }

    fn shared() -> &'static Shared {
        static S: OnceLock<Shared> = OnceLock::new();
        S.get_or_init(|| Shared {
            queue: Mutex::new(VecDeque::new()),
            thread_id: AtomicU32::new(0),
        })
    }

    fn wake() {
        let thread_id = shared().thread_id.load(Ordering::Acquire);
        if thread_id != 0 {
            unsafe {
                let _ = PostThreadMessageW(thread_id, WM_APP_CHORD, WPARAM(0), LPARAM(0));
            }
        }
    }

    unsafe fn drain_commands(worker: &mut Worker, sh: &Shared) {
        let Ok(mut queue) = sh.queue.lock() else { return };
        while let Some(cmd) = queue.pop_front() {
            match cmd {
                ChordCmd::Register { chord, action, mods, vk, reply } => {
                    let id = worker.next_id;
                    worker.next_id += 1;
                    let result = RegisterHotKey(None, id, mods, vk)
                        .map_err(|e| format!("hotkey '{chord}' is taken or invalid: {e}"));
                    if result.is_ok() {
                        worker.by_id.insert(id, (chord.clone(), action));
                    }
                    let _ = reply.send(result);
                }
                ChordCmd::Unregister { chord, reply } => {
                    let result = match worker.by_id.iter().find(|(_, (c, _))| c == &chord).map(|(id, _)| *id) {
                        Some(id) => UnregisterHotKey(None, id)
                            .map(|_| {
                                worker.by_id.remove(&id);
                            })
                            .map_err(|e| format!("unregister failed: {e}")),
                        None => Err(format!("chord not registered: {chord}")),
                    };
                    let _ = reply.send(result);
                }
                ChordCmd::Recheck => re_register_all(worker),
            }
        }
    }

    unsafe fn re_register_all(worker: &mut Worker) {
        let ids: Vec<i32> = worker.by_id.keys().copied().collect();
        for id in ids {
            let _ = UnregisterHotKey(None, id);
        }
        for (id, (chord, _)) in worker.by_id.iter() {
            if let Ok((mods, vk)) = parse_chord(chord) {
                let _ = RegisterHotKey(None, *id, mods, vk);
            }
        }
    }

    pub(crate) fn parse_chord(chord: &str) -> Result<(HOT_KEY_MODIFIERS, u32), String> {
        let mut mods = MOD_NOREPEAT; // hold-to-repeat must not spam
        let mut vk: Option<u32> = None;
        for part in chord.split('+').map(str::trim).filter(|p| !p.is_empty()) {
            match part.to_ascii_lowercase().as_str() {
                "ctrl" | "control" => mods |= MOD_CONTROL,
                "shift" => mods |= MOD_SHIFT,
                "alt" => mods |= MOD_ALT,
                "win" | "meta" => mods |= MOD_WIN,
                "space" => vk = Some(0x20),
                "enter" | "return" => vk = Some(0x0D),
                "esc" | "escape" => vk = Some(0x1B),
                "tab" => vk = Some(0x09),
                _ => {
                    let p = part.to_ascii_uppercase();
                    if p.len() == 1 && p.as_bytes()[0].is_ascii_alphanumeric() {
                        vk = Some(p.as_bytes()[0] as u32);
                    } else if let Some(f) = p.strip_prefix('F') {
                        let n: u32 = f.parse().map_err(|_| format!("unsupported key: {part}"))?;
                        if !(1..=12).contains(&n) {
                            return Err(format!("unsupported key: {part}"));
                        }
                        vk = Some(0x6F + n); // VK_F1 = 0x70
                    } else {
                        return Err(format!("unsupported key: {part}"));
                    }
                }
            }
        }
        match vk {
            Some(v) => Ok((HOT_KEY_MODIFIERS(mods.0), v)),
            None => Err("chord needs at least one non-modifier key".into()),
        }
    }

    pub fn register_chord(app: &AppHandle, chord: String, action: String) -> Result<(), String> {
        let sh = shared();
        ensure_worker(app)?;
        let (mods, vk) = parse_chord(&chord)?;
        let (tx, rx) = mpsc::channel();
        {
            let Ok(mut queue) = sh.queue.lock() else { return Err("chord queue poisoned".into()) };
            queue.push_back(ChordCmd::Register { chord, action, mods, vk, reply: tx });
        }
        wake();
        rx.recv_timeout(std::time::Duration::from_secs(2))
            .map_err(|_| "register timed out".to_string())?
    }

    pub fn unregister_chord(chord: &str) -> Result<(), String> {
        let sh = shared();
        if sh.thread_id.load(Ordering::Acquire) == 0 {
            return Err("chord not registered".into());
        }
        let (tx, rx) = mpsc::channel();
        {
            let Ok(mut queue) = sh.queue.lock() else { return Err("chord queue poisoned".into()) };
            queue.push_back(ChordCmd::Unregister { chord: chord.to_string(), reply: tx });
        }
        wake();
        rx.recv_timeout(std::time::Duration::from_secs(2))
            .map_err(|_| "unregister timed out".to_string())?
    }

    pub fn health_recheck() {
        let sh = shared();
        if sh.thread_id.load(Ordering::Acquire) == 0 {
            return;
        }
        if let Ok(mut queue) = sh.queue.lock() {
            queue.push_back(ChordCmd::Recheck);
        }
        wake();
    }

    pub fn stop_all() {
        let sh = shared();
        let thread_id = sh.thread_id.load(Ordering::Acquire);
        if thread_id != 0 {
            unsafe {
                let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
            sh.thread_id.store(0, Ordering::Release);
        }
    }

    fn ensure_worker(app: &AppHandle) -> Result<(), String> {
        let sh = shared();
        if sh.thread_id.load(Ordering::Acquire) != 0 {
            return Ok(());
        }
        let (started_tx, started_rx) = mpsc::channel::<()>();
        let app = app.clone();
        let worker_thread = std::thread::Builder::new()
            .name("chord-worker".into())
            .spawn(move || unsafe {
                sh.thread_id.store(GetCurrentThreadId(), Ordering::Release);
                let _ = started_tx.send(());
                let mut worker = Worker { app, next_id: HOTKEY_ID_BASE, by_id: HashMap::new() };
                // Health poll: WM_TIMER re-registers stolen hotkeys every 10 s.
                windows::Win32::UI::WindowsAndMessaging::SetTimer(None, TIMER_ID, HEALTH_POLL_MS, None);
                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    match msg.message {
                        WM_APP_CHORD => drain_commands(&mut worker, sh),
                        WM_HOTKEY => {
                            if let Some((chord, action)) = worker.by_id.get(&(msg.wParam.0 as i32)) {
                                let _ = worker.app.emit(
                                    EVENT_NAME,
                                    ChordPayload { chord: chord.clone(), action: action.clone() },
                                );
                            }
                        }
                        _ => {
                            let _ = TranslateMessage(&msg);
                            DispatchMessageW(&msg);
                        }
                    }
                }
                // WM_QUIT
            })
            .map_err(|e| format!("spawn failed: {e}"))?;
        let _ = worker_thread;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while sh.thread_id.load(Ordering::Acquire) == 0 {
            if std::time::Instant::now() > deadline {
                return Err("chord worker did not start".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        Ok(())
    }
}

#[cfg(windows)]
pub use imp::{health_recheck, register_chord, stop_all, unregister_chord, EVENT_NAME};

#[cfg(not(windows))]
pub fn register_chord(_app: &tauri::AppHandle, _chord: String, _action: String) -> Result<(), String> {
    Err("Global chords require Windows (RegisterHotKey) or macOS (Carbon RegisterEventHotKey)".into())
}
#[cfg(not(windows))]
pub fn unregister_chord(_chord: &str) -> Result<(), String> {}
#[cfg(not(windows))]
pub fn health_recheck() {}
#[cfg(not(windows))]
pub fn stop_all() {}

#[tauri::command]
pub fn register_global_chord(app: tauri::AppHandle, chord: String, action: Option<String>) -> Result<(), String> {
    register_chord(&app, chord, action.unwrap_or_else(|| "overlay-toggle".into()))
}

#[tauri::command]
pub fn unregister_global_chord(chord: String) -> Result<(), String> {
    unregister_chord(&chord)
}

#[cfg(windows)]
mod tests {
    use super::imp::parse_chord;
    use windows::Win32::UI::Input::KeyboardAndMouse::{MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT};

    #[test]
    fn parses_modifiers_and_vk() {
        let (mods, vk) = parse_chord("Ctrl+Shift+Space").expect("valid chord");
        assert_eq!(vk, 0x20);
        assert!(mods.0 & MOD_CONTROL.0 != 0);
        assert!(mods.0 & MOD_SHIFT.0 != 0);
        assert!(mods.0 & MOD_NOREPEAT.0 != 0, "hold-to-repeat suppressed");
    }

    #[test]
    fn parses_letters_and_fkeys_case_insensitive() {
        assert_eq!(parse_chord("ctrl+b").unwrap().1, 0x42);
        assert_eq!(parse_chord("F5").unwrap().1, 0x74); // VK_F5
        assert!(parse_chord("Ctrl+Banana").is_err());
        assert!(parse_chord("Shift").is_err(), "modifiers alone are not a chord");
    }
}

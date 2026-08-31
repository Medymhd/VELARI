//! Windows stealth keyboard interception via a WH_KEYBOARD_LL low-level hook.
//!
//! Windows counterpart of the reference's macOS CGEventTap (`keyboard_tap.rs`) —
//! same contract, Tauri events instead of napi tsfn. The overlay receives
//! keystrokes at the OS input layer without stealing focus from the meeting
//! app: plain typing keys are SWALLOWED (hook returns 1) while engaged, and
//! everything the renderer does not consume (system-modifier combos, F-keys,
//! arrows, Tab) is passed through untouched. Swallowing is unconditional while
//! engaged — a pass-through mode would just be a keylogger.
//!
//! Threading: WH_KEYBOARD_LL callbacks run on the installing thread, which
//! must pump messages. A dedicated worker thread installs the hook, signals
//! readiness over mpsc, and blocks on GetMessageW; stop() posts WM_QUIT via
//! PostThreadMessageW and joins. The hook proc has no user-data parameter, so
//! shared state lives in a process-global OnceLock; the proc body is wrapped
//! in catch_unwind so a panic can never unwind across the FFI.

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{mpsc, Mutex, OnceLock};
    use std::time::Duration;

    use serde::Serialize;
    use tauri::{AppHandle, Emitter};
    use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, GetKeyboardLayout, ToUnicodeEx, HKL,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, PostThreadMessageW, SetWindowsHookExW,
        TranslateMessage, UnhookWindowsHookEx, EVENT_SYSTEM_FOREGROUND, HHOOK, KBDLLHOOKSTRUCT,
        MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
        WINEVENT_OUTOFCONTEXT,
    };

    pub const EVENT_NAME: &str = "keyboard://captured";

    // macOS HID codes the renderer contract expects.
    pub const HID_ESC: u32 = 53;
    pub const HID_RETURN: u32 = 36;
    pub const HID_NUMPAD_RETURN: u32 = 76;
    pub const HID_BACKSPACE: u32 = 51;
    const MAC_FLAG_SHIFT: u32 = 1 << 17;
    const MAC_FLAG_CAPS: u32 = 1 << 16;
    const LLKHF_INJECTED: u32 = 0x10;
    const LLKHF_EXTENDED: u32 = 0x01;

    pub struct CapturedKey {
        pub key_code: u32,
        pub chars: String,
        pub flags: u32,
        pub is_key_down: bool,
        pub is_outside_mouse_down: bool,
        pub app_chord_id: String,
    }

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct CapturedKeyPayload {
        key_code: u32,
        chars: String,
        flags: u32,
        is_key_down: bool,
        is_outside_mouse_down: bool,
        app_chord_id: String,
    }

    struct HookState {
        active: AtomicBool,
        worker_thread_id: AtomicU32,
        keyboard_hook: Mutex<isize>,
        foreground_hook: Mutex<isize>,
        app: Mutex<Option<AppHandle>>,
        join: Mutex<Option<std::thread::JoinHandle<()>>>,
    }

    fn state() -> &'static Mutex<HookState> {
        static S: OnceLock<Mutex<HookState>> = OnceLock::new();
        S.get_or_init(|| {
            Mutex::new(HookState {
                active: AtomicBool::new(false),
                worker_thread_id: AtomicU32::new(0),
                keyboard_hook: Mutex::new(0),
                foreground_hook: Mutex::new(0),
                app: Mutex::new(None),
                join: Mutex::new(None),
            })
        })
    }

    /// Translate a Windows VK to the macOS HID code the renderer expects.
    /// 0 = ordinary printable (deliver chars only).
    pub fn vk_to_hid(vk: u32, extended: bool) -> u32 {
        match vk {
            0x1B => HID_ESC,
            0x0D => {
                if extended {
                    HID_NUMPAD_RETURN
                } else {
                    HID_RETURN
                }
            }
            0x08 => HID_BACKSPACE,
            _ => 0,
        }
    }

    /// Keys the hook NEVER delivers (renderer contract): system modifiers,
    /// F1-F24, arrows, Tab, and lock keys pass through to the foreground app.
    pub fn is_pass_through(vk: u32) -> bool {
        matches!(vk,
            0x10 | 0xA0..=0xA5          // shift variants
            | 0x11 | 0xA2 | 0xA3        // ctrl
            | 0x12 | 0xA4               // alt / alt-gr
            | 0x5B | 0x5C               // win keys
            | 0x14 | 0x90 | 0x91        // caps/num/scroll lock
            | 0x70..=0x87               // F1-F24
            | 0x25..=0x28               // arrows
            | 0x09                      // tab
        )
    }

    fn emit_key(key: CapturedKey) {
        let app = state().lock().ok().and_then(|s| s.app.lock().ok().and_then(|a| a.clone()));
        if let Some(app) = app {
            let payload = CapturedKeyPayload {
                key_code: key.key_code,
                chars: key.chars,
                flags: key.flags,
                is_key_down: key.is_key_down,
                is_outside_mouse_down: key.is_outside_mouse_down,
                app_chord_id: key.app_chord_id,
            };
            let _ = app.emit(EVENT_NAME, payload);
        }
    }

    unsafe fn key_chars(vk: u32, scan: u32) -> String {
        let hkl: HKL = GetKeyboardLayout(0);
        let mut buf = [0u16; 8];
        let state = [0u8; 256];
        let n = ToUnicodeEx(vk, scan, &state, &mut buf, 0, hkl);
        if n > 0 {
            String::from_utf16_lossy(&buf[..n as usize])
        } else {
            String::new()
        }
    }

    unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        // Panic guard: a hook proc that unwinds across the FFI kills the process.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if code < 0 {
                return CallNextHookEx(None, code, wparam, lparam);
            }
            let Ok(st) = state().lock() else {
                return CallNextHookEx(None, code, wparam, lparam);
            };
            if !st.active.load(Ordering::Acquire) {
                return CallNextHookEx(None, code, wparam, lparam);
            }

            let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            // Pass through events we did not originate (re-injection safety).
            if kb.flags.0 & 0x10 != 0 {
                return CallNextHookEx(None, code, wparam, lparam);
            }

            let vk = kb.vkCode as u32;
            let msg = wparam.0 as u32;
            let is_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            let is_up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
            if !is_down && !is_up {
                return CallNextHookEx(None, code, wparam, lparam);
            }

            if is_pass_through(vk) {
                return CallNextHookEx(None, code, wparam, lparam);
            }

            if is_down {
                let hid = vk_to_hid(vk, kb.flags.0 & 0x01 != 0);
                let mut flags = 0u32;
                if GetAsyncKeyState(0x10) as u16 & 0x8000 != 0 {
                    flags |= MAC_FLAG_SHIFT;
                }
                if GetAsyncKeyState(0x14) as u16 & 0x8000 != 0 {
                    flags |= MAC_FLAG_CAPS;
                }
                let chars = if hid == 0 { key_chars(vk, kb.scanCode) } else { String::new() };
                emit_key(CapturedKey {
                    key_code: hid,
                    chars,
                    flags,
                    is_key_down: true,
                    is_outside_mouse_down: false,
                    app_chord_id: String::new(),
                });
            }

            // Swallow: the foreground meeting app never sees this key.
            LRESULT(1)
        }));
        match result {
            Ok(r) => r,
            Err(_) => CallNextHookEx(None, code, wparam, lparam),
        }
    }

    unsafe extern "system" fn foreground_proc(
        _hook: HWINEVENTHOOK,
        event: u32,
        _hwnd: windows::Win32::Foundation::HWND,
        _id_object: i32,
        _id_child: i32,
        _thread: u32,
        _time: u32,
    ) {
        if event != EVENT_SYSTEM_FOREGROUND {
            return;
        }
        let Ok(st) = state().lock() else { return };
        if st.active.load(Ordering::Acquire) {
            emit_key(CapturedKey {
                key_code: 0,
                chars: String::new(),
                flags: 0,
                is_key_down: false,
                // Foreground switched away — the JS layer turns this into stop().
                is_outside_mouse_down: true,
                app_chord_id: String::new(),
            });
        }
    }

    pub fn start_tap(app: AppHandle) -> Result<(), String> {
        let s = state();
        let mut st = s.lock().map_err(|e| e.to_string())?;
        if st.active.load(Ordering::Acquire) {
            return Err("stealth keyboard tap already running".into());
        }
        let (ready_tx, ready_rx) = mpsc::channel();
        *st.app.lock().map_err(|e| e.to_string())? = Some(app);

        let handle = std::thread::Builder::new()
            .name("keyboard-hook".into())
            .spawn(move || unsafe {
                let hmodule = GetModuleHandleW(None).unwrap_or_default();
                let hook = match SetWindowsHookExW(
                    WH_KEYBOARD_LL,
                    Some(keyboard_proc),
                    HINSTANCE(hmodule.0),
                    0,
                )
                .map_err(|e| format!("SetWindowsHookExW failed: {e}"))
                {
                    Ok(h) => h,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                let fg = SetWinEventHook(
                    EVENT_SYSTEM_FOREGROUND,
                    EVENT_SYSTEM_FOREGROUND,
                    None,
                    Some(foreground_proc),
                    0,
                    0,
                    WINEVENT_OUTOFCONTEXT,
                );
                {
                    let Ok(mut st) = state().lock() else { return };
                    *st.keyboard_hook.lock().unwrap() = hook.0 as isize;
                    *st.foreground_hook.lock().unwrap() = fg.0 as isize;
                    st.worker_thread_id.store(GetCurrentThreadId(), Ordering::Release);
                    st.active.store(true, Ordering::Release);
                }
                let _ = ready_tx.send(Ok(()));

                // The hook callback only fires while this thread pumps messages.
                let mut msg = MSG::default();
                while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            })
            .map_err(|e| format!("spawn failed: {e}"))?;

        *st.join.lock().map_err(|e| e.to_string())? = Some(handle);
        drop(st);

        match ready_rx.recv_timeout(Duration::from_secs(2)) {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => {
                stop_tap();
                Err(e)
            }
            Err(_) => {
                stop_tap();
                Err("keyboard hook install timed out".into())
            }
        }
    }

    pub fn stop_tap() {
        let s = state();
        let Ok(mut st) = s.lock() else { return };
        st.active.store(false, Ordering::SeqCst);
        let thread_id = st.worker_thread_id.load(Ordering::Acquire);
        if thread_id != 0 {
            unsafe {
                let _ = PostThreadMessageW(thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
            }
        }
        if let Ok(mut kh) = st.keyboard_hook.lock() {
            if *kh != 0 {
                unsafe {
                    let _ = UnhookWindowsHookEx(HHOOK(*kh as *mut core::ffi::c_void));
                }
                *kh = 0;
            }
        }
        if let Ok(mut fh) = st.foreground_hook.lock() {
            if *fh != 0 {
                unsafe {
                    let _ = UnhookWinEvent(HWINEVENTHOOK(*fh as *mut core::ffi::c_void));
                }
                *fh = 0;
            }
        }
        st.worker_thread_id.store(0, Ordering::Release);
        let join = st.join.lock();
        if let Ok(mut j) = join {
            if let Some(handle) = j.take() {
                let _ = handle.join();
            }
        }
    }
}

#[cfg(windows)]
pub use imp::{start_tap, stop_tap};

#[cfg(not(windows))]
pub fn start_tap(_app: tauri::AppHandle) -> Result<(), String> {
    Err("Stealth keyboard tap requires Windows (WH_KEYBOARD_LL) or macOS (CGEventTap)".into())
}

#[cfg(not(windows))]
pub fn stop_tap() {}

/// macOS gates on AXIsProcessTrusted; Windows low-level hooks need no
/// accessibility grant, so the command reports granted there.
#[tauri::command]
pub fn is_accessibility_granted() -> bool {
    true
}

/// Opt-in per session: installs the OS keyboard tap and starts forwarding
/// captured keys on `keyboard://captured` while swallowing them system-wide.
#[tauri::command]
pub fn stealth_keyboard_start(app: tauri::AppHandle) -> Result<(), String> {
    start_tap(app)
}

#[tauri::command]
pub fn stealth_keyboard_stop() -> Result<(), String> {
    stop_tap();
    Ok(())
}

#[cfg(windows)]
mod tests {
    use super::imp::{is_pass_through, vk_to_hid, HID_BACKSPACE, HID_ESC, HID_NUMPAD_RETURN, HID_RETURN};

    #[test]
    fn vk_translation_matches_renderer_contract() {
        assert_eq!(vk_to_hid(0x1B, false), HID_ESC);
        assert_eq!(vk_to_hid(0x0D, false), HID_RETURN);
        assert_eq!(vk_to_hid(0x0D, true), HID_NUMPAD_RETURN);
        assert_eq!(vk_to_hid(0x08, false), HID_BACKSPACE);
        assert_eq!(vk_to_hid(0x41, false), 0, "printables deliver chars only");
    }

    #[test]
    fn pass_through_never_delivers_system_keys() {
        for vk in [0x10, 0x11, 0x12, 0x5B, 0x14, 0x70, 0x87, 0x25, 0x28, 0x09] {
            assert!(is_pass_through(vk), "vk {vk:#x} must pass through");
        }
        for vk in [0x41, 0x1B, 0x0D, 0x08, 0x20] {
            assert!(!is_pass_through(vk), "vk {vk:#x} must be captured");
        }
    }
}

//! Full-screen frosted overlay.
//!
//! Window show/hide MUST run on the main thread — calling `WebviewWindow::show` from
//! the keyboard poll thread is a no-op on Windows, which is why hold-to-wake looked
//! dead. Screen capture is spawned so it cannot stall that thread either.
//!
//! After the hotkey is released, the frost drops and the overlay becomes click-through
//! so the user can keep working. Hits on the Guide-Dot / answer card still land on Pointy.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::capture::Shot;
use crate::Pointy;

pub const LABEL: &str = "overlay";

static ENABLED: AtomicBool = AtomicBool::new(false);
static OVERLAY_OWNED_MIC: AtomicBool = AtomicBool::new(false);
/// Clicks and keys go to the app underneath, except over `HIT`.
static PASSTHROUGH: AtomicBool = AtomicBool::new(false);
static LAST_IGNORE: AtomicBool = AtomicBool::new(false);
static POLL_STARTED: AtomicBool = AtomicBool::new(false);

/// Logical CSS pixels of the interactive pill, relative to the overlay webview.
#[derive(Clone, Copy, Default)]
struct HitRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

static HIT: Mutex<HitRect> = Mutex::new(HitRect {
    x: 0.0,
    y: 0.0,
    w: 0.0,
    h: 0.0,
});

#[derive(Debug, Deserialize)]
pub struct HitRectDto {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[cfg(windows)]
static PREV_FOREGROUND: Mutex<isize> = Mutex::new(0);

/// Arm or silence hold-to-wake. Enabling does **not** show the overlay — it only
/// appears on key-down. Disabling hides it immediately.
pub fn set_enabled(app: &AppHandle, enabled: bool) {
    ENABLED.store(enabled, Ordering::SeqCst);
    if !enabled {
        hide(app);
    }
}

/// One-time setup at launch. Starts hidden.
pub fn prepare(app: &AppHandle) {
    let Some(window) = window(app) else { return };
    let _ = window.set_ignore_cursor_events(false);
    let _ = window.hide();
    start_passthrough_poll(app);
}

/// Hotkey went down: raise the glass and listen. The screenshot is taken later,
/// when the user sends the question, so NIM sees the screen at ask time.
pub fn begin_listen(app: &AppHandle) {
    if !ENABLED.load(Ordering::SeqCst) {
        eprintln!("[pointy] wake ignored — overlay not enabled (finish setup first)");
        return;
    }

    set_passthrough(app, false);
    remember_foreground();

    if let Some(state) = app.try_state::<Pointy>() {
        state.audio.stop_levels();
    }
    OVERLAY_OWNED_MIC.store(false, Ordering::SeqCst);
    show_fullscreen(app);
}

/// Hide Pointy, photograph the desktop, then put the glass back.
/// Call this when the user sends — not on hotkey down/up.
///
/// This deliberately leaves `PASSTHROUGH` alone. Clearing it here made the
/// re-shown overlay grab focus and eat every click, which is why the screen felt
/// frozen for as long as Pointy was thinking.
pub fn snapshot_desktop(app: &AppHandle, window_id: Option<u32>) -> Result<Shot, String> {
    conceal_for_capture(app);
    // Raise the subject so the crop is not covered by whatever sat on top of it.
    // Doing this at capture time rather than at pick time leaves Pointy focused
    // while the user dictates, and leaves their app focused afterwards.
    if let Some(id) = window_id {
        focus_hwnd(id);
    }
    std::thread::sleep(Duration::from_millis(110));

    let shot = crate::capture::capture(window_id);

    show_fullscreen(app);

    let shot = shot?;
    if let Some(state) = app.try_state::<Pointy>() {
        state.wake.remember(&shot);
    }
    Ok(shot)
}

/// Bring the window the user picked to the front so it is what gets captured.
pub fn focus_app_window(id: u32) {
    focus_hwnd(id);
}

/// Hide the overlay without emitting `overlay://hidden` or wiping the wake session.
fn conceal_for_capture(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = window(&handle) {
            let _ = window.hide();
        }
    });
}

/// Hotkey went up: stop the microphone only if this overlay opened it.
pub fn end_listen(app: &AppHandle) {
    if !OVERLAY_OWNED_MIC.swap(false, Ordering::SeqCst) {
        return;
    }
    if let Some(state) = app.try_state::<Pointy>() {
        state.audio.stop_levels();
    }
}

/// Let the user keep working: clicks pass through except on the Guide-Dot / card.
pub fn set_passthrough(app: &AppHandle, enabled: bool) {
    let was = PASSTHROUGH.swap(enabled, Ordering::SeqCst);
    if enabled && !was {
        restore_foreground();
        apply_ignore(app, true);
    }
    if !enabled {
        apply_ignore(app, false);
    }
}

pub fn set_hit_rect(rect: HitRectDto) {
    if let Ok(mut hit) = HIT.lock() {
        *hit = HitRect {
            x: rect.x,
            y: rect.y,
            w: rect.w.max(1.0),
            h: rect.h.max(1.0),
        };
    }
}

pub fn show_fullscreen(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || show_fullscreen_now(&handle));
}

pub fn hide(app: &AppHandle) {
    PASSTHROUGH.store(false, Ordering::SeqCst);
    apply_ignore(app, false);
    if let Some(state) = app.try_state::<Pointy>() {
        state.audio.stop_levels();
        state.wake.clear();
    }
    OVERLAY_OWNED_MIC.store(false, Ordering::SeqCst);
    let _ = app.emit("overlay://hidden", ());
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = window(&handle) {
            let _ = window.hide();
        }
    });
}

fn show_fullscreen_now(app: &AppHandle) {
    if !ENABLED.load(Ordering::SeqCst) {
        return;
    }
    let Some(window) = window(app) else {
        eprintln!("[pointy] overlay window is missing");
        return;
    };
    place_fullscreen(&window);
    let _ = window.set_always_on_top(true);
    let _ = window.unminimize();
    if let Err(err) = window.show() {
        eprintln!("[pointy] overlay show failed: {err}");
    }
    if !PASSTHROUGH.load(Ordering::SeqCst) {
        let _ = window.set_focus();
    }
}

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

fn place_fullscreen(window: &WebviewWindow) {
    let monitor = match window.current_monitor() {
        Ok(Some(monitor)) => Some(monitor),
        _ => window.primary_monitor().ok().flatten(),
    };
    let Some(monitor) = monitor else { return };

    let area = monitor.size();
    let origin = monitor.position();
    let _ = window.set_position(PhysicalPosition::new(origin.x, origin.y));
    let _ = window.set_size(PhysicalSize::new(area.width, area.height));
}

fn apply_ignore(app: &AppHandle, ignore: bool) {
    if LAST_IGNORE.swap(ignore, Ordering::SeqCst) == ignore {
        return;
    }
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = window(&handle) {
            let _ = window.set_ignore_cursor_events(ignore);
        }
    });
}

fn start_passthrough_poll(app: &AppHandle) {
    if POLL_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    std::thread::Builder::new()
        .name("pointy-passthrough".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_millis(16));
            if !PASSTHROUGH.load(Ordering::SeqCst) {
                continue;
            }
            let over_pill = cursor_over_hit(&handle);
            apply_ignore(&handle, !over_pill);
        })
        .ok();
}

fn cursor_over_hit(app: &AppHandle) -> bool {
    let Some(window) = window(app) else {
        return false;
    };
    let Ok(origin) = window.outer_position() else {
        return false;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let hit = match HIT.lock() {
        Ok(hit) => *hit,
        Err(_) => return false,
    };
    if hit.w < 1.0 || hit.h < 1.0 {
        return false;
    }

    let pad = 10.0 * scale;
    let left = origin.x as f64 + hit.x * scale - pad;
    let top = origin.y as f64 + hit.y * scale - pad;
    let right = left + hit.w * scale + pad * 2.0;
    let bottom = top + hit.h * scale + pad * 2.0;

    let Some((cx, cy)) = cursor_screen() else {
        return false;
    };
    (cx as f64) >= left && (cx as f64) <= right && (cy as f64) >= top && (cy as f64) <= bottom
}

#[cfg(windows)]
fn cursor_screen() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut point = POINT::default();
    unsafe { GetCursorPos(&mut point) }.ok()?;
    Some((point.x, point.y))
}

#[cfg(not(windows))]
fn cursor_screen() -> Option<(i32, i32)> {
    None
}

#[cfg(windows)]
fn remember_foreground() {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    let hwnd = unsafe { GetForegroundWindow() };
    if let Ok(mut prev) = PREV_FOREGROUND.lock() {
        *prev = hwnd.0 as isize;
    }
}

#[cfg(not(windows))]
fn remember_foreground() {}

#[cfg(windows)]
fn restore_foreground() {
    let raw = PREV_FOREGROUND.lock().ok().map(|g| *g).unwrap_or(0);
    if raw == 0 {
        return;
    }
    focus_raw_hwnd(raw);
}

#[cfg(not(windows))]
fn restore_foreground() {}

#[cfg(windows)]
fn focus_hwnd(id: u32) {
    // xcap reports window ids as the truncated HWND, which is lossless in practice
    // on Windows — handles stay inside 32 bits.
    focus_raw_hwnd(id as isize);
    if let Ok(mut prev) = PREV_FOREGROUND.lock() {
        *prev = id as isize;
    }
}

#[cfg(windows)]
fn focus_raw_hwnd(raw: isize) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetForegroundWindow, ShowWindow, SW_RESTORE};

    let hwnd = HWND(raw as *mut std::ffi::c_void);
    unsafe {
        let _ = ShowWindow(hwnd, SW_RESTORE);
        let _ = SetForegroundWindow(hwnd);
    }
}

#[cfg(not(windows))]
fn focus_hwnd(_id: u32) {}

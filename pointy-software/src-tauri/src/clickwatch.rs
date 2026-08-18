//! Retire the highlight once the user has actually clicked it.
//!
//! While an answer is on screen the overlay is click-through, so the glow can
//! never receive the click itself — the press goes straight to the app
//! underneath. This samples the cursor and the left mouse button on the same
//! 8ms cadence as the misclick watcher and emits `point://clicked` when a press
//! lands inside the highlighted box. Nothing runs unless a highlight is up, and
//! the watch ends at the first hit.

#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(windows)]
use std::sync::{Arc, Mutex, OnceLock};
#[cfg(windows)]
use std::time::Duration;

use tauri::AppHandle;

/// Matches the misclick watcher: responsive without spinning a core.
#[cfg(windows)]
const POLL: Duration = Duration::from_millis(8);

/// The one active watch. Replacing it drops — and so stops — the previous one.
#[cfg(windows)]
static ACTIVE: OnceLock<Mutex<Option<Watch>>> = OnceLock::new();

#[cfg(windows)]
struct Watch {
    stop: Arc<AtomicBool>,
}

#[cfg(windows)]
impl Drop for Watch {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// Start watching a box given as 0..1 fractions of the virtual desktop.
#[cfg(windows)]
pub fn watch(app: AppHandle, x: f64, y: f64, w: f64, h: f64) {
    let box_px = crate::uia::hint_from_fractions(x, y, w, h);
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let _ = std::thread::Builder::new()
        .name("pointy-clickwatch".into())
        .spawn(move || run(app, box_px, thread_stop));
    if let Ok(mut slot) = ACTIVE.get_or_init(|| Mutex::new(None)).lock() {
        *slot = Some(Watch { stop });
    }
}

/// Stop watching, because the highlight was hidden or the session ended.
#[cfg(windows)]
pub fn unwatch() {
    if let Ok(mut slot) = ACTIVE.get_or_init(|| Mutex::new(None)).lock() {
        *slot = None;
    }
}

#[cfg(windows)]
fn run(app: AppHandle, box_px: crate::uia::Hint, stop: Arc<AtomicBool>) {
    use tauri::Emitter;

    // Seed from the current state so a button already held when the highlight
    // appears is not read as the click we are waiting for.
    let mut was_down = left_button_down();
    loop {
        if stop.load(Ordering::SeqCst) {
            return;
        }
        std::thread::sleep(POLL);

        let down = left_button_down();
        let pressed = down && !was_down;
        was_down = down;
        if !pressed {
            continue;
        }

        let Some((x, y)) = cursor() else { continue };
        let inside = x >= box_px.x
            && x < box_px.x.saturating_add(box_px.w)
            && y >= box_px.y
            && y < box_px.y.saturating_add(box_px.h);
        if inside {
            let _ = app.emit("point://clicked", ());
            return;
        }
    }
}

#[cfg(windows)]
fn left_button_down() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    // High bit is the current state. The low bit ("pressed since last call") is
    // shared global state and would race with the other pollers.
    (unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) }) as u16 & 0x8000 != 0
}

#[cfg(windows)]
fn cursor() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut point = POINT::default();
    unsafe { GetCursorPos(&mut point) }.ok()?;
    Some((point.x, point.y))
}

#[cfg(not(windows))]
pub fn watch(_app: AppHandle, _x: f64, _y: f64, _w: f64, _h: f64) {}

#[cfg(not(windows))]
pub fn unwatch() {}

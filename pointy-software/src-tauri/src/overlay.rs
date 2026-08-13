//! The push-to-talk pill window.
//!
//! It is declared in `tauri.conf.json` as a transparent, undecorated, always-on-top
//! window that starts hidden, so it exists from launch and appearing costs nothing but
//! a `show()`. Rust owns showing it — the pill has to be on screen the instant the
//! combo closes, before any JavaScript runs. Hiding is the frontend's call, once the
//! release animation has played out (see `src/overlay.tsx`).

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, PhysicalPosition, WebviewWindow};

pub const LABEL: &str = "overlay";

/// Distance from the bottom of the screen to the bottom of the window, in logical
/// pixels. The pill is centred in a taller transparent canvas (the extra room is for its
/// shadow), so it lands roughly 30 px above the taskbar.
const BOTTOM_MARGIN: f64 = 12.0;

/// Whether the hotkey should raise the pill at all.
///
/// It must not during onboarding: the speak step already draws its own live meter, and
/// there is one microphone stream for the whole app — the pill starting levels would
/// take it away from the setup window, and stopping them on release would leave that
/// window's meter dead.
static ENABLED: AtomicBool = AtomicBool::new(false);

/// Arm the pill and put it on screen, or take it away entirely.
///
/// Once armed the pill stays visible — idle and click-through — the way a system overlay
/// does. Showing it only for the duration of a hold would mean the user never learns
/// where it lives.
pub fn set_enabled(app: &AppHandle, enabled: bool) {
    ENABLED.store(enabled, Ordering::SeqCst);
    if enabled {
        show(app);
    } else {
        hide(app);
    }
}

/// One-time setup at launch.
pub fn prepare(app: &AppHandle) {
    let Some(window) = window(app) else { return };
    // The pill floats over other apps, so it must never swallow a click meant for
    // whatever is underneath it.
    let _ = window.set_ignore_cursor_events(true);
    place(&window);
}

/// Bring the pill on screen. Cheap and idempotent — safe to call on every key-down.
pub fn show(app: &AppHandle) {
    if !ENABLED.load(Ordering::SeqCst) {
        return;
    }
    let Some(window) = window(app) else { return };
    // Re-place on every press: the user may have moved to another monitor, or the
    // resolution may have changed, since the last one.
    place(&window);
    let _ = window.show();
}

pub fn hide(app: &AppHandle) {
    if let Some(window) = window(app) {
        let _ = window.hide();
    }
}

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

/// Centre the pill horizontally, near the bottom of its monitor.
fn place(window: &WebviewWindow) {
    // A hidden window has no monitor of its own on some platforms, so fall back to
    // the primary one.
    let monitor = match window.current_monitor() {
        Ok(Some(monitor)) => Some(monitor),
        _ => window.primary_monitor().ok().flatten(),
    };
    let Some(monitor) = monitor else { return };
    let Ok(size) = window.outer_size() else { return };

    let area = monitor.size();
    let origin = monitor.position();
    let margin = (BOTTOM_MARGIN * monitor.scale_factor()) as i32;

    let x = origin.x + (area.width as i32 - size.width as i32) / 2;
    let y = origin.y + area.height as i32 - size.height as i32 - margin;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

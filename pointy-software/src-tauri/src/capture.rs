//! Screen capture and open-window enumeration.
//!
//! Two things live here:
//!
//! * `list_windows` — the real windows the user has open, so Pointy can ask which
//!   app to work on instead of guessing from a screenshot.
//! * `capture` — a PNG data URL of either the whole primary monitor or the crop
//!   belonging to one window. Every shot reports where it sits on the monitor as
//!   0..1 fractions, so a control the model boxes inside the crop can be mapped
//!   back onto the full-screen overlay.

use std::io::Cursor;
use std::sync::Mutex;

use base64::Engine;
use serde::{Deserialize, Serialize};
use xcap::image::RgbaImage;
use xcap::{Monitor, Window};

/// One capture plus the region of the monitor it covers, in 0..1 fractions.
#[derive(Debug, Clone, Serialize)]
pub struct Shot {
    pub image: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// A window the user could pick as the subject of their question.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppWindow {
    pub id: u32,
    pub app: String,
    pub title: String,
    pub focused: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct WakeSession {
    pub screenshot: Option<String>,
    pub transcript: String,
}

#[derive(Default)]
pub struct WakeStore {
    inner: Mutex<WakeSession>,
}

impl WakeStore {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(WakeSession::default()),
        }
    }

    pub fn remember(&self, shot: &Shot) {
        let mut session = self.inner.lock().unwrap();
        session.screenshot = Some(shot.image.clone());
    }

    pub fn set_transcript(&self, transcript: String) {
        self.inner.lock().unwrap().transcript = transcript;
    }

    pub fn get(&self) -> WakeSession {
        self.inner.lock().unwrap().clone()
    }

    /// Drop screenshot and transcript. Call when the overlay hides so a later
    /// question cannot reuse audio or a frame from a previous session.
    pub fn clear(&self) {
        *self.inner.lock().unwrap() = WakeSession::default();
    }
}

/// Windows worth offering as a subject: on screen, big enough to work in, not ours.
pub fn list_windows() -> Result<Vec<AppWindow>, String> {
    let windows = Window::all().map_err(|e| format!("Could not list windows: {e}"))?;
    // The overlay is on screen while the picker is open, so Pointy would otherwise
    // offer itself as a subject. Matching on pid is exact; the name check is a
    // fallback and deliberately narrow, because a user's project folder may well
    // be called "pointy".
    let own_pid = std::process::id();

    let mut found: Vec<(i64, AppWindow)> = Vec::new();
    for window in windows {
        if window.pid().unwrap_or(0) == own_pid || window.is_minimized().unwrap_or(false) {
            continue;
        }
        let title = window.title().unwrap_or_default().trim().to_string();
        let app = window.app_name().unwrap_or_default().trim().to_string();
        if title.is_empty() || is_own_window(&app) {
            continue;
        }
        let width = window.width().unwrap_or(0) as i64;
        let height = window.height().unwrap_or(0) as i64;
        if width < 220 || height < 140 {
            continue;
        }
        let Ok(id) = window.id() else { continue };

        let focused = window.is_focused().unwrap_or(false);
        // Focused first, then biggest — the window they are staring at is the
        // one they almost certainly mean.
        let rank = if focused { i64::MAX } else { width * height };
        found.push((
            rank,
            AppWindow {
                id,
                app: if app.is_empty() { title.clone() } else { app },
                title,
                focused,
            },
        ));
    }

    found.sort_by(|a, b| b.0.cmp(&a.0));
    let mut out: Vec<AppWindow> = Vec::new();
    for (_, window) in found {
        if out
            .iter()
            .any(|kept| kept.app == window.app && kept.title == window.title)
        {
            continue;
        }
        out.push(window);
        if out.len() == 8 {
            break;
        }
    }
    Ok(out)
}

/// Capture the primary monitor, cropped to `window` when one is given.
pub fn capture(window_id: Option<u32>) -> Result<Shot, String> {
    let monitor = primary_monitor()?;
    let full = monitor
        .capture_image()
        .map_err(|e| format!("Could not capture the screen: {e}"))?;

    let region = window_id.and_then(|id| monitor_fraction_of_window(&monitor, id));
    let Some((fx, fy, fw, fh)) = region else {
        return Ok(Shot {
            image: encode_png(&full)?,
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
        });
    };

    // Fractions -> pixels of *this* capture, so DPI scaling cannot skew the crop.
    let iw = full.width();
    let ih = full.height();
    let cx = (fx * iw as f64).round().clamp(0.0, (iw - 1) as f64) as u32;
    let cy = (fy * ih as f64).round().clamp(0.0, (ih - 1) as f64) as u32;
    let cw = ((fw * iw as f64).round() as u32).clamp(1, iw - cx);
    let ch = ((fh * ih as f64).round() as u32).clamp(1, ih - cy);

    let cropped = RgbaImage::from_fn(cw, ch, |x, y| *full.get_pixel(cx + x, cy + y));
    Ok(Shot {
        image: encode_png(&cropped)?,
        x: cx as f64 / iw as f64,
        y: cy as f64 / ih as f64,
        w: cw as f64 / iw as f64,
        h: ch as f64 / ih as f64,
    })
}

/// Where a window sits on the monitor, as 0..1 fractions clipped to the screen.
fn monitor_fraction_of_window(monitor: &Monitor, id: u32) -> Option<(f64, f64, f64, f64)> {
    let mx = monitor.x().ok()?;
    let my = monitor.y().ok()?;
    let mw = monitor.width().ok()? as i32;
    let mh = monitor.height().ok()? as i32;
    if mw <= 0 || mh <= 0 {
        return None;
    }

    let window = Window::all()
        .ok()?
        .into_iter()
        .find(|w| w.id().map(|found| found == id).unwrap_or(false))?;

    let left = (window.x().ok()? - mx).clamp(0, mw);
    let top = (window.y().ok()? - my).clamp(0, mh);
    let right = (window.x().ok()? - mx + window.width().ok()? as i32).clamp(0, mw);
    let bottom = (window.y().ok()? - my + window.height().ok()? as i32).clamp(0, mh);
    if right - left < 40 || bottom - top < 40 {
        return None;
    }

    Some((
        left as f64 / mw as f64,
        top as f64 / mh as f64,
        (right - left) as f64 / mw as f64,
        (bottom - top) as f64 / mh as f64,
    ))
}

fn primary_monitor() -> Result<Monitor, String> {
    let monitors = Monitor::all().map_err(|e| format!("Could not list displays: {e}"))?;
    monitors
        .into_iter()
        .find(|monitor| monitor.is_primary().unwrap_or(false))
        .or_else(|| Monitor::all().ok().and_then(|all| all.into_iter().next()))
        .ok_or_else(|| "No display found to capture.".to_string())
}

fn encode_png(image: &RgbaImage) -> Result<String, String> {
    let mut png = Cursor::new(Vec::new());
    image
        .write_to(&mut png, xcap::image::ImageFormat::Png)
        .map_err(|e| format!("Could not encode the screenshot: {e}"))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
    Ok(format!("data:image/png;base64,{encoded}"))
}

fn is_own_window(app: &str) -> bool {
    let lower = app.to_lowercase();
    lower.contains("pointy-software") || lower == "pointy" || lower == "pointy.exe"
}

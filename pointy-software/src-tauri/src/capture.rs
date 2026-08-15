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
use image::imageops::FilterType;
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

/// A capture already sized for the vision model: a downscaled JPEG plus the
/// fraction of the monitor it covers (so the model's box maps back to screen).
#[derive(Debug, Clone, Serialize)]
pub struct AskCapture {
    pub image: String,
    pub width: u32,
    pub height: u32,
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

    pub fn remember_image(&self, image: &str) {
        self.inner.lock().unwrap().screenshot = Some(image.to_string());
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

/// Capture the primary monitor, cropped to `window` when one is given (full PNG).
pub fn capture(window_id: Option<u32>) -> Result<Shot, String> {
    let (image, x, y, w, h) = capture_region(window_id)?;
    Ok(Shot {
        image: encode_png(&image)?,
        x,
        y,
        w,
        h,
    })
}

/// Capture for the vision model: cropped, downscaled and JPEG-encoded in memory.
/// The full-res PNG never exists, so nothing heavy crosses the IPC boundary.
pub fn capture_ask(window_id: Option<u32>, max_edge: u32) -> Result<AskCapture, String> {
    let (image, x, y, w, h) = capture_region(window_id)?;
    let scaled = downscale(&image, max_edge);
    let (width, height) = scaled.dimensions();
    Ok(AskCapture {
        image: encode_jpeg(&scaled, 85)?,
        width,
        height,
        x,
        y,
        w,
        h,
    })
}

fn capture_region(window_id: Option<u32>) -> Result<(RgbaImage, f64, f64, f64, f64), String> {
    // Capture the monitor the subject window actually sits on (not always the
    // primary), and report the crop's position as 0..1 fractions of the full
    // virtual desktop, so the overlay — which spans every monitor — can map a
    // control the model boxes back to the correct physical place.
    let monitor = monitor_for_window(window_id)?;
    let full = monitor
        .capture_image()
        .map_err(|e| format!("Could not capture the screen: {e}"))?;

    let (vx, vy, vw, vh) = virtual_desktop_bounds();
    let vw = vw.max(1) as f64;
    let vh = vh.max(1) as f64;
    let mon_x = monitor.x().unwrap_or(0) as f64;
    let mon_y = monitor.y().unwrap_or(0) as f64;
    let mon_w = monitor.width().unwrap_or(1) as f64;
    let mon_h = monitor.height().unwrap_or(1) as f64;

    let region = window_id.and_then(|id| monitor_fraction_of_window(&monitor, id));
    let Some((fx, fy, fw, fh)) = region else {
        return Ok((
            full,
            (mon_x - vx as f64) / vw,
            (mon_y - vy as f64) / vh,
            mon_w / vw,
            mon_h / vh,
        ));
    };

    // Fractions -> pixels of *this* capture, so DPI scaling cannot skew the crop.
    let iw = full.width();
    let ih = full.height();
    let cx = (fx * iw as f64).round().clamp(0.0, (iw - 1) as f64) as u32;
    let cy = (fy * ih as f64).round().clamp(0.0, (ih - 1) as f64) as u32;
    let cw = ((fw * iw as f64).round() as u32).clamp(1, iw - cx);
    let ch = ((fh * ih as f64).round() as u32).clamp(1, ih - cy);

    let cropped = RgbaImage::from_fn(cw, ch, |x, y| *full.get_pixel(cx + x, cy + y));
    Ok((
        cropped,
        (mon_x + cx as f64 - vx as f64) / vw,
        (mon_y + cy as f64 - vy as f64) / vh,
        cw as f64 / vw,
        ch as f64 / vh,
    ))
}

/// The monitor whose area contains the center of the subject window (falls
/// back to the primary monitor, then to the first available).
fn monitor_for_window(window_id: Option<u32>) -> Result<Monitor, String> {
    let monitors = Monitor::all().map_err(|e| format!("Could not list displays: {e}"))?;
    if monitors.is_empty() {
        return Err("No display found to capture.".to_string());
    }

    if let Some(id) = window_id {
        if let Some((cx, cy)) = window_center(id) {
            for monitor in &monitors {
                let mx = monitor.x().unwrap_or(0);
                let my = monitor.y().unwrap_or(0);
                let mw = monitor.width().unwrap_or(0) as i32;
                let mh = monitor.height().unwrap_or(0) as i32;
                if cx >= mx && cx < mx + mw && cy >= my && cy < my + mh {
                    return Ok(monitor.clone());
                }
            }
        }
    }

    monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .cloned()
        .or_else(|| monitors.first().cloned())
        .ok_or_else(|| "No display found to capture.".to_string())
}

/// Center of a window in virtual-screen (physical) pixels.
fn window_center(id: u32) -> Option<(i32, i32)> {
    let window = Window::all()
        .ok()?
        .into_iter()
        .find(|w| w.id().map(|found| found == id).unwrap_or(false))?;
    let cx = window.x().ok()? + window.width().ok()? as i32 / 2;
    let cy = window.y().ok()? + window.height().ok()? as i32 / 2;
    Some((cx, cy))
}

/// Union of every monitor's bounds: the full virtual desktop, in physical
/// pixels. The origin can be negative when a monitor sits left of/above the
/// primary.
pub fn virtual_desktop_bounds() -> (i32, i32, u32, u32) {
    let monitors = Monitor::all().unwrap_or_default();
    if monitors.is_empty() {
        return (0, 0, 0, 0);
    }
    let min_x = monitors.iter().filter_map(|m| m.x().ok()).min().unwrap_or(0);
    let min_y = monitors.iter().filter_map(|m| m.y().ok()).min().unwrap_or(0);
    let max_r = monitors
        .iter()
        .filter_map(|m| Some(m.x().ok()? + m.width().ok()? as i32))
        .max()
        .unwrap_or(0);
    let max_b = monitors
        .iter()
        .filter_map(|m| Some(m.y().ok()? + m.height().ok()? as i32))
        .max()
        .unwrap_or(0);
    (
        min_x,
        min_y,
        (max_r - min_x).max(0) as u32,
        (max_b - min_y).max(0) as u32,
    )
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

fn encode_png(image: &RgbaImage) -> Result<String, String> {
    let mut png = Cursor::new(Vec::new());
    image
        .write_to(&mut png, xcap::image::ImageFormat::Png)
        .map_err(|e| format!("Could not encode the screenshot: {e}"))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
    Ok(format!("data:image/png;base64,{encoded}"))
}

/// Shrink the long edge to `max_edge`, keeping the aspect ratio.
fn downscale(image: &RgbaImage, max_edge: u32) -> RgbaImage {
    let (w, h) = image.dimensions();
    let long = w.max(h);
    if long <= max_edge {
        return image.clone();
    }
    let scale = max_edge as f32 / long as f32;
    let nw = ((w as f32 * scale).round() as u32).max(1);
    let nh = ((h as f32 * scale).round() as u32).max(1);
    image::imageops::resize(image, nw, nh, FilterType::Triangle)
}

fn encode_jpeg(image: &RgbaImage, quality: u8) -> Result<String, String> {
    let rgb = image::DynamicImage::ImageRgba8(image.clone()).to_rgb8();
    let mut buffer = Cursor::new(Vec::new());
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, quality);
    encoder
        .encode(rgb.as_raw(), rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8)
        .map_err(|e| format!("Could not encode the screenshot: {e}"))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(buffer.into_inner());
    Ok(format!("data:image/jpeg;base64,{encoded}"))
}

fn is_own_window(app: &str) -> bool {
    let lower = app.to_lowercase();
    lower.contains("pointy-software") || lower == "pointy" || lower == "pointy.exe"
}

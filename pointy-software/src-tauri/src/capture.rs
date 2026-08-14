//! Primary-monitor screenshot as a PNG data URL (base64).
//!
//! Capture runs *before* the overlay is shown so the frost is not in the shot.

use std::io::Cursor;
use std::sync::Mutex;

use base64::Engine;
use serde::Serialize;
use xcap::Monitor;

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

    pub fn begin_capture(&self) -> Result<String, String> {
        let screenshot = capture_primary()?;
        let mut session = self.inner.lock().unwrap();
        *session = WakeSession {
            screenshot: Some(screenshot.clone()),
            transcript: String::new(),
        };
        Ok(screenshot)
    }

    pub fn set_transcript(&self, transcript: String) {
        self.inner.lock().unwrap().transcript = transcript;
    }

    pub fn get(&self) -> WakeSession {
        self.inner.lock().unwrap().clone()
    }
}

/// Capture the primary monitor and return a `data:image/png;base64,...` string.
pub fn capture_primary() -> Result<String, String> {
    let monitors = Monitor::all().map_err(|e| format!("Could not list displays: {e}"))?;
    if monitors.is_empty() {
        return Err("No display found to capture.".into());
    }

    let primary = monitors
        .iter()
        .find(|monitor| monitor.is_primary().unwrap_or(false))
        .unwrap_or(&monitors[0]);

    let image = primary
        .capture_image()
        .map_err(|e| format!("Could not capture the screen: {e}"))?;

    let mut png = Cursor::new(Vec::new());
    image
        .write_to(&mut png, xcap::image::ImageFormat::Png)
        .map_err(|e| format!("Could not encode the screenshot: {e}"))?;

    let encoded = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
    Ok(format!("data:image/png;base64,{encoded}"))
}

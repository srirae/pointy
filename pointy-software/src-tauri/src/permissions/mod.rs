//! OS permission state for the three capabilities Pointy's pipeline needs.
//!
//! | Capability   | Used by                                                    |
//! |--------------|------------------------------------------------------------|
//! | microphone   | wake word + speech-to-text (steps 1–2 of the pipeline)     |
//! | screen       | the screenshot sent to the vision model (step 3)           |
//! | accessibility| real bounding boxes for the guide-dot (step 4)             |
//!
//! Every value reported here comes from an actual OS query or capability probe. There
//! is no hardcoded "granted" anywhere: on Windows, where two of the three have no
//! consent dialog to inspect, we perform the operation itself against a scratch target
//! and report whether it succeeded.

use serde::Serialize;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as platform;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as platform;

#[cfg(not(any(windows, target_os = "macos")))]
mod other;
#[cfg(not(any(windows, target_os = "macos")))]
use other as platform;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    /// Verified working.
    Granted,
    /// The OS refused. Actionable by the user.
    Denied,
    /// Nothing was granted or refused yet; the OS will prompt on first use.
    /// Only reachable on macOS — Windows has no "not determined" state.
    #[allow(dead_code)]
    Prompt,
    /// The check itself could not run. Treated as blocking, with the reason shown.
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Capability {
    Microphone,
    Screen,
    Accessibility,
}

impl Capability {
    pub fn id(self) -> &'static str {
        match self {
            Capability::Microphone => "microphone",
            Capability::Screen => "screen",
            Capability::Accessibility => "accessibility",
        }
    }

    pub fn parse(id: &str) -> Option<Self> {
        match id {
            "microphone" => Some(Capability::Microphone),
            "screen" => Some(Capability::Screen),
            "accessibility" => Some(Capability::Accessibility),
            _ => None,
        }
    }

    pub const ALL: [Capability; 3] = [
        Capability::Microphone,
        Capability::Screen,
        Capability::Accessibility,
    ];
}

#[derive(Debug, Clone, Serialize)]
pub struct PermissionStatus {
    pub id: &'static str,
    pub state: State,
    /// One sentence naming what was checked or what failed. Rendered verbatim.
    pub detail: String,
    /// Whether `open_settings` has somewhere to send the user for this capability.
    pub can_open_settings: bool,
}

pub fn status(capability: Capability) -> PermissionStatus {
    platform::status(capability)
}

pub fn status_all() -> Vec<PermissionStatus> {
    Capability::ALL.iter().copied().map(status).collect()
}

/// Trigger the OS consent flow where one exists, then re-check. On Windows this opens
/// the relevant Settings page, because an unpackaged desktop app cannot raise the
/// microphone consent dialog itself.
pub fn request(capability: Capability) -> PermissionStatus {
    platform::request(capability)
}

pub fn open_settings(capability: Capability) -> Result<(), String> {
    platform::open_settings(capability)
}

/// Launch a settings URI without pulling in a shell-open dependency.
pub(crate) fn launch_uri(uri: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", uri])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Could not open {uri}: {e}"))
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("open")
            .arg(uri)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Could not open {uri}: {e}"))
    }
}

//! Non-Windows, non-macOS fallback. Pointy targets Windows and macOS; this exists so
//! the crate still builds elsewhere and says honestly that it does not know.

use crate::audio::{probe_microphone, MicProbe};
use crate::permissions::{Capability, PermissionStatus, State};

pub fn status(capability: Capability) -> PermissionStatus {
    match capability {
        Capability::Microphone => {
            let (state, detail) = match probe_microphone() {
                MicProbe::Ok => (
                    State::Granted,
                    "Microphone opened successfully.".to_string(),
                ),
                MicProbe::Denied(detail) => (State::Denied, detail),
                MicProbe::Unavailable(detail) => (State::Unknown, detail),
            };
            PermissionStatus {
                id: capability.id(),
                state,
                detail,
                can_open_settings: false,
            }
        }
        other => PermissionStatus {
            id: other.id(),
            state: State::Unknown,
            detail: "This platform is not supported yet.".to_string(),
            can_open_settings: false,
        },
    }
}

pub fn request(capability: Capability) -> PermissionStatus {
    status(capability)
}

pub fn open_settings(_capability: Capability) -> Result<(), String> {
    Err("This platform is not supported yet.".into())
}

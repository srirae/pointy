//! Windows permission checks.
//!
//! Windows has exactly one consent gate of the three: the microphone privacy toggle.
//! Screen capture and UI Automation are not gated by a consent dialog, but they can
//! still fail — a locked or secure desktop refuses BitBlt, and an app whose
//! accessibility tree is unavailable refuses UI Automation. So instead of returning a
//! hardcoded "granted" for those two, we exercise the capability against a scratch
//! target and report the real outcome.

use windows::core::HSTRING;
use windows::Security::Authorization::AppCapabilityAccess::{
    AppCapability, AppCapabilityAccessStatus,
};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, ReleaseDC,
    SelectObject, SRCCOPY,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};

use crate::audio::{probe_microphone, MicProbe};
use crate::permissions::{launch_uri, Capability, PermissionStatus, State};

const MIC_SETTINGS: &str = "ms-settings:privacy-microphone";

pub fn status(capability: Capability) -> PermissionStatus {
    match capability {
        Capability::Microphone => microphone(),
        Capability::Screen => screen(),
        Capability::Accessibility => accessibility(),
    }
}

pub fn request(capability: Capability) -> PermissionStatus {
    match capability {
        // No API lets an unpackaged Win32 app raise the microphone consent dialog.
        // Opening the privacy page is the real path, so we send the user there and
        // re-check when they come back.
        Capability::Microphone => {
            let current = microphone();
            if current.state != State::Granted {
                let _ = launch_uri(MIC_SETTINGS);
            }
            current
        }
        // Nothing to request — these are capability probes, not consent gates.
        other => status(other),
    }
}

pub fn open_settings(capability: Capability) -> Result<(), String> {
    match capability {
        Capability::Microphone => launch_uri(MIC_SETTINGS),
        Capability::Screen | Capability::Accessibility => {
            Err("Windows has no settings page for this — it is not a consent gate.".into())
        }
    }
}

fn microphone() -> PermissionStatus {
    // First ask the OS directly. This answers for packaged builds and for machines
    // where the global microphone switch is off.
    let declared = capability_status("microphone");

    let (state, detail) = match declared {
        Some(status) if status == AppCapabilityAccessStatus::DeniedBySystem => (
            State::Denied,
            "Microphone access is switched off for this device in Windows privacy settings."
                .to_string(),
        ),
        Some(status) if status == AppCapabilityAccessStatus::DeniedByUser => (
            State::Denied,
            "Windows is blocking microphone access for this app.".to_string(),
        ),
        Some(status) if status == AppCapabilityAccessStatus::Allowed => {
            (State::Granted, "Microphone access allowed by Windows.".to_string())
        }
        // NotDeclaredByApp / UserPromptRequired / unreadable: an unpackaged build has
        // no capability manifest to read, so fall through to opening the device.
        _ => match probe_microphone() {
            MicProbe::Ok => (
                State::Granted,
                "Microphone opened successfully.".to_string(),
            ),
            MicProbe::Denied(detail) => (State::Denied, detail),
            MicProbe::Unavailable(detail) => (State::Unknown, detail),
        },
    };

    PermissionStatus {
        id: capability_id(Capability::Microphone),
        state,
        detail,
        can_open_settings: true,
    }
}

fn capability_status(name: &str) -> Option<AppCapabilityAccessStatus> {
    let capability = AppCapability::Create(&HSTRING::from(name)).ok()?;
    capability.CheckAccess().ok()
}

/// Copy an 8×8 block off the desktop. Succeeds whenever real screen capture would.
fn screen() -> PermissionStatus {
    let (state, detail) = unsafe {
        let screen_dc = GetDC(None);
        if screen_dc.0.is_null() {
            (
                State::Denied,
                "Windows would not hand out a desktop device context.".to_string(),
            )
        } else {
            let mem_dc = CreateCompatibleDC(Some(screen_dc));
            let bitmap = CreateCompatibleBitmap(screen_dc, 8, 8);
            let previous = SelectObject(mem_dc, bitmap.into());
            let copied = BitBlt(mem_dc, 0, 0, 8, 8, Some(screen_dc), 0, 0, SRCCOPY);

            SelectObject(mem_dc, previous);
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(mem_dc);
            ReleaseDC(None, screen_dc);

            match copied {
                Ok(()) => (
                    State::Granted,
                    "Screen capture verified — Pointy can read the screen when you ask it to."
                        .to_string(),
                ),
                Err(err) => (
                    State::Denied,
                    format!("Screen capture failed: {err}"),
                ),
            }
        }
    };

    PermissionStatus {
        id: capability_id(Capability::Screen),
        state,
        detail,
        can_open_settings: false,
    }
}

/// Ask UI Automation for the desktop root and read one property off it. This is the
/// same interface that will resolve element bounding boxes for the guide-dot.
fn accessibility() -> PermissionStatus {
    // COM apartment state is per-thread and Tauri's main thread is already
    // initialised, so run the probe somewhere we fully control.
    let result = std::thread::Builder::new()
        .name("pointy-uia-probe".into())
        .spawn(|| unsafe {
            let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let automation: IUIAutomation =
                match CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) {
                    Ok(automation) => automation,
                    Err(err) => {
                        if init.is_ok() {
                            CoUninitialize();
                        }
                        return Err(format!("UI Automation is unavailable: {err}"));
                    }
                };

            let outcome = automation
                .GetRootElement()
                .and_then(|root| root.CurrentName())
                .map(|name| name.to_string())
                .map_err(|err| format!("UI Automation refused the desktop tree: {err}"));

            if init.is_ok() {
                CoUninitialize();
            }
            outcome
        })
        .and_then(|handle| handle.join().map_err(|_| std::io::Error::other("probe panicked")));

    let (state, detail) = match result {
        Ok(Ok(_)) => (
            State::Granted,
            "UI Automation reachable — Pointy can locate the exact element to point at."
                .to_string(),
        ),
        Ok(Err(detail)) => (State::Denied, detail),
        Err(err) => (State::Unknown, format!("Could not run the check: {err}")),
    };

    PermissionStatus {
        id: capability_id(Capability::Accessibility),
        state,
        detail,
        can_open_settings: false,
    }
}

fn capability_id(capability: Capability) -> &'static str {
    capability.id()
}

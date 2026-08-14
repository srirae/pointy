//! macOS permission checks.
//!
//! SCAFFOLD — written against the documented TCC entry points but not yet run on a
//! Mac. Unlike Windows, all three capabilities here are real consent gates, so the
//! state comes straight from the OS rather than from a capability probe:
//!
//! * microphone    — `AVCaptureDevice.authorizationStatusForMediaType(.audio)`
//! * screen        — `CGPreflightScreenCaptureAccess` / `CGRequestScreenCaptureAccess`
//! * accessibility — `AXIsProcessTrusted`
//!
//! Verify on a Mac before shipping: confirm the four AVAuthorizationStatus values, and
//! that the app is signed — TCC keys grants to the code signature, so an unsigned dev
//! build re-prompts on every launch.

use std::ffi::c_char;

use objc2::runtime::AnyClass;
use objc2::{class, msg_send};

use crate::permissions::{launch_uri, Capability, PermissionStatus, State};

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

const PANE_MICROPHONE: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
const PANE_SCREEN: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
const PANE_ACCESSIBILITY: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";

/// AVAuthorizationStatus
const NOT_DETERMINED: isize = 0;
const RESTRICTED: isize = 1;
const DENIED: isize = 2;
const AUTHORIZED: isize = 3;

pub fn status(capability: Capability) -> PermissionStatus {
    match capability {
        Capability::Microphone => microphone(),
        Capability::Screen => screen(),
        Capability::Accessibility => accessibility(),
    }
}

pub fn request(capability: Capability) -> PermissionStatus {
    match capability {
        Capability::Microphone => {
            // Opening the device is what raises the system prompt; the status call
            // alone never does.
            let _ = crate::audio::probe_microphone();
            microphone()
        }
        Capability::Screen => {
            unsafe { CGRequestScreenCaptureAccess() };
            screen()
        }
        Capability::Accessibility => {
            // AXIsProcessTrustedWithOptions can raise the prompt, but it needs a
            // CoreFoundation dictionary; sending the user to the pane is equivalent
            // and keeps this scaffold dependency-free.
            let _ = launch_uri(PANE_ACCESSIBILITY);
            accessibility()
        }
    }
}

pub fn open_settings(capability: Capability) -> Result<(), String> {
    launch_uri(match capability {
        Capability::Microphone => PANE_MICROPHONE,
        Capability::Screen => PANE_SCREEN,
        Capability::Accessibility => PANE_ACCESSIBILITY,
    })
}

fn microphone() -> PermissionStatus {
    let raw = unsafe {
        // AVMediaTypeAudio is the string constant "soun".
        let media_type: *mut objc2::runtime::AnyObject = {
            let cls: &AnyClass = class!(NSString);
            let bytes = b"soun\0".as_ptr() as *const c_char;
            msg_send![cls, stringWithUTF8String: bytes]
        };
        let cls: &AnyClass = class!(AVCaptureDevice);
        let status: isize = msg_send![cls, authorizationStatusForMediaType: media_type];
        status
    };

    let (state, detail) = match raw {
        AUTHORIZED => (State::Granted, "Microphone access granted.".to_string()),
        DENIED => (
            State::Denied,
            "macOS is blocking microphone access for Pointy.".to_string(),
        ),
        RESTRICTED => (
            State::Denied,
            "Microphone access is restricted by a device policy.".to_string(),
        ),
        NOT_DETERMINED => (
            State::Prompt,
            "macOS will ask for the microphone the first time Pointy listens.".to_string(),
        ),
        other => (
            State::Unknown,
            format!("Unrecognised authorization status ({other})."),
        ),
    };

    PermissionStatus {
        id: Capability::Microphone.id(),
        state,
        detail,
        can_open_settings: true,
    }
}

fn screen() -> PermissionStatus {
    let granted = unsafe { CGPreflightScreenCaptureAccess() };
    PermissionStatus {
        id: Capability::Screen.id(),
        state: if granted {
            State::Granted
        } else {
            State::Denied
        },
        detail: if granted {
            "Screen recording permission granted.".to_string()
        } else {
            "macOS needs Screen Recording permission before Pointy can read the screen.".to_string()
        },
        can_open_settings: true,
    }
}

fn accessibility() -> PermissionStatus {
    let trusted = unsafe { AXIsProcessTrusted() };
    PermissionStatus {
        id: Capability::Accessibility.id(),
        state: if trusted {
            State::Granted
        } else {
            State::Denied
        },
        detail: if trusted {
            "Accessibility access granted — Pointy can locate the exact element to point at."
                .to_string()
        } else {
            "macOS needs Accessibility access so Pointy can find the element to point at."
                .to_string()
        },
        can_open_settings: true,
    }
}

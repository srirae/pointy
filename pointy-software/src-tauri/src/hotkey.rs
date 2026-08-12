//! Global hotkey capture and push-to-talk matching.
//!
//! Key transitions arrive from `crate::keyboard` for the life of the process and flow
//! through `Inner::on_key`, which behaves according to the current mode:
//!
//! * `Mode::Idle`    — track which keys are held, emit nothing.
//! * `Mode::Capture` — the "record your hotkey" step. Report the growing key set as
//!                     the user presses, and finalise on full release.
//! * `Mode::Armed`   — the saved hotkey is live. Emit `hotkey://down` the moment the
//!                     whole combo is held and `hotkey://up` when it breaks, which is
//!                     exactly the push-to-talk edge Phase 1 needs for capture start
//!                     and stop.
//!
//! Observing key state rather than claiming an OS-level accelerator is deliberate:
//! modifier-only combos (Ctrl+Win, Alt+Space) cannot be registered as accelerators at
//! all, and observation never fails with "hotkey already registered" against another
//! app. The trade-off is that Pointy does not swallow the keystroke — the combo also
//! reaches the focused app, so combos that already mean something get rejected by the
//! validator below.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::keyboard::KeySink;
use crate::keys;

/// A hotkey, stored as canonically ordered key tokens (see `keys::token`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Combo {
    pub keys: Vec<String>,
}

impl Combo {
    pub fn new(keys: Vec<String>) -> Self {
        Self { keys: canonical(keys) }
    }

    pub fn label(&self) -> String {
        self.keys.join(" + ")
    }

    fn id(&self) -> String {
        self.keys.join("+")
    }

    fn is_held_by(&self, pressed: &[String]) -> bool {
        !self.keys.is_empty() && self.keys.iter().all(|k| pressed.iter().any(|p| p == k))
    }
}

/// Result of checking a candidate combo against the binding rules.
#[derive(Debug, Clone, Serialize)]
pub struct Validation {
    pub valid: bool,
    /// Plain-language reason the combo was rejected, ready to render as-is.
    pub reason: Option<String>,
    pub combo: Combo,
}

/// Combos the OS or the window manager takes first — binding them produces a hotkey
/// that fires unreliably or not at all, so they are refused at capture time.
const RESERVED: &[&str] = &[
    "Ctrl+Alt+Delete",
    "Ctrl+Shift+Escape",
    "Ctrl+Escape",
    "Alt+Tab",
    "Alt+Shift+Tab",
    "Alt+F4",
    "Alt+Space",
    "Win+L",
    "Win+Tab",
    "Win+D",
    "Win+E",
    "Win+R",
    "Win+X",
    "Win+I",
    "Win+A",
    "Win+S",
    "Win+V",
    "Win+P",
    "Win+G",
    "Win+H",
    "Win+K",
    "Win+M",
];

const MAX_KEYS: usize = 3;

/// Canonical ordering: modifiers in Ctrl, Alt, Shift, Win order, then the main key.
/// Duplicates collapse; order of pressing does not matter.
pub fn canonical(keys: Vec<String>) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<String> = keys
        .into_iter()
        .filter(|k| seen.insert(k.clone()))
        .collect();
    out.sort_by_key(|k| keys::sort_rank(k));
    out
}

pub fn validate(keys: Vec<String>) -> Validation {
    let combo = Combo::new(keys);
    let modifiers = combo.keys.iter().filter(|k| keys::is_modifier(k)).count();
    let plain = combo.keys.len() - modifiers;

    let reason = if combo.keys.is_empty() {
        Some("Press the keys you want to use.".to_string())
    } else if combo.keys.len() > MAX_KEYS {
        Some(format!(
            "Keep it to {MAX_KEYS} keys or fewer — longer combos are awkward to hold."
        ))
    } else if modifiers == 0 {
        Some(
            "Add a modifier — Ctrl, Alt, Shift or Win. A plain key would fire while you type."
                .to_string(),
        )
    } else if plain > 1 {
        Some("Use one regular key at most, plus modifiers.".to_string())
    } else if plain == 0 && modifiers < 2 {
        Some("A single modifier fires too easily. Use two modifiers, or add a key.".to_string())
    } else if RESERVED.contains(&combo.id().as_str()) {
        Some(format!(
            "{} already belongs to the system. Try another combo.",
            combo.label()
        ))
    } else {
        None
    };

    Validation {
        valid: reason.is_none(),
        reason,
        combo,
    }
}

#[derive(Debug, Clone, Serialize)]
struct CaptureUpdate {
    keys: Vec<String>,
    validation: Validation,
}

#[derive(Clone)]
enum Mode {
    Idle,
    Capture,
    Armed(Combo),
}

struct Inner {
    app: AppHandle,
    mode: Mutex<Mode>,
    /// Keys physically held right now, in press order.
    pressed: Mutex<Vec<String>>,
    /// Largest key set seen during the current capture — the user's intended combo is
    /// the peak of the press, not whatever is still held when they start letting go.
    capture_best: Mutex<Vec<String>>,
    armed_down: AtomicBool,
}

impl KeySink for Arc<Inner> {
    fn on_key(&self, token: &str, down: bool) {
        if down {
            {
                let mut pressed = self.pressed.lock().unwrap();
                if pressed.iter().any(|p| p == token) {
                    return; // already held
                }
                pressed.push(token.to_string());
            }
            self.after_press();
        } else {
            {
                let mut pressed = self.pressed.lock().unwrap();
                pressed.retain(|p| p != token);
            }
            self.after_release(token);
        }
    }
}

impl Inner {
    fn after_press(&self) {
        let mode = self.mode.lock().unwrap().clone();
        match mode {
            Mode::Capture => {
                let pressed = self.pressed.lock().unwrap().clone();
                {
                    let mut best = self.capture_best.lock().unwrap();
                    if pressed.len() >= best.len() {
                        *best = pressed.clone();
                    }
                }
                let keys = canonical(pressed);
                let _ = self.app.emit(
                    "hotkey://capture-progress",
                    CaptureUpdate {
                        keys: keys.clone(),
                        validation: validate(keys),
                    },
                );
            }
            Mode::Armed(combo) => {
                let pressed = self.pressed.lock().unwrap().clone();
                if combo.is_held_by(&pressed)
                    && !self.armed_down.swap(true, Ordering::SeqCst)
                {
                    let _ = self.app.emit("hotkey://down", combo);
                }
            }
            Mode::Idle => {}
        }
    }

    fn after_release(&self, token: &str) {
        let mode = self.mode.lock().unwrap().clone();
        match mode {
            Mode::Capture => {
                if !self.pressed.lock().unwrap().is_empty() {
                    let pressed = self.pressed.lock().unwrap().clone();
                    let keys = canonical(pressed);
                    let _ = self.app.emit(
                        "hotkey://capture-progress",
                        CaptureUpdate {
                            keys: keys.clone(),
                            validation: validate(keys),
                        },
                    );
                    return; // still mid-combo
                }
                let best = std::mem::take(&mut *self.capture_best.lock().unwrap());
                let keys = canonical(best);
                let validation = validate(keys.clone());
                if validation.valid {
                    // Stop capturing on the first valid combo; an invalid one leaves
                    // capture mode running so the user can simply press again.
                    *self.mode.lock().unwrap() = Mode::Idle;
                }
                let _ = self.app.emit(
                    "hotkey://capture-complete",
                    CaptureUpdate { keys, validation },
                );
            }
            Mode::Armed(combo) => {
                if combo.keys.iter().any(|k| k == token)
                    && self.armed_down.swap(false, Ordering::SeqCst)
                {
                    let _ = self.app.emit("hotkey://up", combo);
                }
            }
            Mode::Idle => {}
        }
    }
}

pub struct HotkeyManager {
    inner: Arc<Inner>,
}

impl HotkeyManager {
    /// Start reading the keyboard. Returns immediately; the source lives on its own
    /// thread for the process lifetime.
    pub fn start(app: AppHandle) -> Self {
        let inner = Arc::new(Inner {
            app: app.clone(),
            mode: Mutex::new(Mode::Idle),
            pressed: Mutex::new(Vec::new()),
            capture_best: Mutex::new(Vec::new()),
            armed_down: AtomicBool::new(false),
        });

        if let Err(err) = crate::keyboard::spawn(inner.clone()) {
            // Nothing else in the app can recover this, so tell the UI: without the
            // keyboard source there is no hotkey, and onboarding must say so plainly.
            let _ = app.emit("hotkey://hook-failed", err);
        }

        Self { inner }
    }

    pub fn start_capture(&self) {
        eprintln!("[hotkey] start_capture");
        *self.inner.capture_best.lock().unwrap() = Vec::new();
        *self.inner.mode.lock().unwrap() = Mode::Capture;
        self.inner.armed_down.store(false, Ordering::SeqCst);
    }

    pub fn stop_capture(&self) {
        let mut mode = self.inner.mode.lock().unwrap();
        if matches!(*mode, Mode::Capture) {
            *mode = Mode::Idle;
        }
    }

    pub fn arm(&self, combo: Combo) {
        self.inner.armed_down.store(false, Ordering::SeqCst);
        *self.inner.mode.lock().unwrap() = Mode::Armed(combo);
    }

    pub fn disarm(&self) {
        self.inner.armed_down.store(false, Ordering::SeqCst);
        *self.inner.mode.lock().unwrap() = Mode::Idle;
    }

    pub fn armed_combo(&self) -> Option<Combo> {
        match &*self.inner.mode.lock().unwrap() {
            Mode::Armed(combo) => Some(combo.clone()),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(list: &[&str]) -> Vec<String> {
        list.iter().map(|k| k.to_string()).collect()
    }

    #[test]
    fn canonical_orders_modifiers_then_key_and_dedupes() {
        assert_eq!(canonical(keys(&["P", "Shift", "Ctrl"])), keys(&["Ctrl", "Shift", "P"]));
        assert_eq!(canonical(keys(&["Win", "Ctrl"])), keys(&["Ctrl", "Win"]));
        assert_eq!(canonical(keys(&["Ctrl", "Ctrl"])), keys(&["Ctrl"]));
    }

    #[test]
    fn press_order_does_not_change_the_combo() {
        assert_eq!(
            Combo::new(keys(&["Shift", "Ctrl", "P"])),
            Combo::new(keys(&["Ctrl", "P", "Shift"]))
        );
    }

    #[test]
    fn accepts_modifier_plus_key_and_two_modifiers() {
        assert!(validate(keys(&["Ctrl", "Shift", "P"])).valid);
        assert!(validate(keys(&["Ctrl", "Win"])).valid);
        assert!(validate(keys(&["Ctrl", "Alt", "P"])).valid);
    }

    #[test]
    fn rejects_a_bare_key() {
        let result = validate(keys(&["P"]));
        assert!(!result.valid);
        assert!(result.reason.unwrap().contains("modifier"));
    }

    #[test]
    fn rejects_a_lone_modifier_but_not_a_pair() {
        assert!(!validate(keys(&["Ctrl"])).valid);
        assert!(validate(keys(&["Ctrl", "Alt"])).valid);
    }

    #[test]
    fn rejects_more_than_one_regular_key() {
        assert!(!validate(keys(&["Ctrl", "P", "K"])).valid);
    }

    #[test]
    fn rejects_more_than_three_keys() {
        assert!(!validate(keys(&["Ctrl", "Alt", "Shift", "P"])).valid);
    }

    #[test]
    fn rejects_combos_the_os_owns() {
        for reserved in [
            keys(&["Win", "L"]),
            keys(&["Alt", "Tab"]),
            keys(&["Ctrl", "Alt", "Delete"]),
            keys(&["Ctrl", "Shift", "Escape"]),
        ] {
            let result = validate(reserved.clone());
            assert!(!result.valid, "{reserved:?} should be rejected");
            assert!(result.reason.unwrap().contains("system"));
        }
    }

    #[test]
    fn combo_matches_only_when_every_key_is_held() {
        let combo = Combo::new(keys(&["Ctrl", "Alt", "P"]));
        assert!(!combo.is_held_by(&keys(&["Ctrl"])));
        assert!(!combo.is_held_by(&keys(&["Ctrl", "Alt"])));
        assert!(combo.is_held_by(&keys(&["Alt", "P", "Ctrl"])));
        // extra keys held alongside still count as held
        assert!(combo.is_held_by(&keys(&["Ctrl", "Alt", "P", "Shift"])));
    }

    #[test]
    fn empty_combo_never_matches() {
        assert!(!Combo::default().is_held_by(&keys(&["Ctrl"])));
    }
}

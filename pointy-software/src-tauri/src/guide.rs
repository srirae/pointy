//! Guided walkthrough — a patient, one-step-at-a-time guide.
//!
//! Triggered when a single query's answer says the task is multi-step. The
//! frontend shows the first step, then this module watches the real
//! accessibility tree of the target window to notice, *locally and without an
//! AI call*, that the user finished the step (focus moved, the page/view
//! changed, a checkbox flipped, a dialog opened). Only then does it capture a
//! fresh screenshot and ask the model for the next step. There is no
//! continuous screen watching — just a cheap tree poll plus, when the tree is
//! unavailable, a mouse-click fallback.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::nim::{self, ClickTarget};

/// How long to wait before a gentle spoken check-in. Never a hard timeout:
/// after checking in we keep waiting.
const CHECK_IN_AFTER: Duration = Duration::from_secs(50);
/// Tree poll cadence. Cheap: a UIA snapshot, no model call.
const POLL: Duration = Duration::from_millis(600);
/// A change must hold for this many consecutive polls before we trust it.
const STABLE_POLLS: u32 = 2;
/// After showing a step, ignore completion signals for this long so the
/// overlay's own hide/show and the previous click do not read as the next step
/// being finished.
const MIN_STEP_GAP: Duration = Duration::from_secs(3);
/// Settle time before a baseline snapshot, so transient focus shifts from the
/// overlay do not pollute the comparison.
const SETTLE: Duration = Duration::from_millis(1500);

#[derive(Debug, Clone, Serialize)]
pub struct GuideStep {
    /// "step" (next instruction), "confirmed" (gentle acknowledgement),
    /// "done", "checkin" (timeout nudge), or "error".
    pub kind: String,
    /// 1-based step number.
    pub step: u32,
    pub say: String,
    pub target: Option<ClickTarget>,
    /// monitor fractions of the capture, so the frontend can map the box.
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Default)]
pub struct GuideManager {
    active: Arc<AtomicBool>,
    task: Arc<Mutex<String>>,
    last_event: Arc<Mutex<Option<GuideStep>>>,
}

impl GuideManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Begin watching for completion of the step the frontend is already
    /// showing. `first_label` is the target the user was told to act on.
    pub fn start(
        &self,
        app: AppHandle,
        task: String,
        window_id: Option<u32>,
        first_label: Option<String>,
    ) {
        *self.task.lock().unwrap() = task.clone();
        self.active.store(true, Ordering::SeqCst);
        spawn(app, self.active.clone(), self.last_event.clone(), task, window_id, first_label);
    }

    pub fn stop(&self) {
        self.active.store(false, Ordering::SeqCst);
    }

    pub fn active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }

    /// Re-speak the most recent instruction (the "Repeat that" button).
    pub fn repeat(&self, app: &AppHandle) {
        if let Some(event) = self.last_event.lock().unwrap().clone() {
            let _ = app.emit("guide://step", event);
        }
    }
}

fn spawn(
    app: AppHandle,
    active: Arc<AtomicBool>,
    last_event: Arc<Mutex<Option<GuideStep>>>,
    task: String,
    window_id: Option<u32>,
    first_label: Option<String>,
) {
    std::thread::Builder::new()
        .name("pointy-guide".into())
        .spawn(move || {
            let mut step: u32 = 1;
            let mut watched_label = first_label;
            // Let focus settle into the target app before the baseline that
            // completion will be compared against, so the first click into the
            // app does not read as a finished step.
            let mut step_shown_at = Instant::now();
            std::thread::sleep(SETTLE);
            let mut baseline = crate::uia::snapshot(resolve_window(window_id));
            let mut stable = 0u32;
            let mut deadline = Instant::now() + CHECK_IN_AFTER;
            let mut held = false;

            loop {
                if !active.load(Ordering::SeqCst) {
                    break;
                }
                std::thread::sleep(POLL);

                let window = resolve_window(window_id);
                let now = crate::uia::snapshot(window);

                let completed = match (&baseline, &now) {
                    (Some(b), Some(n)) => step_completed(b, n, watched_label.as_deref()),
                    // No accessibility tree: fall back to a click in the target app.
                    _ => {
                        let down = left_button_down();
                        let clicked = down && !held;
                        held = down;
                        clicked
                    }
                };

                // A freshly shown step gets a quiet window so the overlay's
                // own hide/show and the previous click cannot read as the next
                // step being finished.
                let in_gap = step_shown_at.elapsed() < MIN_STEP_GAP;
                stable = if completed && !in_gap { stable + 1 } else { 0 };

                if stable < STABLE_POLLS {
                    if Instant::now() >= deadline {
                        deadline = Instant::now() + CHECK_IN_AFTER;
                        let event = GuideStep {
                            kind: "checkin".to_string(),
                            step,
                            say: "Take your time — let me know if you'd like me to show that again."
                                .to_string(),
                            target: None,
                            x: 0.0,
                            y: 0.0,
                            w: 1.0,
                            h: 1.0,
                        };
                        *last_event.lock().unwrap() = Some(event.clone());
                        let _ = app.emit("guide://step", event);
                    }
                    continue;
                }

                // Step finished. Acknowledge gently, then ask for the next step.
                stable = 0;
                let confirmed = GuideStep {
                    kind: "confirmed".to_string(),
                    step,
                    say: "Nice, that's done.".to_string(),
                    target: None,
                    x: 0.0,
                    y: 0.0,
                    w: 1.0,
                    h: 1.0,
                };
                *last_event.lock().unwrap() = Some(confirmed.clone());
                let _ = app.emit("guide://step", confirmed);

                let shot = match crate::overlay::snapshot_for_ask(&app, window) {
                    Ok(shot) => shot,
                    Err(_) => {
                        let event = GuideStep {
                            kind: "error".to_string(),
                            step,
                            say: "I couldn't see the screen just now. Let me know when to try again."
                                .to_string(),
                            target: None,
                            x: 0.0,
                            y: 0.0,
                            w: 1.0,
                            h: 1.0,
                        };
                        *last_event.lock().unwrap() = Some(event.clone());
                        let _ = app.emit("guide://step", event);
                        deadline = Instant::now() + CHECK_IN_AFTER;
                        baseline = crate::uia::snapshot(window);
                        continue;
                    }
                };

                let next = nim::next_step(
                    &task,
                    &shot.image,
                    step + 1,
                    Some((shot.width, shot.height)),
                );

                match next {
                    Ok(reply) if reply.status.eq_ignore_ascii_case("done") => {
                        let event = GuideStep {
                            kind: "done".to_string(),
                            step: step + 1,
                            say: if reply.say.trim().is_empty() {
                                "All done — you finished it.".to_string()
                            } else {
                                reply.say
                            },
                            target: None,
                            x: shot.x,
                            y: shot.y,
                            w: shot.w,
                            h: shot.h,
                        };
                        *last_event.lock().unwrap() = Some(event.clone());
                        let _ = app.emit("guide://step", event);
                        active.store(false, Ordering::SeqCst);
                        break;
                    }
                    Ok(reply) => {
                        step += 1;
                        watched_label = reply.target.as_ref().map(|t| t.label.clone());
                        let event = GuideStep {
                            kind: "step".to_string(),
                            step,
                            say: reply.say,
                            target: reply.target,
                            x: shot.x,
                            y: shot.y,
                            w: shot.w,
                            h: shot.h,
                        };
                        *last_event.lock().unwrap() = Some(event.clone());
                        let _ = app.emit("guide://step", event);
                        step_shown_at = Instant::now();
                        std::thread::sleep(SETTLE);
                        baseline = crate::uia::snapshot(window);
                        deadline = Instant::now() + CHECK_IN_AFTER;
                    }
                    Err(_) => {
                        let event = GuideStep {
                            kind: "error".to_string(),
                            step,
                            say: "I couldn't see the screen just now. Try that step again."
                                .to_string(),
                            target: None,
                            x: shot.x,
                            y: shot.y,
                            w: shot.w,
                            h: shot.h,
                        };
                        *last_event.lock().unwrap() = Some(event.clone());
                        let _ = app.emit("guide://step", event);
                        step_shown_at = Instant::now();
                        std::thread::sleep(SETTLE);
                        baseline = crate::uia::snapshot(window);
                        deadline = Instant::now() + CHECK_IN_AFTER;
                    }
                }
            }
        })
        .ok();
}

/// Use the window the user picked; when they said "this whole screen", follow
/// whichever window currently has focus.
#[cfg(windows)]
fn resolve_window(window_id: Option<u32>) -> Option<u32> {
    window_id.or_else(crate::uia::foreground_window)
}

#[cfg(not(windows))]
fn resolve_window(window_id: Option<u32>) -> Option<u32> {
    window_id
}

/// Decide whether the accessibility tree shows the user has moved on from the
/// current step. Local and heuristic on purpose — the next real look at the
/// screen is the model call that follows.
fn step_completed(
    baseline: &crate::uia::UiSnapshot,
    now: &crate::uia::UiSnapshot,
    watched_label: Option<&str>,
) -> bool {
    // 1. The page or view changed.
    if !baseline.title.is_empty() && !now.title.is_empty() && baseline.title != now.title {
        return true;
    }
    // 2. Focus landed somewhere new that is not the element we told them to use.
    if !now.focus.is_empty()
        && now.focus != baseline.focus
        && watched_label.map_or(true, |label| !labels_match(label, &now.focus))
    {
        return true;
    }
    // 3. A checkbox / radio / toggle flipped.
    if baseline.toggled != now.toggled {
        return true;
    }
    // 4. A large change in element count (a dialog opened, a view advanced).
    let b = baseline.count as f64;
    let n = now.count as f64;
    if b > 0.0 && n > 0.0 {
        let diff = (n - b).abs();
        if diff > 8.0 && diff / b > 0.25 {
            return true;
        }
    }
    false
}

fn labels_match(a: &str, b: &str) -> bool {
    let a = a.trim().to_lowercase();
    let b = b.trim().to_lowercase();
    if a.is_empty() || b.is_empty() {
        return false;
    }
    a == b || a.contains(b.as_str()) || b.contains(a.as_str())
}

#[cfg(windows)]
fn left_button_down() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    (unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) }) as u16 & 0x8000 != 0
}

#[cfg(not(windows))]
fn left_button_down() -> bool {
    false
}

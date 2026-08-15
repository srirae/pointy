//! Guided walkthrough — a patient, one-step-at-a-time guide.
//!
//! Triggered when a single query's answer says the task is multi-step. The
//! frontend shows the first step, then this module waits — *without polling the
//! screen or diffing pixels* — for the operating system to report that the
//! user did something:
//!
//! * focus moved, or
//! * the target window's accessibility tree changed, or
//! * a new window opened
//!
//! Those arrive from real UI Automation event subscriptions (`events.rs`). A
//! burst is debounced into one trigger, and only then does Pointy take a *single*
//! cheap accessibility snapshot to confirm the step really advanced (title
//! changed, focus landed on a new element, a toggle flipped, a dialog opened).
//! A bare focus bounce is not enough — this is what stopped the "that's done"
//! loop. Only a confirmed change captures a screenshot and streams the model's
//! next step, whose first sentence is spoken as soon as it arrives.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::nim::{self, ClickTarget};
use crate::uia::UiSnapshot;

/// How long to wait before a gentle spoken check-in. Never a hard timeout:
/// after checking in we keep waiting.
const CHECK_IN_AFTER: Duration = Duration::from_secs(50);
/// After showing a step, ignore events for this long so the overlay's own
/// hide/show and the previous click do not read as the next step being
/// finished, and so the baseline snapshot is taken against a settled tree.
const QUIET_WINDOW: Duration = Duration::from_secs(3);

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
    /// false on the refined step that arrives after the first sentence has
    /// already been spoken (streamed), so the frontend does not read the same
    /// instruction twice.
    pub speak: bool,
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
    _first_label: Option<String>,
) {
    std::thread::Builder::new()
        .name("pointy-guide".into())
        .spawn(move || {
            let mut step: u32 = 1;
            let mut held = false; // mouse-button edge for the no-UIA fallback

            loop {
                if !active.load(Ordering::SeqCst) {
                    break;
                }

                // A freshly shown step gets a quiet window so the overlay's own
                // hide/show and the previous click cannot read as the next step
                // being finished. Sleep in small slices so Stop is honored.
                let quiet_until = Instant::now() + QUIET_WINDOW;
                while Instant::now() < quiet_until {
                    if !active.load(Ordering::SeqCst) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                if !active.load(Ordering::SeqCst) {
                    break;
                }

                let window = resolve_window(window_id);

                // Block until the accessibility tree shows a *meaningful* change
                // (via event-triggered snapshots — no screen polling in here).
                let Some(t0) = wait_for_change(&app, &active, window, &last_event, step, &mut held)
                else {
                    if !active.load(Ordering::SeqCst) {
                        break;
                    }
                    // wait_for_change already emitted a check-in; keep waiting.
                    continue;
                };
                if !active.load(Ordering::SeqCst) {
                    break;
                }

                // Step finished. Acknowledge gently, then ask for the next step.
                let confirmed = GuideStep {
                    kind: "confirmed".to_string(),
                    step,
                    say: "Nice, that's done.".to_string(),
                    target: None,
                    x: 0.0,
                    y: 0.0,
                    w: 1.0,
                    h: 1.0,
                    speak: true,
                };
                *last_event.lock().unwrap() = Some(confirmed.clone());
                let _ = app.emit("guide://step", confirmed);

                // T1: fresh screenshot, cropped to the target window.
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
                            speak: true,
                        };
                        *last_event.lock().unwrap() = Some(event.clone());
                        let _ = app.emit("guide://step", event);
                        continue;
                    }
                };
                if !active.load(Ordering::SeqCst) {
                    break;
                }
                let t1 = crate::events::now_millis();

                // Stream the next step so the first complete sentence can be
                // spoken before the rest finishes generating (T6 < T4).
                let spoke_first = Arc::new(AtomicBool::new(false));
                let t6_ms: Arc<Mutex<Option<u128>>> = Arc::new(Mutex::new(None));
                let stream_app = app.clone();
                let stream_last = last_event.clone();
                let cb_spoke = spoke_first.clone();
                let cb_t6 = t6_ms.clone();
                let cb_active = active.clone();
                let stream_step = step + 1;
                let sx = shot.x;
                let sy = shot.y;
                let sw = shot.w;
                let sh = shot.h;
                let cb = move |sentence: &str| {
                    if !cb_active.load(Ordering::SeqCst) {
                        return;
                    }
                    spoke_first.store(true, Ordering::SeqCst);
                    *cb_t6.lock().unwrap() = Some(crate::events::now_millis());
                    let event = GuideStep {
                        kind: "step".to_string(),
                        step: stream_step,
                        say: sentence.to_string(),
                        target: None,
                        x: sx,
                        y: sy,
                        w: sw,
                        h: sh,
                        speak: true,
                    };
                    *stream_last.lock().unwrap() = Some(event.clone());
                    let _ = stream_app.emit("guide://step", event);
                };

                let streamed = nim::next_step_streaming(
                    &task,
                    &shot.image,
                    step + 1,
                    Some((shot.width, shot.height)),
                    &cb,
                );
                if !active.load(Ordering::SeqCst) {
                    break;
                }

                match streamed {
                    Ok((reply, timings)) if reply.status.eq_ignore_ascii_case("done") => {
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
                            speak: !cb_spoke.load(Ordering::SeqCst),
                        };
                        *last_event.lock().unwrap() = Some(event.clone());
                        let _ = app.emit("guide://step", event);
                        active.store(false, Ordering::SeqCst);
                        let t5 = crate::events::now_millis();
                        let t6 = t6_ms.lock().unwrap().unwrap_or(t5);
                        crate::events::log_latency(t0, t1, timings.t2, timings.t3, timings.t4, t5, t6);
                        break;
                    }
                    Ok((reply, timings)) => {
                        step += 1;
                        // Refine the model's box against the real accessibility
                        // tree (this logs the POSITION line) and mark T5.
                        let (target, _dot) = match (reply.target, window) {
                            (Some(target), Some(id)) => crate::uia::resolve(id, &shot, &target),
                            (target, _) => (target, None),
                        };
                        let t5 = crate::events::now_millis();
                        let event = GuideStep {
                            kind: "step".to_string(),
                            step,
                            say: reply.say,
                            target,
                            x: shot.x,
                            y: shot.y,
                            w: shot.w,
                            h: shot.h,
                            speak: !cb_spoke.load(Ordering::SeqCst),
                        };
                        *last_event.lock().unwrap() = Some(event.clone());
                        let _ = app.emit("guide://step", event);
                        let t6 = t6_ms.lock().unwrap().unwrap_or(t5);
                        crate::events::log_latency(t0, t1, timings.t2, timings.t3, timings.t4, t5, t6);
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
                            speak: true,
                        };
                        *last_event.lock().unwrap() = Some(event.clone());
                        let _ = app.emit("guide://step", event);
                    }
                }
            }
        })
        .ok();
}

/// Wait until the operating system reports a change AND a cheap accessibility
/// snapshot confirms the step really advanced. Returns the event timestamp when
/// confirmed; emits a gentle check-in (and keeps waiting) on timeout.
fn wait_for_change(
    app: &AppHandle,
    active: &AtomicBool,
    window: Option<u32>,
    last_event: &Arc<Mutex<Option<GuideStep>>>,
    step: u32,
    held: &mut bool,
) -> Option<u128> {
    let (tx, rx) = mpsc::channel::<crate::events::EventKind>();
    let listener = crate::events::listen(window, Arc::new(move |kind| {
        let _ = tx.send(kind);
    }));

    match listener {
        Ok(listener) => {
            // Baseline for this step: what the tree looked like once settled.
            let mut baseline = crate::uia::snapshot(window);
            let mut deadline = Instant::now() + CHECK_IN_AFTER;
            loop {
                // Slice the wait so a Stop is noticed within ~250ms instead of
                // after the whole 50s check-in window.
                match rx.recv_timeout(Duration::from_millis(250)) {
                    Ok(kind) => {
                        // Focus moving around is expected noise, not a finished
                        // step — only a structure change or a new window is worth
                        // a look at the tree.
                        if kind != crate::events::EventKind::StructureChanged
                            && kind != crate::events::EventKind::WindowOpened
                        {
                            deadline = Instant::now() + CHECK_IN_AFTER;
                            continue;
                        }
                        // Confirm against the tree (no AI call, no screenshot).
                        let now = crate::uia::snapshot(window);
                        let confirmed = match (&baseline, &now) {
                            (Some(b), Some(n)) => step_completed(b, n),
                            // No tree at all: fall back to a real click.
                            _ => {
                                let down = left_button_down();
                                let clicked = down && !*held;
                                *held = down;
                                clicked
                            }
                        };
                        if confirmed {
                            let t0 = crate::events::now_millis();
                            listener.stop();
                            return Some(t0);
                        }
                        // Not a real change yet: remember this state so small
                        // changes cannot accumulate into a false positive.
                        baseline = now;
                        deadline = Instant::now() + CHECK_IN_AFTER;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if !active.load(Ordering::SeqCst) {
                            listener.stop();
                            return None;
                        }
                        if Instant::now() < deadline {
                            continue;
                        }
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
                            speak: true,
                        };
                        *last_event.lock().unwrap() = Some(event.clone());
                        let _ = app.emit("guide://step", event);
                        deadline = Instant::now() + CHECK_IN_AFTER;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        listener.stop();
                        return None;
                    }
                }
            }
        }
        Err(_) => {
            // No accessibility events available (rare): fall back to watching
            // for a left-click in the target app. This is not a screen poll.
            let mut deadline = Instant::now() + CHECK_IN_AFTER;
            loop {
                std::thread::sleep(Duration::from_millis(150));
                if !active.load(Ordering::SeqCst) {
                    return None;
                }
                let down = left_button_down();
                let clicked = down && !*held;
                *held = down;
                if clicked {
                    return Some(crate::events::now_millis());
                }
                if Instant::now() >= deadline {
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
                        speak: true,
                    };
                    *last_event.lock().unwrap() = Some(event.clone());
                    let _ = app.emit("guide://step", event);
                    deadline = Instant::now() + CHECK_IN_AFTER;
                }
            }
        }
    }
}

/// Decide whether the tree shows the user moved on from the current step.
/// Local and heuristic on purpose — the next real look at the screen is the
/// model call that follows.
fn step_completed(baseline: &UiSnapshot, now: &UiSnapshot) -> bool {
    // 1. The page or view changed.
    if !baseline.title.is_empty() && !now.title.is_empty() && baseline.title != now.title {
        return true;
    }
    // 2. A checkbox / radio / toggle flipped.
    if baseline.toggled != now.toggled {
        return true;
    }
    // 3. A large change in element count (a dialog opened, a view advanced).
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

#[cfg(windows)]
fn left_button_down() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    (unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) }) as u16 & 0x8000 != 0
}

#[cfg(not(windows))]
fn left_button_down() -> bool {
    false
}

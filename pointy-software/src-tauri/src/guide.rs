//! Guided walkthrough — a patient, one-step-at-a-time guide.
//!
//! Triggered when a single query's answer says the task is multi-step. The
//! frontend shows the first step, then this module waits — *without polling the
//! screen or diffing pixels* — for the operating system to report that the
//! user did something:
//!
//! * a click lands inside the resolved target, or
//! * a new window opens and its accessibility tree changes meaningfully
//!
//! UI Automation subscriptions (`events.rs`) provide the window-change signal,
//! while the target click is verified locally against the physical UIA rect.
//! Focus and generic redraws are deliberately ignored. Only a confirmed signal
//! captures a screenshot and streams the model's next step, whose first
//! sentence is spoken as soon as it arrives.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::nim::{self, ClickTarget};
use crate::task_state::{GuideAction, GateDecision, StepContract, TrustDiagnostic, TrustLayer};
use crate::uia::{DotPoint, UiSnapshot};

/// How long to wait before a gentle spoken check-in. Never a hard timeout:
/// after checking in we keep waiting.
const CHECK_IN_AFTER: Duration = Duration::from_secs(50);
/// After showing a step, ignore events for this long so the overlay's own
/// hide/show and the previous click do not read as the next step being
/// finished, and so the baseline snapshot is taken against a settled tree.
// The completion gate below is target-click based, so we only need a short
// settle period for Pointy's hide/show. Three seconds made every step feel
// sluggish and could make a real early click get lost.
const QUIET_WINDOW: Duration = Duration::from_millis(600);

#[derive(Debug, Clone, Serialize)]
pub struct GuideStep {
    /// "step" (next instruction), "confirmed" (gentle acknowledgement),
    /// "done", "checkin" (timeout nudge), or "error".
    pub kind: String,
    /// 1-based step number.
    pub step: u32,
    pub say: String,
    pub target: Option<ClickTarget>,
    /// Exact physical point resolved from the accessibility tree, when the
    /// model's label matched a real control. The frontend draws the dot here,
    /// and the misclick watcher guards it.
    pub dot: Option<DotPoint>,
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
        first_action: Option<String>,
        first_confidence: Option<f64>,
    ) {
        *self.task.lock().unwrap() = task.clone();
        self.active.store(true, Ordering::SeqCst);
        spawn(
            app,
            self.active.clone(),
            self.last_event.clone(),
            task,
            window_id,
            first_label,
            first_action.unwrap_or_else(|| "unknown".to_string()),
            first_confidence.unwrap_or(0.0),
        );
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
    first_action: String,
    first_confidence: f64,
) {
    std::thread::Builder::new()
        .name("pointy-guide".into())
        .spawn(move || {
            let mut step: u32 = 1;
            let mut held = false; // mouse-button edge for the no-UIA fallback
            let mut current_action = first_action;
            let mut current_confidence = first_confidence;
            let mut trust = TrustLayer::default();

            // Step 1's target is the element the single query already named;
            // resolve its real physical rect once so the misclick watcher can
            // guard it from the very first step.
            let mut current_dot: Option<DotPoint> =
                match (&first_label, resolve_window(window_id)) {
                    (Some(label), Some(id)) => crate::uia::point_for_label(id, label),
                    _ => None,
                };

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

                // Local misclick prevention for this step: watch the cursor for
                // dwell on a nearby wrong control. Runs only while this step is
                // active, and is stopped the moment the step is confirmed.
                let watcher = match (&current_dot, window) {
                    (Some(dot), Some(id)) => {
                        Some(crate::misclick::start(app.clone(), id, dot.clone()))
                    }
                    _ => None,
                };

                // Block until the accessibility tree shows a *meaningful* change
                // (via event-triggered snapshots — no screen polling in here).
                let contract = StepContract {
                    step,
                    action: GuideAction::parse(&current_action),
                    label: current_dot
                        .as_ref()
                        .map(|dot| dot.label.clone())
                        .or_else(|| first_label.clone())
                        .unwrap_or_default(),
                    confidence: current_confidence,
                };
                emit_trust(&app, trust.begin(contract));

                let outcome = wait_for_change(
                    &app,
                    &active,
                    window,
                    current_dot.as_ref(),
                    &mut trust,
                    &last_event,
                    step,
                    &mut held,
                );
                if let Some(watcher) = &watcher {
                    watcher.stop();
                }
                let Some(t0) = outcome else {
                    if !active.load(Ordering::SeqCst) {
                        break;
                    }
                    // wait_for_change already emitted a check-in; keep waiting.
                    continue;
                };
                if !active.load(Ordering::SeqCst) {
                    break;
                }

                // Step finished. Go straight to the next instruction. We used
                // to emit a spoken "Nice, that's done" event here; a false
                // accessibility event could therefore make the user hear it
                // repeatedly. The next model instruction is the only progress
                // message now.

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
                            dot: None,
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
                        // Speech-only event: the webview keeps the current
                        // target/dot visible while the rest of the JSON streams.
                        kind: "speech".to_string(),
                        step: stream_step,
                        say: sentence.to_string(),
                        target: None,
                        dot: None,
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
                            dot: None,
                            x: shot.x,
                            y: shot.y,
                            w: shot.w,
                            h: shot.h,
                            speak: !cb_spoke.load(Ordering::SeqCst),
                        };
                        *last_event.lock().unwrap() = Some(event.clone());
                        let _ = app.emit("guide://step", event);
                        emit_trust(&app, trust.complete());
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
                        let (target, dot) = match (reply.target, window) {
                            (Some(target), Some(id)) => crate::uia::resolve(id, &shot, &target),
                            (target, _) => (target, None),
                        };
                        current_dot = dot.clone();
                        current_action = reply.action;
                        current_confidence = reply.confidence;
                        let t5 = crate::events::now_millis();
                        let event = GuideStep {
                            kind: "step".to_string(),
                            step,
                            say: reply.say,
                            target,
                            dot,
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
                            dot: None,
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

/// Wait until a local target click or a meaningful new-window accessibility
/// change verifies the step. Returns the confirmation timestamp; emits a gentle
/// check-in (and keeps waiting) on timeout.
fn wait_for_change(
    app: &AppHandle,
    active: &AtomicBool,
    window: Option<u32>,
    target: Option<&DotPoint>,
    trust: &mut TrustLayer,
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
            // A target click is verified directly and needs no expensive tree
            // snapshot. Only targetless recovery/open-window steps need a
            // baseline for the meaningful-window-change fallback.
            let baseline = target.is_none().then(|| crate::uia::snapshot(window));
            let mut deadline = Instant::now() + CHECK_IN_AFTER;
            let mut previous_down = false;
            loop {
                // A click inside the exact accessibility-resolved target is the
                // strongest local completion signal. Handle it immediately —
                // many native buttons emit focus only, not a structure event.
                // This remains fully local and avoids waiting for a redraw that
                // may never arrive.
                let down = left_button_down();
                if down && !previous_down {
                    if let (Some(dot), Some((x, y))) = (target, cursor_screen()) {
                        if cursor_in_dot(x, y, dot) {
                            let (decision, diagnostic) = trust.target_clicked();
                            if let Some(diagnostic) = diagnostic {
                                emit_trust(app, diagnostic);
                            }
                            if decision == GateDecision::Advance {
                                listener.stop();
                                return Some(crate::events::now_millis());
                            }
                        }
                    }
                }
                previous_down = down;

                // Slice the wait so Stop is noticed quickly.
                match rx.recv_timeout(Duration::from_millis(25)) {
                    Ok(kind) => {
                        // Focus moving around and generic structure redraws are
                        // expected noise, not finished steps. Target clicks were
                        // handled immediately above; only a meaningful new
                        // window is considered here.
                        if kind == crate::events::EventKind::FocusChanged {
                            deadline = Instant::now() + CHECK_IN_AFTER;
                            continue;
                        }
                        let confirmed = if kind == crate::events::EventKind::WindowOpened {
                            // A dialog/window opening is a valid completion only
                            // when the tree confirms a meaningful change.
                            let now = crate::uia::snapshot(window);
                            let meaningful = match (baseline.as_ref().and_then(Option::as_ref), &now) {
                                (Some(b), Some(n)) => step_completed(b, n),
                                _ => false,
                            };
                            if meaningful {
                                let (decision, diagnostic) = trust.meaningful_window_change();
                                if let Some(diagnostic) = diagnostic {
                                    emit_trust(&app, diagnostic);
                                }
                                decision == GateDecision::Advance
                            } else {
                                false
                            }
                        } else {
                            false
                        };
                        *held = down;
                        if confirmed {
                            let t0 = crate::events::now_millis();
                            listener.stop();
                            return Some(t0);
                        }
                        // No target click / meaningful dialog change: keep the
                        // original settled baseline. Tiny redraws must never
                        // accumulate into a completion.
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
                        emit_trust(&app, trust.check_in());
                        let event = GuideStep {
                            kind: "checkin".to_string(),
                            step,
                            say: "Take your time — let me know if you'd like me to show that again."
                                .to_string(),
                            target: None,
                            dot: None,
                            x: 0.0,
                            y: 0.0,
                            w: 1.0,
                            h: 1.0,
                            speak: true,
                        };
                        *last_event.lock().unwrap() = Some(event.clone());
                        let _ = app.emit("guide://step", event);
                        emit_trust(&app, trust.resume_after_check_in());
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
                    let inside_target = target
                        .and_then(|dot| cursor_screen().map(|(x, y)| cursor_in_dot(x, y, dot)))
                        .unwrap_or(false);
                    if inside_target {
                        let (decision, diagnostic) = trust.target_clicked();
                        if let Some(diagnostic) = diagnostic {
                            emit_trust(app, diagnostic);
                        }
                        if decision == GateDecision::Advance {
                            return Some(crate::events::now_millis());
                        }
                    }
                }
                if Instant::now() >= deadline {
                    let event = GuideStep {
                        kind: "checkin".to_string(),
                        step,
                        say: "Take your time — let me know if you'd like me to show that again."
                            .to_string(),
                        target: None,
                        dot: None,
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
fn emit_trust(app: &AppHandle, diagnostic: TrustDiagnostic) {
    eprintln!(
        "TRUST: step={} phase={:?} reason={} action={:?} confidence={:.2}",
        diagnostic.step,
        diagnostic.phase,
        diagnostic.reason,
        diagnostic.action,
        diagnostic.confidence,
    );
    let _ = app.emit("guide://diagnostic", diagnostic);
}

fn step_completed(baseline: &UiSnapshot, now: &UiSnapshot) -> bool {
    // Do not use the top-level title as completion evidence. Browser titles
    // change for unread counts, timers, redirects, and tab redraws without the
    // user completing Pointy's highlighted action.
    // 1. A checkbox / radio / toggle flipped.
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

#[cfg(windows)]
fn cursor_screen() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut point = POINT::default();
    unsafe { GetCursorPos(&mut point) }.ok()?;
    Some((point.x, point.y))
}

#[cfg(not(windows))]
fn cursor_screen() -> Option<(i32, i32)> {
    None
}

fn cursor_in_dot(x: i32, y: i32, dot: &DotPoint) -> bool {
    x >= dot.raw_x
        && x < dot.raw_x + dot.raw_w
        && y >= dot.raw_y
        && y < dot.raw_y + dot.raw_h
}

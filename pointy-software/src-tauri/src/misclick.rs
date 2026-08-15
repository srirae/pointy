//! Local real-time misclick prevention, layered on the dot-pointing system.
//!
//! Once a guided step has a resolved target, a short-lived watcher thread reads
//! the OS cursor position (~125Hz) and watches a handful of "confusion zones" —
//! nearby interactive controls gathered from the accessibility tree
//! (`uia::confusion_zones`). Nothing in the reactive loop touches the network
//! or an AI model:
//!
//! * the warning audio is pre-cached once (`tts::warm_warning`) and played with
//!   `PlaySoundW` + `SND_ASYNC`, which starts in microseconds, and
//! * the correct target's dot is brightened through a `guide://warn` event.
//!
//! A warning fires only when the cursor has (a) newly entered a confusion zone,
//! (b) dwelled there continuously past ~200ms, and (c) slowed to a fraction of
//! its approach speed — so a fast pass-through or a brief graze never warns,
//! and a cursor that was already parked on the zone when the step began does
//! not either. Each zone has a 2.5s cooldown, and moving onto the real target
//! cancels all pending state immediately.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::uia::{DotPoint, Zone};

/// Sample the cursor this often. 8ms ≈ 125Hz keeps the dwell/velocity reaction
/// in the single-digit-millisecond range without spinning a core.
const POLL: Duration = Duration::from_millis(8);
/// Minimum continuous dwell inside a zone before a warning can fire (spec: 150–250ms).
const DWELL_MIN: Duration = Duration::from_millis(200);
/// Once warned, a zone stays quiet this long so lingering does not spam.
const COOLDOWN: Duration = Duration::from_millis(2500);
/// Current speed must drop to this fraction of the approach speed to count as
/// "about to click" rather than passing through.
const VEL_DROP: f64 = 0.45;
/// Confusion radius around the target's box, physical pixels.
const RADIUS_PX: i32 = 240;
/// Maximum nearby controls to guard.
const MAX_ZONES: usize = 6;
/// Speed samples kept to smooth jitter (8ms apart → ~a quarter second).
const SAMPLE_WINDOW: usize = 32;

/// Payload of the `guide://warn` event: which zone was entered and what was
/// said, so the frontend can brighten the correct dot.
#[derive(Debug, Clone, Serialize)]
pub struct WarnPayload {
    pub zone: String,
    pub say: String,
}

/// Handle to a running watcher. Dropping it (or calling `stop`) ends the cursor
/// watch, so nothing runs between steps.
pub struct Watcher {
    stop: Arc<AtomicBool>,
    _thread: Option<std::thread::JoinHandle<()>>,
}

impl Watcher {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// Start watching the cursor for misclicks against `target`. Runs only until
/// `stop()`/drop — never idle between steps.
pub fn start(app: AppHandle, window_id: u32, target: DotPoint) -> Watcher {
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let thread = std::thread::Builder::new()
        .name("pointy-misclick".into())
        .spawn(move || run(app, window_id, target, thread_stop))
        .ok();
    Watcher {
        stop,
        _thread: thread,
    }
}

fn run(app: AppHandle, window_id: u32, target: DotPoint, stop: Arc<AtomicBool>) {
    // Setup phase (not the reactive loop): synthesize the warning once and
    // gather the nearby interactive controls from the accessibility tree.
    crate::tts::warm_warning();
    let zones = crate::uia::confusion_zones(window_id, &target, RADIUS_PX, MAX_ZONES);
    if zones.is_empty() {
        return; // nothing plausible to confuse — nothing to guard
    }

    let mut core = WatcherCore::new(target, zones);
    while !stop.load(Ordering::SeqCst) {
        let Some((x, y)) = cursor() else {
            std::thread::sleep(POLL);
            continue;
        };
        if let Some(warning) = core.on_cursor(x, y, Instant::now()) {
            let zone = &core.zones[warning.zone];
            trigger(&app, zone, warning.dwell, warning.approach, warning.current);
        }
        std::thread::sleep(POLL);
    }
}

/// The decision engine, kept free of OS/audio/emitter calls so it can be driven
/// deterministically in tests with synthetic cursor trajectories.
struct WatcherCore {
    target: DotPoint,
    zones: Vec<Zone>,
    states: Vec<ZoneState>,
    samples: VecDeque<Sample>,
    initialized: bool,
}

struct Warning {
    zone: usize,
    dwell: Duration,
    approach: f64,
    current: f64,
}

impl WatcherCore {
    fn new(target: DotPoint, zones: Vec<Zone>) -> Self {
        let states = zones.iter().map(|_| ZoneState::new()).collect();
        Self {
            target,
            zones,
            states,
            samples: VecDeque::with_capacity(SAMPLE_WINDOW),
            initialized: false,
        }
    }

    /// Feed one cursor sample and return the warning to emit, if the trigger
    /// conditions just became true.
    fn on_cursor(&mut self, x: f64, y: f64, now: Instant) -> Option<Warning> {
        self.samples.push_back(Sample { x, y, t: now });
        if self.samples.len() > SAMPLE_WINDOW {
            self.samples.pop_front();
        }

        // First sample only establishes where the cursor *already* is, so a
        // cursor parked on a wrong button when the step begins never warns.
        if !self.initialized {
            for (state, zone) in self.states.iter_mut().zip(&self.zones) {
                state.inside = point_in_rect(x, y, zone.raw_x, zone.raw_y, zone.raw_w, zone.raw_h);
                state.entered_at = None;
            }
            self.initialized = true;
            return None;
        }

        // Cursor on the real target: cancel every pending warning immediately.
        if point_in_rect(x, y, self.target.raw_x, self.target.raw_y, self.target.raw_w, self.target.raw_h)
        {
            let mut cancelled = false;
            for state in &mut self.states {
                if state.inside || state.entered_at.is_some() {
                    *state = ZoneState::new();
                    cancelled = true;
                }
            }
            if cancelled {
                crate::tts::stop_warning();
            }
            return None;
        }

        for (i, (state, zone)) in self.states.iter_mut().zip(&self.zones).enumerate() {
            let inside = point_in_rect(x, y, zone.raw_x, zone.raw_y, zone.raw_w, zone.raw_h);
            if inside && !state.inside {
                // Fresh entry: snapshot the approach speed from the movement
                // that brought the cursor here, and start the dwell clock.
                state.inside = true;
                state.entered_at = Some(now);
                state.approach_speed = speed_over(&self.samples, 6);
            } else if !inside && state.inside {
                state.inside = false;
                state.entered_at = None;
            }

            if let Some(entered) = state.entered_at {
                let dwell = now.duration_since(entered);
                let current = speed_over(&self.samples, 6);
                if dwell >= DWELL_MIN && now >= state.cooldown_until && should_warn(dwell, state.approach_speed, current) {
                    state.cooldown_until = now + COOLDOWN;
                    // Stop the dwell clock so continued lingering cannot re-fire;
                    // only a fresh leave-then-re-enter (or the cooldown elapsing
                    // across a new approach) can warn again for this zone.
                    state.entered_at = None;
                    return Some(Warning {
                        zone: i,
                        dwell,
                        approach: state.approach_speed,
                        current,
                    });
                }
            }
        }
        None
    }
}

fn trigger(app: &AppHandle, zone: &Zone, dwell: Duration, approach: f64, current: f64) {
    let t0 = Instant::now();
    let _ = crate::tts::play_warning();
    let audio_ms = t0.elapsed().as_millis();
    let _ = app.emit(
        "guide://warn",
        WarnPayload {
            zone: zone.label.clone(),
            say: crate::tts::WARNING_TEXT.to_string(),
        },
    );
    eprintln!(
        "MISCLICK: zone={:?} dwell_ms={} approach_px_s={:.0} current_px_s={:.0} velocity_drop={:.2} trigger_to_audio_ms={}",
        zone.label,
        dwell.as_millis(),
        approach,
        current,
        (approach - current) / approach.max(1.0),
        audio_ms,
    );
}

/// The trigger rule, extracted for deterministic testing.
fn should_warn(dwell: Duration, approach_px_s: f64, current_px_s: f64) -> bool {
    if dwell < DWELL_MIN {
        return false;
    }
    // Dropped noticeably from approach speed, or both essentially stationary
    // (a slow drift-in that has come to rest is just as likely a click).
    let dropped = current_px_s < approach_px_s * VEL_DROP
        || (approach_px_s < 30.0 && current_px_s < 30.0);
    dropped
}

fn point_in_rect(x: f64, y: f64, rx: i32, ry: i32, rw: i32, rh: i32) -> bool {
    x >= rx as f64 && x < (rx + rw) as f64 && y >= ry as f64 && y < (ry + rh) as f64
}

#[derive(Clone, Copy)]
struct Sample {
    x: f64,
    y: f64,
    t: Instant,
}

struct ZoneState {
    inside: bool,
    /// None when the cursor was already inside when the watch began.
    entered_at: Option<Instant>,
    approach_speed: f64,
    cooldown_until: Instant,
}

impl ZoneState {
    fn new() -> Self {
        Self {
            inside: false,
            entered_at: None,
            approach_speed: 0.0,
            cooldown_until: Instant::now(),
        }
    }
}

/// Average speed (physical px per second) over the last `segments` movement
/// deltas in the sample history.
fn speed_over(samples: &VecDeque<Sample>, segments: usize) -> f64 {
    let n = samples.len();
    if n < 2 {
        return 0.0;
    }
    let start = n.saturating_sub(segments + 1);
    let mut dist = 0.0f64;
    let mut dt = 0.0f64;
    for i in start..n - 1 {
        let a = samples[i];
        let b = samples[i + 1];
        dist += ((b.x - a.x).powi(2) + (b.y - a.y).powi(2)).sqrt();
        dt += (b.t - a.t).as_secs_f64();
    }
    if dt <= 0.0 {
        0.0
    } else {
        dist / dt
    }
}

#[cfg(windows)]
fn cursor() -> Option<(f64, f64)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut point = POINT::default();
    unsafe { GetCursorPos(&mut point) }.ok()?;
    Some((point.x as f64, point.y as f64))
}

#[cfg(not(windows))]
fn cursor() -> Option<(f64, f64)> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zone(label: &str, x: i32, w: i32) -> Zone {
        Zone {
            label: label.to_string(),
            raw_x: x,
            raw_y: 0,
            raw_w: w,
            raw_h: 20,
        }
    }

    fn core() -> WatcherCore {
        // One confusion zone on the left, the real target on the right.
        WatcherCore::new(
            DotPoint {
                label: "Send".into(),
                raw_x: 300,
                raw_y: 0,
                raw_w: 20,
                raw_h: 20,
                dpi_scale: 1.0,
                dot_x: 310,
                dot_y: 10,
                fx: 0.0,
                fy: 0.0,
                fw: 0.0,
                fh: 0.0,
                cx: 0.0,
                cy: 0.0,
            },
            vec![zone("Delete", 100, 20)],
        )
    }

    #[test]
    fn brief_dwell_never_warns() {
        assert!(!should_warn(Duration::from_millis(120), 400.0, 20.0));
        assert!(!should_warn(Duration::from_millis(199), 400.0, 20.0));
    }

    #[test]
    fn slow_after_fast_approach_warns() {
        assert!(should_warn(Duration::from_millis(220), 400.0, 80.0));
    }

    #[test]
    fn fast_pass_through_does_not_warn() {
        assert!(!should_warn(Duration::from_millis(300), 400.0, 350.0));
    }

    #[test]
    fn slow_drift_that_stops_warns() {
        assert!(should_warn(Duration::from_millis(250), 20.0, 5.0));
    }

    #[test]
    fn rect_hit_testing() {
        assert!(point_in_rect(10.0, 10.0, 0, 0, 20, 20));
        assert!(!point_in_rect(20.0, 10.0, 0, 0, 20, 20));
        assert!(!point_in_rect(-1.0, 10.0, 0, 0, 20, 20));
    }

    #[test]
    fn speed_is_physical_px_per_second() {
        let base = Instant::now();
        let mut samples = VecDeque::new();
        samples.push_back(Sample { x: 0.0, y: 0.0, t: base });
        samples.push_back(Sample { x: 100.0, y: 0.0, t: base + Duration::from_millis(500) });
        let speed = speed_over(&samples, 1);
        assert!((speed - 200.0).abs() < 5.0, "speed was {speed}");
    }

    /// Fast cursor sweeps straight across the confusion zone: it should not warn.
    #[test]
    fn fast_sweep_across_zone_does_not_warn() {
        let mut core = core();
        let base = Instant::now();
        // x goes 0 → 160 in 40ms steps (625 px/s), crossing the zone at [100,120).
        for (i, x) in [0.0, 25.0, 50.0, 75.0, 100.0, 125.0, 150.0].iter().enumerate() {
            let warning = core.on_cursor(*x, 10.0, base + Duration::from_millis(40 * i as u64));
            assert!(warning.is_none(), "sweep warned at step {i}");
        }
    }

    /// Fast approach into the zone, then a stop: warns once, with the right
    /// zone and a dwell past the threshold.
    #[test]
    fn approach_then_stop_in_zone_warns() {
        let mut core = core();
        let base = Instant::now();

        // Approach at ~625 px/s from the left.
        for (i, x) in [0.0, 25.0, 50.0, 75.0].iter().enumerate() {
            assert!(core
                .on_cursor(*x, 10.0, base + Duration::from_millis(40 * i as u64))
                .is_none());
        }

        // Enter the zone and stop, holding at 110 for well past DWELL_MIN.
        let mut fired: Option<Warning> = None;
        for i in 0..40 {
            let now = base + Duration::from_millis(160 + 10 * i as u64);
            if let Some(w) = core.on_cursor(110.0, 10.0, now) {
                fired = Some(w);
                break;
            }
        }

        let warning = fired.expect("a warning should fire after dwelling in the zone");
        assert_eq!(warning.zone, 0);
        assert!(warning.dwell >= DWELL_MIN);
        assert!(warning.approach > 100.0, "approach speed {:.0} too low", warning.approach);
        assert!(warning.current < warning.approach * 0.5);
    }

    /// After a warning, lingering in the same zone must not re-fire immediately.
    #[test]
    fn cooldown_suppresses_lingering() {
        let mut core = core();
        let base = Instant::now();
        for (i, x) in [0.0, 25.0, 50.0, 75.0].iter().enumerate() {
            let _ = core.on_cursor(*x, 10.0, base + Duration::from_millis(40 * i as u64));
        }

        let mut fired = 0;
        for i in 0..400 {
            // Stay parked in the zone for 4s; only the first hit counts.
            if core
                .on_cursor(110.0, 10.0, base + Duration::from_millis(160 + 10 * i as u64))
                .is_some()
            {
                fired += 1;
            }
        }
        assert_eq!(fired, 1, "lingering should warn exactly once within the cooldown");
    }

    /// Moving onto the real target cancels pending state, so re-entering the
    /// zone starts a fresh dwell (no instant re-warn).
    #[test]
    fn target_entry_cancels_pending_state() {
        let mut core = core();
        let base = Instant::now();

        // Enter the zone briefly (not long enough to warn), then leave to the target.
        for (i, x) in [0.0, 25.0, 50.0, 75.0, 100.0].iter().enumerate() {
            let _ = core.on_cursor(*x, 10.0, base + Duration::from_millis(40 * i as u64));
        }
        let _ = core.on_cursor(310.0, 10.0, base + Duration::from_millis(200)); // on target

        // Re-enter the zone and hold — it should still require the full dwell.
        let mut fired_at: Option<Instant> = None;
        for i in 0..30 {
            let now = base + Duration::from_millis(240 + 10 * i as u64);
            if core.on_cursor(110.0, 10.0, now).is_some() {
                fired_at = Some(now);
                break;
            }
        }
        let fired = fired_at.expect("re-entry should warn after a fresh full dwell");
        // Not within the first ~190ms of re-entry (the old dwell was cancelled).
        assert!(fired.duration_since(base + Duration::from_millis(240)) >= Duration::from_millis(190));
    }
}

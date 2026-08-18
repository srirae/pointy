//! Pointy — Tauri backend.
//!
//! This pass covers the onboarding pipeline plumbing only, but each piece is the real
//! foundation the later phases build on:
//!
//! * `audio`       — live mic capture and band levels for the input visualiser.
//! * `hotkey`      — one global keyboard hook, used both to record a combo and to emit
//!                   the push-to-talk down/up edges Phase 1 activation needs.
//! * `overlay`     — the push-to-talk pill window, shown on the hotkey down edge.
//! * `permissions` — real OS state for mic, screen capture and accessibility.
//! * `settings`    — persisted hotkey / device / onboarding state.

mod audio;
mod capture;
mod clickwatch;
mod events;
mod guide;
mod hotkey;
mod keyboard;
mod keys;
mod misclick;
mod models;
mod nim;
mod overlay;
mod permissions;
mod settings;
mod task_state;
mod tts;
mod uia;
mod usage;

use audio::{AudioDevice, AudioManager};
use capture::WakeStore;
use guide::GuideManager;
use hotkey::{Combo, HotkeyManager, Validation};
use permissions::{Capability, PermissionStatus};
use settings::Settings;
use tauri::{AppHandle, Emitter, Manager, State};
use usage::UsageTracker;
use tauri_plugin_global_shortcut::{ShortcutState, Builder as ShortcutBuilder};
use base64::Engine;

pub(crate) struct Pointy {
    pub(crate) hotkey: HotkeyManager,
    pub(crate) audio: AudioManager,
    pub(crate) wake: WakeStore,
    pub(crate) usage: UsageTracker,
    pub(crate) guide: GuideManager,
}

// ---------------------------------------------------------------- permissions

#[tauri::command]
fn permissions_status() -> Vec<PermissionStatus> {
    permissions::status_all()
}

#[tauri::command]
fn permissions_request(id: String) -> Result<PermissionStatus, String> {
    let capability = Capability::parse(&id).ok_or_else(|| format!("Unknown permission: {id}"))?;
    Ok(permissions::request(capability))
}

#[tauri::command]
fn permissions_open_settings(id: String) -> Result<(), String> {
    let capability = Capability::parse(&id).ok_or_else(|| format!("Unknown permission: {id}"))?;
    permissions::open_settings(capability)
}

// ---------------------------------------------------------------------- audio

#[tauri::command]
fn audio_input_devices() -> Result<Vec<AudioDevice>, String> {
    audio::input_devices()
}

/// Start emitting `mic://level`. Returns the name of the device actually opened.
#[tauri::command]
fn audio_start_levels(
    app: AppHandle,
    state: State<'_, Pointy>,
    device: Option<String>,
) -> Result<String, String> {
    let opened = state.audio.start_levels(app.clone(), device)?;
    let chosen = opened.clone();
    settings::update(&app, |settings| settings.input_device = Some(chosen))?;
    Ok(opened)
}

#[tauri::command]
fn audio_stop_levels(state: State<'_, Pointy>) {
    state.audio.stop_levels();
}

#[tauri::command]
fn audio_current_device(state: State<'_, Pointy>) -> Option<String> {
    state.audio.current_device()
}

// --------------------------------------------------------------------- hotkey

/// Enter capture mode. The UI gets `hotkey://capture-progress` as keys go down and
/// `hotkey://capture-complete` when the user lets go.
#[tauri::command]
fn hotkey_start_capture(state: State<'_, Pointy>) {
    state.hotkey.start_capture();
}

#[tauri::command]
fn hotkey_stop_capture(state: State<'_, Pointy>) {
    state.hotkey.stop_capture();
}

#[tauri::command]
fn hotkey_validate(keys: Vec<String>) -> Validation {
    hotkey::validate(keys)
}

/// Validate, persist and arm a combo. Once armed, holding it emits `hotkey://down`
/// and releasing emits `hotkey://up`.
#[tauri::command]
fn hotkey_save(
    app: AppHandle,
    state: State<'_, Pointy>,
    keys: Vec<String>,
) -> Result<Combo, String> {
    let validation = hotkey::validate(keys);
    if !validation.valid {
        return Err(validation
            .reason
            .unwrap_or_else(|| "That combo cannot be used.".to_string()));
    }

    let combo = validation.combo;
    let stored = combo.clone();
    settings::update(&app, |settings| settings.hotkey = Some(stored))?;
    state.hotkey.arm(combo.clone());
    hotkey::register_os_shortcut(&app, &combo);
    overlay::set_enabled(&app, true);
    Ok(combo)
}

#[tauri::command]
fn hotkey_current(state: State<'_, Pointy>) -> Option<Combo> {
    state.hotkey.armed_combo()
}

#[tauri::command]
fn hotkey_clear(app: AppHandle, state: State<'_, Pointy>) -> Result<(), String> {
    state.hotkey.disarm();
    hotkey::unregister_os_shortcuts(&app);
    settings::update(&app, |settings| settings.hotkey = None).map(|_| ())
}

// ------------------------------------------------------------------- settings

#[tauri::command]
fn settings_get(app: AppHandle) -> Settings {
    settings::load(&app)
}

#[tauri::command]
fn settings_finish_onboarding(app: AppHandle) -> Result<Settings, String> {
    let settings = settings::update(&app, |settings| settings.onboarding_complete = true)?;
    overlay::set_enabled(&app, true);
    Ok(settings)
}

#[tauri::command]
fn models_status() -> Vec<(String, bool)> {
    models::status()
}

#[tauri::command]
fn models_ready() -> bool {
    models::ready()
}

#[tauri::command]
fn settings_reset(app: AppHandle, state: State<'_, Pointy>) -> Result<Settings, String> {
    state.hotkey.disarm();
    hotkey::unregister_os_shortcuts(&app);
    state.audio.stop_levels();
    overlay::set_enabled(&app, false);
    let settings = Settings::default();
    settings::save(&app, &settings)?;
    Ok(settings)
}

// -------------------------------------------------------------------- overlay

/// Arm or silence hold-to-wake. The overlay stays hidden until the hotkey is held.
#[tauri::command]
fn overlay_set_enabled(app: AppHandle, enabled: bool) {
    overlay::set_enabled(&app, enabled);
}

#[tauri::command]
fn overlay_hide(app: AppHandle) {
    overlay::hide(&app);
}

/// Main-thread wake — the dashboard calls this so Windows actually shows the overlay.
#[tauri::command]
fn overlay_wake(app: AppHandle) {
    overlay::begin_listen(&app);
}

#[tauri::command]
fn overlay_rest(app: AppHandle) {
    overlay::end_listen(&app);
}

#[tauri::command]
fn overlay_set_passthrough(app: AppHandle, enabled: bool) {
    overlay::set_passthrough(&app, enabled);
}

#[tauri::command]
fn overlay_set_hit_rect(rect: overlay::HitRectDto) {
    overlay::set_hit_rect(rect);
}

/// The model's reply plus where the capture sat on the monitor, so the frontend
/// can map the target box back onto the full screen.
#[derive(serde::Serialize)]
struct AskReply {
    answer: String,
    advice: String,
    multi_step: bool,
    action: String,
    confidence: f64,
    target: Option<nim::ClickTarget>,
    /// Exact center of the resolved control, physical px + virtual-desktop
    /// fractions (see uia::DotPoint). Present when the accessibility tree
    /// matched the model's label.
    dot: Option<uia::DotPoint>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// How many earlier exchanges the model is shown. Enough for "that one" to
/// resolve, small enough that tokens and latency stay flat as a session grows.
const HISTORY_TURNS: usize = 4;

#[tauri::command]
async fn ask_screen(
    app: AppHandle,
    question: String,
    window_id: Option<u32>,
    app_name: Option<String>,
    history: Option<Vec<nim::ChatTurn>>,
) -> Result<AskReply, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Trim here rather than trusting the caller, so the cap holds however
        // the frontend evolves.
        let history = history.unwrap_or_default();
        let recent = &history[history.len().saturating_sub(HISTORY_TURNS)..];
        let shot = overlay::snapshot_for_ask(&app, window_id)?;
        let reply = nim::ask_screen(
            &question,
            Some(&shot.image),
            app_name.as_deref(),
            Some((shot.width, shot.height)),
            recent,
        )?;
        let (target, dot) = refine_target(window_id, &shot, reply.target);
        Ok(AskReply {
            answer: reply.answer,
            advice: reply.advice,
            multi_step: reply.multi_step,
            action: reply.action,
            confidence: reply.confidence,
            target,
            dot,
            x: shot.x,
            y: shot.y,
            w: shot.w,
            h: shot.h,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Replace the model's guessed box with the real UI Automation rectangle when
/// the element can be found (otherwise keep the model's coordinates), and
/// surface the exact dot the overlay should draw.
#[cfg(windows)]
fn refine_target(
    window_id: Option<u32>,
    shot: &capture::AskCapture,
    target: Option<nim::ClickTarget>,
) -> (Option<nim::ClickTarget>, Option<uia::DotPoint>) {
    // UIA refinement needs a concrete window; without one keep the model's box.
    match (target, window_id) {
        (Some(target), Some(id)) => uia::resolve(id, shot, &target),
        (target, _) => (target, None),
    }
}

#[cfg(not(windows))]
fn refine_target(
    _window_id: Option<u32>,
    _shot: &capture::AskCapture,
    target: Option<nim::ClickTarget>,
) -> (Option<nim::ClickTarget>, Option<uia::DotPoint>) {
    (target, None)
}

/// A box as 0..1 fractions of the virtual desktop — the overlay's coordinate
/// space.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
struct FracRect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// A control found in the live accessibility tree. Both the box and the dot are
/// fractions of the virtual desktop, which is the overlay's own coordinate
/// space, so the frontend needs no shot mapping.
#[derive(serde::Serialize)]
struct LocatedTarget {
    target: nim::ClickTarget,
    dot: uia::DotPoint,
}

/// Re-find a control by name, right now.
///
/// "point it" calls this at click time instead of reusing the box from the
/// answer. The screenshot that produced that box may be seconds old, and if the
/// user has scrolled or moved the window since, the old coordinates would glow
/// empty space. Reading the tree again is cheap and always current.
#[tauri::command]
async fn locate_target(
    label: String,
    window_id: Option<u32>,
    expect: Option<FracRect>,
) -> Result<Option<LocatedTarget>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let label = label.trim();
        if label.is_empty() {
            return None;
        }
        // The box from the answer is stale as coordinates but still says which
        // region to search, which is what keeps look-alike navbar entries out.
        let hint = expect.map(|r| uia::hint_from_fractions(r.x, r.y, r.w, r.h));
        let dot = uia::point_for_label(locate_window(window_id)?, label, hint)?;
        Some(LocatedTarget {
            target: nim::ClickTarget {
                label: dot.label.clone(),
                x: dot.fx,
                y: dot.fy,
                w: dot.fw,
                h: dot.fh,
            },
            dot,
        })
    })
    .await
    .map_err(|e| e.to_string())
}

/// Watch for the click the highlight is asking for, so it can bow out once the
/// user has acted on it. `rect` is in virtual-desktop fractions.
#[tauri::command]
fn point_watch(app: AppHandle, rect: FracRect) {
    clickwatch::watch(app, rect.x, rect.y, rect.w, rect.h);
}

#[tauri::command]
fn point_unwatch() {
    clickwatch::unwatch();
}

/// "This whole screen" has no picked window, so fall back to whatever is in
/// front — that is what the user is looking at.
#[cfg(windows)]
fn locate_window(window_id: Option<u32>) -> Option<u32> {
    window_id.or_else(uia::foreground_window)
}

#[cfg(not(windows))]
fn locate_window(window_id: Option<u32>) -> Option<u32> {
    window_id
}

#[tauri::command]
async fn transcribe_wav(wav_base64: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let raw = wav_base64
            .split_once(',')
            .map(|(_, rest)| rest.to_string())
            .unwrap_or(wav_base64);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(raw.trim())
            .map_err(|e| format!("Bad audio payload: {e}"))?;
        nim::transcribe_wav(&bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

// -------------------------------------------------------------------- capture

/// Windows the user can pick as the subject of their question.
#[tauri::command]
async fn windows_list() -> Result<Vec<capture::AppWindow>, String> {
    tauri::async_runtime::spawn_blocking(capture::list_windows)
        .await
        .map_err(|e| e.to_string())?
}

/// Raise the picked window so it is what the next capture actually shows.
#[tauri::command]
fn window_focus(id: u32) {
    overlay::focus_app_window(id);
}

/// Fresh screenshot with Pointy hidden, optionally cropped to one window.
/// Taken when the user sends, not on hotkey.
#[tauri::command]
async fn capture_scope(app: AppHandle, window_id: Option<u32>) -> Result<capture::Shot, String> {
    tauri::async_runtime::spawn_blocking(move || overlay::snapshot_desktop(&app, window_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn wake_session(state: State<'_, Pointy>) -> capture::WakeSession {
    state.wake.get()
}

#[tauri::command]
fn wake_set_transcript(state: State<'_, Pointy>, transcript: String) {
    state.wake.set_transcript(transcript);
}

// --------------------------------------------------------------------- usage

#[tauri::command]
fn usage_stats(state: State<'_, Pointy>) -> usage::UsageData {
    state.usage.snapshot()
}

/// Answer "how long did I spend on X?" from local data, or None when the
/// question is not a usage question or nothing matches.
#[tauri::command]
fn usage_question(question: String, state: State<'_, Pointy>) -> Option<String> {
    usage::answer_usage(&question, &state.usage.snapshot())
}

// --------------------------------------------------------------------- guide

#[tauri::command]
fn guide_start(
    app: AppHandle,
    state: State<'_, Pointy>,
    task: String,
    window_id: Option<u32>,
    first_label: Option<String>,
    action: Option<String>,
    confidence: Option<f64>,
) -> Result<(), String> {
    let task = task.trim().to_string();
    if task.is_empty() {
        return Err("Tell me what you need help with.".into());
    }
    let label = first_label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "I need a clear first control before starting guided mode.".to_string())?;
    let confidence = confidence.unwrap_or(0.0).clamp(0.0, 1.0);
    if confidence < 0.65 {
        return Err("The first step is not clear enough to guide safely yet.".into());
    }
    state
        .guide
        .start(app, task, window_id, Some(label.to_string()), action, Some(confidence));
    Ok(())
}

#[tauri::command]
fn guide_stop(state: State<'_, Pointy>) {
    state.guide.stop();
}

#[tauri::command]
fn guide_active(state: State<'_, Pointy>) -> bool {
    state.guide.active()
}

#[tauri::command]
fn guide_repeat(app: AppHandle, state: State<'_, Pointy>) {
    state.guide.repeat(&app);
}

/// Speak text through the OS voice (fallback when the webview has no voices).
#[tauri::command]
async fn speak(text: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || tts::speak(&text))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn stop_speaking() {
    tts::stop_speaking();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(
            ShortcutBuilder::new()
                .with_handler(|app, _shortcut, event| match event.state() {
                    ShortcutState::Pressed => {
                        overlay::begin_listen(app);
                        if let Some(combo) = settings::load(app).hotkey {
                            let _ = app.emit("hotkey://down", combo);
                        }
                    }
                    ShortcutState::Released => {
                        overlay::end_listen(app);
                        if let Some(combo) = settings::load(app).hotkey {
                            let _ = app.emit("hotkey://up", combo);
                        }
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let usage_path = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir())
                .join("usage.json");
            let state = Pointy {
                hotkey: HotkeyManager::start(handle.clone()),
                audio: AudioManager::new(),
                wake: WakeStore::new(),
                usage: UsageTracker::new(usage_path),
                guide: GuideManager::new(),
            };

            let stored = settings::load(&handle);
            let _ = models::configure(&handle);
            models::ensure_release_assets(&handle);

            // A hotkey recorded in a previous run is live from launch.
            if let Some(combo) = stored.hotkey.clone() {
                state.hotkey.arm(combo.clone());
                hotkey::register_os_shortcut(&handle, &combo);
            }

            // The overlay window exists from launch. Enable as soon as a hotkey is
            // saved — otherwise Speak never shows glass (onboarding_complete is still false).
            overlay::prepare(&handle);
            overlay::set_enabled(&handle, stored.hotkey.is_some());

            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            permissions_status,
            permissions_request,
            permissions_open_settings,
            audio_input_devices,
            audio_start_levels,
            audio_stop_levels,
            audio_current_device,
            hotkey_start_capture,
            hotkey_stop_capture,
            hotkey_validate,
            hotkey_save,
            hotkey_current,
            hotkey_clear,
            settings_get,
            settings_finish_onboarding,
            settings_reset,
            models_status,
            models_ready,
            overlay_set_enabled,
            overlay_hide,
            overlay_wake,
            overlay_rest,
            overlay_set_passthrough,
            overlay_set_hit_rect,
            ask_screen,
            locate_target,
            point_watch,
            point_unwatch,
            transcribe_wav,
            windows_list,
            window_focus,
            capture_scope,
            wake_session,
            wake_set_transcript,
            usage_stats,
            usage_question,
            guide_start,
            guide_stop,
            guide_active,
            guide_repeat,
            speak,
            stop_speaking,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

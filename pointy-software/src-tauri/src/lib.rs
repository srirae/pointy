//! Pointy — Tauri backend.
//!
//! This pass covers the onboarding pipeline plumbing only, but each piece is the real
//! foundation the later phases build on:
//!
//! * `audio`       — live mic capture and band levels. Phase 3's wake-word listener
//!                   reads the same frames.
//! * `hotkey`      — one global keyboard hook, used both to record a combo and to emit
//!                   the push-to-talk down/up edges Phase 1 activation needs.
//! * `overlay`     — the push-to-talk pill window, shown on the hotkey down edge.
//! * `permissions` — real OS state for mic, screen capture and accessibility.
//! * `settings`    — persisted hotkey / device / onboarding state.

mod audio;
mod capture;
mod hotkey;
mod keyboard;
mod keys;
mod nim;
mod overlay;
mod permissions;
mod settings;

use audio::{AudioDevice, AudioManager};
use capture::WakeStore;
use hotkey::{Combo, HotkeyManager, Validation};
use permissions::{Capability, PermissionStatus};
use settings::Settings;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{ShortcutState, Builder as ShortcutBuilder};
use base64::Engine;

pub(crate) struct Pointy {
    pub(crate) hotkey: HotkeyManager,
    pub(crate) audio: AudioManager,
    pub(crate) wake: WakeStore,
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

#[tauri::command]
async fn ask_screen(
    question: String,
    screenshot: Option<String>,
    app: Option<String>,
) -> Result<nim::NimReply, String> {
    tauri::async_runtime::spawn_blocking(move || {
        nim::ask_screen(&question, screenshot.as_deref(), app.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
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
            let state = Pointy {
                hotkey: HotkeyManager::start(handle.clone()),
                audio: AudioManager::new(),
                wake: WakeStore::new(),
            };

            let stored = settings::load(&handle);

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
            overlay_set_enabled,
            overlay_hide,
            overlay_wake,
            overlay_rest,
            overlay_set_passthrough,
            overlay_set_hit_rect,
            ask_screen,
            transcribe_wav,
            windows_list,
            window_focus,
            capture_scope,
            wake_session,
            wake_set_transcript,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

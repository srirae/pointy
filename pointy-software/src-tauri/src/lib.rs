//! Pointy — Tauri backend.
//!
//! This pass covers the onboarding pipeline plumbing only, but each piece is the real
//! foundation the later phases build on:
//!
//! * `audio`       — live mic capture and band levels. Phase 3's wake-word listener
//!                   reads the same frames.
//! * `hotkey`      — one global keyboard hook, used both to record a combo and to emit
//!                   the push-to-talk down/up edges Phase 1 activation needs.
//! * `permissions` — real OS state for mic, screen capture and accessibility.
//! * `settings`    — persisted hotkey / device / onboarding state.

mod audio;
mod hotkey;
mod keyboard;
mod keys;
mod permissions;
mod settings;

use audio::{AudioDevice, AudioManager};
use hotkey::{Combo, HotkeyManager, Validation};
use permissions::{Capability, PermissionStatus};
use settings::Settings;
use tauri::{AppHandle, Manager, State};

struct Pointy {
    hotkey: HotkeyManager,
    audio: AudioManager,
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
fn hotkey_save(app: AppHandle, state: State<'_, Pointy>, keys: Vec<String>) -> Result<Combo, String> {
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
    Ok(combo)
}

#[tauri::command]
fn hotkey_current(state: State<'_, Pointy>) -> Option<Combo> {
    state.hotkey.armed_combo()
}

#[tauri::command]
fn hotkey_clear(app: AppHandle, state: State<'_, Pointy>) -> Result<(), String> {
    state.hotkey.disarm();
    settings::update(&app, |settings| settings.hotkey = None).map(|_| ())
}

// ------------------------------------------------------------------- settings

#[tauri::command]
fn settings_get(app: AppHandle) -> Settings {
    settings::load(&app)
}

#[tauri::command]
fn settings_finish_onboarding(app: AppHandle) -> Result<Settings, String> {
    settings::update(&app, |settings| settings.onboarding_complete = true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let state = Pointy {
                hotkey: HotkeyManager::start(handle.clone()),
                audio: AudioManager::new(),
            };

            // A hotkey recorded in a previous run is live from launch.
            if let Some(combo) = settings::load(&handle).hotkey {
                state.hotkey.arm(combo);
            }

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

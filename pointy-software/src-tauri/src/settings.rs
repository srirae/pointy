//! Persisted setup state: the hotkey the user recorded, their chosen input device and
//! whether onboarding finished. Written as JSON in the app config directory.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::hotkey::Combo;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub hotkey: Option<Combo>,
    pub input_device: Option<String>,
    pub onboarding_complete: bool,
}

fn path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("No config directory available: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {dir:?}: {e}"))?;
    Ok(dir.join("settings.json"))
}

/// Missing or corrupt settings are not an error worth blocking setup for — a fresh
/// default simply sends the user through onboarding again.
pub fn load(app: &AppHandle) -> Settings {
    let Ok(path) = path(app) else {
        return Settings::default();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = path(app)?;
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Could not serialise settings: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("Could not write {path:?}: {e}"))
}

/// Read-modify-write helper so callers never clobber unrelated fields.
pub fn update<F>(app: &AppHandle, mutate: F) -> Result<Settings, String>
where
    F: FnOnce(&mut Settings),
{
    let mut settings = load(app);
    mutate(&mut settings);
    save(app, &settings)?;
    Ok(settings)
}

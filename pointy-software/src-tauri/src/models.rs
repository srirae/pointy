//! Model asset policy. Debug builds read `pointy-software/models` directly; release
//! builds read only the per-user app-data cache. The installer never contains these
//! large files.

use std::path::PathBuf;
use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Manager};

static ROOT: OnceLock<PathBuf> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
pub struct ModelProgress {
    pub phase: String,
    pub asset: String,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub ready: bool,
    pub error: Option<String>,
}

pub fn configure(app: &AppHandle) -> Result<(), String> {
    let root = if cfg!(debug_assertions) {
        let cwd = std::env::current_dir().map_err(|err| err.to_string())?;
        cwd.join("models")
    } else {
        app.path()
            .app_data_dir()
            .map_err(|err| format!("No app-data directory: {err}"))?
            .join("models")
    };
    std::fs::create_dir_all(&root).map_err(|err| format!("Could not create {root:?}: {err}"))?;
    let _ = ROOT.set(root);
    Ok(())
}

pub fn root() -> PathBuf {
    ROOT.get().cloned().unwrap_or_else(|| {
        if cfg!(debug_assertions) {
            std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")).join("models")
        } else {
            PathBuf::from("models")
        }
    })
}

pub fn path(name: &str) -> Option<PathBuf> {
    let path = root().join(name);
    path.exists().then_some(path)
}

pub fn status() -> Vec<(String, bool)> {
    vec![]
}

pub fn ready() -> bool {
    true // Remote STT/TTS are always ready
}

pub fn ensure_release_assets(_app: &AppHandle) {
    // No-op for remote STT and TTS
}

pub fn voice_installed(_code: &str) -> bool {
    true // Remote TTS doesn't need voices installed locally
}

pub fn voice_path(_code: &str) -> Option<PathBuf> {
    None
}

pub fn voice_status() -> Vec<(String, bool)> {
    crate::lang::LANGUAGES
        .iter()
        .map(|language| (language.code.to_string(), true))
        .collect()
}

pub fn download_voice(app: &AppHandle, code: &str) {
    // No-op for remote TTS, just emit ready
    let _ = tauri::Emitter::emit(app, "models://voice", ModelProgress {
        phase: "ready".into(),
        asset: code.into(),
        downloaded: 0,
        total: None,
        ready: true,
        error: None,
    });
}

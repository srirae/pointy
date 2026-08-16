//! Model asset policy. Debug builds read `pointy-software/models` directly; release
//! builds read only the per-user app-data cache. The installer never contains these
//! large files.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

static ROOT: OnceLock<PathBuf> = OnceLock::new();

const WHISPER_FILE: &str = "ggml-base.en.bin";
const PIPER_FILE: &str = "piper.exe";
const VOICE_FILE: &str = "en_US-lessac-medium.onnx";
const VOICE_CONFIG: &str = "en_US-lessac-medium.onnx.json";

#[derive(Debug, Clone, Serialize)]
pub struct ModelProgress {
    pub phase: String,
    pub asset: String,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub ready: bool,
    pub error: Option<String>,
}

/// Configure the path once during Tauri setup. This is intentionally a distinct
/// compile-time branch: dev never touches app-data and release never reads the repo.
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
    let _ = ROOT.set(root);    Ok(())
}

#[cfg(windows)]
fn find_file(dir: &Path, wanted: &str) -> Option<PathBuf> {
    for entry in std::fs::read_dir(dir).ok()? {
        let entry = entry.ok()?;
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_file(&path, wanted) { return Some(found); }
        } else if path.file_name().and_then(|name| name.to_str())
            .map(|name| name.eq_ignore_ascii_case(wanted)).unwrap_or(false) {
            return Some(path);
        }
    }
    None
}



pub fn root() -> PathBuf {
    ROOT.get().cloned().unwrap_or_else(|| {
        if cfg!(debug_assertions) {
            std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")) .join("models")
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
    [WHISPER_FILE, PIPER_FILE, VOICE_FILE, VOICE_CONFIG]
        .into_iter()
        .map(|name| (name.to_string(), is_valid(&root().join(name), name)))
        .collect()
}

pub fn ready() -> bool {
    cfg!(debug_assertions)
        || [WHISPER_FILE, PIPER_FILE, VOICE_FILE, VOICE_CONFIG]
            .into_iter()
            .all(|name| is_valid(&root().join(name), name))
}

fn expected(name: &str) -> Option<u64> {
    match name {
        WHISPER_FILE => Some(20 * 1024 * 1024),
        PIPER_FILE => Some(256 * 1024),
        VOICE_FILE => Some(10 * 1024 * 1024),
        VOICE_CONFIG => Some(100),
        _ => None,
    }
}

fn is_valid(path: &Path, name: &str) -> bool {
    path.exists()
        && path
            .metadata()
            .map(|meta| meta.len() >= expected(name).unwrap_or(1))
            .unwrap_or(false)
}

fn url(name: &str) -> Option<String> {
    let (env_name, default) = match name {
        WHISPER_FILE => (
            "POINTY_WHISPER_URL",
            Some("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin?download=true"),
        ),
        PIPER_FILE => (
            "POINTY_PIPER_URL",
            Some("https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip"),
        ),
        VOICE_FILE => (
            "POINTY_PIPER_VOICE_URL",
            Some("https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx?download=true"),
        ),
        VOICE_CONFIG => (
            "POINTY_PIPER_CONFIG_URL",
            Some("https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json?download=true"),
        ),
        _ => return None,
    };
    std::env::var(env_name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| default.map(str::to_string))
}

/// Release-only bootstrap. Each completed file is cached permanently; a corrupt
/// or undersized file is removed and downloaded again. Progress is emitted for a
/// visible first-run UI, while dev mode returns immediately because postinstall
/// owns local model preparation.
pub fn ensure_release_assets(app: &AppHandle) {
    if cfg!(debug_assertions) {
        eprintln!("[models] dev mode: using local {}", root().display());
        return;
    }

    let app = app.clone();
    std::thread::Builder::new()
        .name("pointy-model-bootstrap".into())
        .spawn(move || {
            let names = [WHISPER_FILE, PIPER_FILE, VOICE_FILE, VOICE_CONFIG];
            let mut failed = false;
            for name in names {
                let target = root().join(name);
                if is_valid(&target, name) {
                    let _ = app.emit("models://progress", ModelProgress {
                        phase: "ready".into(), asset: name.into(), downloaded: target.metadata().map(|m| m.len()).unwrap_or(0), total: target.metadata().ok().map(|m| m.len()), ready: true, error: None,
                    });
                    continue;
                }
                let Some(source) = url(name) else {
                    failed = true;
                    let _ = app.emit("models://progress", ModelProgress { phase: "error".into(), asset: name.into(), downloaded: 0, total: None, ready: false, error: Some(format!("Missing {name}. Set the matching POINTY_*_URL before building a release.")) });
                    continue;
                };
                if let Err(err) = download(&app, name, &source, &target) {
                    failed = true;
                    let _ = app.emit("models://progress", ModelProgress { phase: "error".into(), asset: name.into(), downloaded: 0, total: None, ready: false, error: Some(err) });
                }
            }
            let _ = app.emit("models://progress", ModelProgress { phase: if failed { "incomplete" } else { "complete" }.into(), asset: "".into(), downloaded: 0, total: None, ready: !failed, error: None });
        })
        .ok();
}

fn download(app: &AppHandle, name: &str, source: &str, target: &Path) -> Result<(), String> {
    let temp = target.with_extension("download");
    let _ = std::fs::remove_file(&temp);
    let response = reqwest::blocking::Client::new()
        .get(source)
        .send()
        .map_err(|err| format!("Could not download {name}: {err}"))?;
    if !response.status().is_success() {
        return Err(format!("Could not download {name}: {}", response.status()));
    }
    let total = response.content_length();
    let bytes = response.bytes().map_err(|err| format!("Could not read {name}: {err}"))?;
    std::fs::write(&temp, &bytes).map_err(|err| format!("Could not cache {name}: {err}"))?;
    // Piper publishes a Windows zip. Extract only piper.exe so the release
    // cache contains the executable at the same path as the dev cache.
    if name == PIPER_FILE && source.to_ascii_lowercase().contains(".zip") {
        let zip = target.with_extension("zip");
        std::fs::rename(&temp, &zip).map_err(|err| format!("Could not stage Piper: {err}"))?;
        #[cfg(windows)]
        {
            let extract = target.with_extension("piper-extract");
            let _ = std::fs::remove_dir_all(&extract);
            std::fs::create_dir_all(&extract).map_err(|err| err.to_string())?;
            use std::os::windows::process::CommandExt;
            let status = std::process::Command::new("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &format!(
                    "Expand-Archive -LiteralPath '{}' -DestinationPath '{}' -Force",
                    zip.to_string_lossy().replace('\'', "''"),
                    extract.to_string_lossy().replace('\'', "''"),
                )])
                .creation_flags(0x0800_0000)
                .status()
                .map_err(|err| format!("Could not extract Piper: {err}"))?;
            if !status.success() {
                return Err("Could not extract Piper archive".into());
            }
            let found = find_file(&extract, "piper.exe").ok_or_else(|| "Piper archive had no piper.exe".to_string())?;
            std::fs::copy(found, target).map_err(|err| format!("Could not cache Piper: {err}"))?;
            let _ = std::fs::remove_dir_all(&extract);
        }
        #[cfg(not(windows))]
        {
            return Err("The configured Piper archive is Windows-only".into());
        }
        let _ = std::fs::remove_file(zip);
    } else {
        std::fs::rename(&temp, target).map_err(|err| format!("Could not install {name}: {err}"))?;
    }
    if !is_valid(target, name) {
        let _ = std::fs::remove_file(target);
        return Err(format!("Downloaded {name} failed its size check"));
    }
    let _ = app.emit("models://progress", ModelProgress { phase: "downloaded".into(), asset: name.into(), downloaded: bytes.len() as u64, total, ready: true, error: None });
    Ok(())
}


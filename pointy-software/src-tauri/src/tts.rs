//! Text-to-speech fallback using the OS voice (System.Speech / SAPI).
//!
//! The webview's Web Speech API is usually present, but some WebView2 installs
//! expose no voices and answers go unspoken. The frontend falls back to this
//! command so there is always a voice.
//!
//! Misclick warnings must NOT be generated live — a PowerShell/SAPI round-trip
//! takes a second or more and would blow the single-digit-millisecond reactive
//! path. Instead `warm_warning()` synthesizes the warning to a WAV **once**, and
//! `play_warning()` then plays that file with `PlaySoundW` (SND_ASYNC), which
//! starts in microseconds with no network and no process spawn.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

pub fn speak(text: &str) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(());
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        use std::thread;
        use std::time::Duration;

        // A new sentence cancels any stale SAPI process. Without this, every
        // rapid guide event queued another PowerShell voice and old text could
        // be heard long after the UI had moved on.
        let generation = SPEECH_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

        // No console flash while the voice runs.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let script = format!(
            "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak({});",
            ps_quote(text)
        );
        let mut child = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Voice failed to start: {e}"))?;

        loop {
            if SPEECH_GENERATION.load(Ordering::SeqCst) != generation {
                let _ = child.kill();
                let _ = child.wait();
                return Ok(());
            }
            if let Some(status) = child
                .try_wait()
                .map_err(|e| format!("Voice process failed: {e}"))?
            {
                return if status.success() {
                    Ok(())
                } else {
                    Err("Voice did not finish speaking.".to_string())
                };
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[cfg(not(windows))]
    {
        let _ = text;
        Err("Voice is handled by the webview on this platform.".to_string())
    }
}

#[cfg(windows)]
static SPEECH_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Cancel any currently speaking SAPI process immediately.
pub fn stop_speaking() {
    #[cfg(windows)]
    {
        SPEECH_GENERATION.fetch_add(1, Ordering::SeqCst);
    }
}

/// Quote for PowerShell single-quoted strings: double any embedded quotes.
fn ps_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// The single, pre-cached misclick warning. ASCII-only so the PowerShell
/// command line survives any console codepage.
pub const WARNING_TEXT: &str = "Not that one. Click here instead.";

static WARNING_WAV: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

/// Generate and cache the warning WAV. Blocking, and deliberately called from
/// the misclick watcher's setup (its own thread) — never from the reactive loop.
#[cfg(windows)]
pub fn warm_warning() {
    let _ = warning_wav_path();
}

#[cfg(not(windows))]
pub fn warm_warning() {}

/// Play the cached warning immediately. `SND_ASYNC` returns as soon as playback
/// is queued, so this stays in the single-digit-millisecond range.
#[cfg(windows)]
pub fn play_warning() -> Result<(), String> {
    use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_FILENAME, SND_NODEFAULT};

    let path = warning_wav_path().ok_or_else(|| "No cached warning audio.".to_string())?;
    let wide = windows::core::HSTRING::from(path.to_string_lossy().as_ref());
    unsafe { PlaySoundW(&wide, None, SND_FILENAME | SND_ASYNC | SND_NODEFAULT) }
        .ok()
        .map_err(|e| format!("Could not play warning audio: {e}"))
}

#[cfg(not(windows))]
pub fn play_warning() -> Result<(), String> {
    Err("Warning voice is handled by the webview on this platform.".to_string())
}

/// Stop any warning still playing (used when the user reaches the real target).
#[cfg(windows)]
pub fn stop_warning() {
    use windows::Win32::Media::Audio::{PlaySoundW, SND_PURGE};
    unsafe {
        let _ = PlaySoundW(windows::core::PCWSTR::null(), None, SND_PURGE);
    }
}

#[cfg(not(windows))]
pub fn stop_warning() {}

/// Return the cached warning WAV path, generating it on first use.
#[cfg(windows)]
fn warning_wav_path() -> Option<PathBuf> {
    let cell = WARNING_WAV.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().unwrap();
    if let Some(path) = guard.as_ref() {
        if path.exists() {
            return Some(path.clone());
        }
        *guard = None; // stale file — regenerate
    }
    let path = generate_warning_wav()?;
    *guard = Some(path.clone());
    Some(path)
}

#[cfg(windows)]
fn generate_warning_wav() -> Option<PathBuf> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    // No console flash while the voice is synthesized.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let path = std::env::temp_dir().join("pointy_warning.wav");
    let _ = std::fs::remove_file(&path);
    let path_str = path.to_string_lossy();
    let script = format!(
        "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile({}); $s.Speak({}); $s.Dispose()",
        ps_quote(path_str.as_ref()),
        ps_quote(WARNING_TEXT)
    );
    let status = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .ok()?;
    if status.success() && path.exists() {
        Some(path)
    } else {
        None
    }
}

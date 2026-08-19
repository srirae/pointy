//! Local neural speech for Pointy.
//!
//! Piper is the primary answer/guide voice. It runs locally from the model assets,
//! writes a short WAV, and starts asynchronous playback as soon as that WAV exists.
//! Windows SAPI is retained only as a last-resort fallback. Misclick warnings stay
//! on their separate pre-cached WAV path and never invoke Piper.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

#[cfg(windows)]
use std::process::Child;

#[cfg(windows)]
static SPEECH_GENERATION: AtomicU64 = AtomicU64::new(0);
#[cfg(windows)]
static PIPER_CHILD: OnceLock<Mutex<Option<Child>>> = OnceLock::new();

/// Speak one sentence. Piper is attempted first; SAPI is used only if the local
/// Piper executable/model is absent or fails. The function returns after audio is
/// queued, not after the whole sentence has finished playing.
pub fn speak(text: &str) -> Result<(), String> {
    speak_with(text, None)
}

/// Speak using a specific Piper voice, for languages other than English.
///
/// The SAPI fallback is deliberately skipped when a voice was named: SAPI would
/// read Hindi or Urdu words with an English voice and produce nonsense. Failing
/// instead lets the caller fall back to the English text, which is at least
/// intelligible.
pub fn speak_with(text: &str, voice: Option<PathBuf>) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(());
    }

    #[cfg(windows)]
    {
        let chosen = voice.is_some();
        match speak_piper(text, voice) {
            Ok(()) => return Ok(()),
            Err(err) if chosen => return Err(err),
            Err(err) => eprintln!("[tts] Piper unavailable: {err}; using SAPI fallback"),
        }
        speak_sapi(text)
    }

    #[cfg(not(windows))]
    {
        let _ = (text, voice);
        Err("Local Piper integration is currently implemented for Windows only.".into())
    }
}

#[cfg(windows)]
fn speak_piper(text: &str, voice: Option<PathBuf>) -> Result<(), String> {
    use std::io::Write;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::{SystemTime, UNIX_EPOCH};

    let piper = crate::models::path("piper.exe")
        .ok_or_else(|| "piper.exe is not present in the model directory".to_string())?;
    let voice = match voice {
        Some(path) => path,
        None => crate::models::path("en_US-lessac-medium.onnx")
            .ok_or_else(|| "Piper voice model is not present".to_string())?,
    };
    // Piper expects the config beside the model, named after it.
    let config = Some(PathBuf::from(format!("{}.json", voice.display())));
    if !piper.exists() || !voice.exists() {
        return Err("Piper executable or voice model is missing".into());
    }

    let generation = SPEECH_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    stop_piper_child();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let wav = std::env::temp_dir().join(format!("pointy-speech-{generation}-{stamp}.wav"));

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = Command::new(piper);
    command
        .arg("--model")
        .arg(voice)
        .arg("--output_file")
        .arg(&wav)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    if let Some(config) = config {
        if config.exists() {
            command.arg("--config").arg(config);
        }
    }

    let child = command
        .spawn()
        .map_err(|err| format!("could not start Piper: {err}"))?;
    if let Ok(mut slot) = PIPER_CHILD.get_or_init(|| Mutex::new(None)).lock() {
        *slot = Some(child);
    } else {
        return Err("could not lock Piper process".into());
    }

    // The child is owned by the global slot while Piper runs. Dropping stdin is
    // important: Piper starts synthesis only after it sees EOF on its input.
    let mut child = PIPER_CHILD
        .get()
        .and_then(|cell| cell.lock().ok())
        .and_then(|mut slot| slot.take())
        .ok_or_else(|| "Piper process disappeared".to_string())?;
    child
        .stdin
        .take()
        .ok_or_else(|| "Piper stdin was unavailable".to_string())?
        .write_all(format!("{text}\n").as_bytes())
        .map_err(|err| format!("could not send text to Piper: {err}"))?;
    let status = child
        .wait()
        .map_err(|err| format!("Piper failed: {err}"))?;
    if SPEECH_GENERATION.load(Ordering::SeqCst) != generation {
        let _ = std::fs::remove_file(&wav);
        return Ok(());
    }
    if !status.success() || !wav.exists() {
        let _ = std::fs::remove_file(&wav);
        return Err("Piper did not produce audio".into());
    }

    play_wav(&wav)?;
    eprintln!(
        "TTS: engine=piper audio_started_at={} sentence_chars={}",
        crate::events::now_millis(),
        text.chars().count()
    );
    // PlaySoundW has loaded/queued the file. It is safe to remove it after the
    // call because Windows keeps the audio data for asynchronous playback.
    let _ = std::fs::remove_file(&wav);
    Ok(())
}

#[cfg(windows)]
fn stop_piper_child() {
    if let Some(cell) = PIPER_CHILD.get() {
        if let Ok(mut slot) = cell.lock() {
            if let Some(mut child) = slot.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

#[cfg(windows)]
fn speak_sapi(text: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use std::thread;
    use std::time::Duration;

    let generation = SPEECH_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let script = format!(
        "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak({});",
        ps_quote(text)
    );
    let mut child = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|err| format!("SAPI failed to start: {err}"))?;
    loop {
        if SPEECH_GENERATION.load(Ordering::SeqCst) != generation {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(());
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|err| format!("SAPI process failed: {err}"))?
        {
            return if status.success() { Ok(()) } else { Err("SAPI did not finish speaking".into()) };
        }
        thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(windows)]
fn play_wav(path: &PathBuf) -> Result<(), String> {
    use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_FILENAME, SND_NODEFAULT};
    let wide = windows::core::HSTRING::from(path.to_string_lossy().as_ref());
    unsafe { PlaySoundW(&wide, None, SND_FILENAME | SND_ASYNC | SND_NODEFAULT) }
        .ok()
        .map_err(|err| format!("could not play local voice: {err}"))
}

#[cfg(windows)]
fn ps_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// Cancel current Piper/SAPI speech immediately.
pub fn stop_speaking() {
    #[cfg(windows)]
    {
        SPEECH_GENERATION.fetch_add(1, Ordering::SeqCst);
        stop_piper_child();
    }
}

/// Cached warning audio is intentionally independent from Piper.
pub const WARNING_TEXT: &str = "Not that one. Click here instead.";
static WARNING_WAV: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

#[cfg(windows)]
pub fn warm_warning() { let _ = warning_wav_path(); }
#[cfg(not(windows))]
pub fn warm_warning() {}

#[cfg(windows)]
pub fn play_warning() -> Result<(), String> {
    let path = warning_wav_path().ok_or_else(|| "No cached warning audio.".to_string())?;
    play_wav(&path)
}
#[cfg(not(windows))]
pub fn play_warning() -> Result<(), String> { Err("Warning audio is Windows-only.".into()) }

#[cfg(windows)]
pub fn stop_warning() {
    use windows::Win32::Media::Audio::{PlaySoundW, SND_PURGE};
    unsafe { let _ = PlaySoundW(windows::core::PCWSTR::null(), None, SND_PURGE); }
}
#[cfg(not(windows))]
pub fn stop_warning() {}

#[cfg(windows)]
fn warning_wav_path() -> Option<PathBuf> {
    let cell = WARNING_WAV.get_or_init(|| Mutex::new(None));
    let mut guard = cell.lock().ok()?;
    if let Some(path) = guard.as_ref() {
        if path.exists() { return Some(path.clone()); }
        *guard = None;
    }
    let path = generate_warning_wav()?;
    *guard = Some(path.clone());
    Some(path)
}

#[cfg(windows)]
fn generate_warning_wav() -> Option<PathBuf> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let path = std::env::temp_dir().join("pointy_warning.wav");
    let _ = std::fs::remove_file(&path);
    let script = format!(
        "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile({}); $s.Speak({}); $s.Dispose()",
        ps_quote(path.to_string_lossy().as_ref()),
        ps_quote(WARNING_TEXT)
    );
    let status = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .ok()?;
    (status.success() && path.exists()).then_some(path)
}

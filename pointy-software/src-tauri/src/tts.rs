//! Text-to-speech fallback using the OS voice (System.Speech / SAPI).
//!
//! The webview's Web Speech API is usually present, but some WebView2 installs
//! expose no voices and answers go unspoken. The frontend falls back to this
//! command so there is always a voice.

pub fn speak(text: &str) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(());
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;

        // No console flash while the voice runs.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let script = format!(
            "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak({});",
            ps_quote(text)
        );
        let status = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| format!("Voice failed to start: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err("Voice did not finish speaking.".to_string())
        }
    }

    #[cfg(not(windows))]
    {
        let _ = text;
        Err("Voice is handled by the webview on this platform.".to_string())
    }
}

/// Quote for PowerShell single-quoted strings: double any embedded quotes.
fn ps_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

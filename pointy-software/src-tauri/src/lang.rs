//! The languages Pointy can listen in and speak back in.
//!
//! Speech-to-text is handled entirely by Whisper, which auto-detects the spoken
//! language and can translate it to English, so the entry here carries no STT
//! configuration. What each language *does* need is a local Piper voice, and
//! those are large enough (~60MB) that they are downloaded only when someone
//! actually chooses the language — see `models::download_voice`.
//!
//! English is the exception: its voice ships with the mandatory model set, so it
//! is always available and never appears as a download.

use serde::Serialize;

/// One supported language, as offered in the overlay picker.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Language {
    /// ISO-639-1 code, and the key persisted in settings.
    pub code: &'static str,
    /// Name in English, used when asking the model to translate.
    pub english: &'static str,
    /// Name in its own script, for the picker.
    pub native: &'static str,
    /// Piper voice filename, or None when the voice ships by default.
    pub voice: Option<&'static str>,
    pub voice_url: Option<&'static str>,
    pub config_url: Option<&'static str>,
}

/// Urdu lives only on the repository's `main` branch — it was added after the
/// `v1.0.0` tag the English voice is pinned to — so its URLs differ in shape
/// from the others on purpose.
pub const LANGUAGES: &[Language] = &[
    Language {
        code: "en",
        english: "English",
        native: "English",
        voice: None,
        voice_url: None,
        config_url: None,
    },
    Language {
        code: "es",
        english: "Spanish",
        native: "Español",
        voice: Some("es_ES-davefx-medium.onnx"),
        voice_url: Some("https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_ES/davefx/medium/es_ES-davefx-medium.onnx?download=true"),
        config_url: Some("https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/es/es_ES/davefx/medium/es_ES-davefx-medium.onnx.json?download=true"),
    },
    Language {
        code: "hi",
        english: "Hindi",
        native: "हिन्दी",
        voice: Some("hi_IN-pratham-medium.onnx"),
        voice_url: Some("https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/hi/hi_IN/pratham/medium/hi_IN-pratham-medium.onnx?download=true"),
        config_url: Some("https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/hi/hi_IN/pratham/medium/hi_IN-pratham-medium.onnx.json?download=true"),
    },
    Language {
        code: "ur",
        english: "Urdu",
        native: "اردو",
        voice: Some("ur_PK-fasih-medium.onnx"),
        voice_url: Some("https://huggingface.co/rhasspy/piper-voices/resolve/main/ur/ur_PK/fasih/medium/ur_PK-fasih-medium.onnx?download=true"),
        config_url: Some("https://huggingface.co/rhasspy/piper-voices/resolve/main/ur/ur_PK/fasih/medium/ur_PK-fasih-medium.onnx.json?download=true"),
    },
];

pub const DEFAULT: &str = "en";

pub fn get(code: &str) -> Option<&'static Language> {
    let code = code.trim().to_ascii_lowercase();
    LANGUAGES.iter().find(|entry| entry.code == code)
}

/// Normalise whatever is in settings to a language we actually support.
pub fn resolve(code: Option<&str>) -> &'static Language {
    code.and_then(get)
        .unwrap_or_else(|| get(DEFAULT).expect("English is always present"))
}

/// True when the language needs its own downloaded voice to be spoken.
pub fn needs_voice(language: &Language) -> bool {
    language.voice.is_some()
}

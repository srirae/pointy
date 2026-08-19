//! The languages Pointy can listen in and speak back in.
//!
//! Speech-to-text is handled by Deepgram, and TTS by Cartesia.

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
    /// Cartesia Voice ID.
    pub voice_id: &'static str,
}

pub const LANGUAGES: &[Language] = &[
    Language {
        code: "en",
        english: "English",
        native: "English",
        voice_id: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4", // Skylar
    },
    Language {
        code: "es",
        english: "Spanish",
        native: "Español",
        voice_id: "3597a26f-80ef-4bd5-8101-9699bc764917",
    },
    Language {
        code: "hi",
        english: "Hindi",
        native: "हिन्दी",
        voice_id: "faf0731e-dfb9-4cfc-8119-259a79b27e12",
    },
    Language {
        code: "ar",
        english: "Arabic",
        native: "العربية",
        voice_id: "002622d8-19d0-4567-a16a-f99c7397c062",
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
pub fn needs_voice(_language: &Language) -> bool {
    false // Remote TTS never needs a local voice download
}

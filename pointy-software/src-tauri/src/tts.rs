//! Remote neural speech via Cartesia TTS for Pointy.
//!
//! Cartesia generates speech and returns it as audio bytes. We cache these
//! locally by hashing the text and voice ID to reduce API cost.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::hash::{Hash, Hasher};
use std::collections::hash_map::DefaultHasher;

#[cfg(windows)]
static SPEECH_GENERATION: AtomicU64 = AtomicU64::new(0);

fn get_cartesia_key() -> Result<String, String> {
    crate::nim::load_key(&["CARTESIA_API_KEY"], "cartesia")
}

/// Speak one sentence using the default English voice.
pub fn speak(text: &str) -> Result<(), String> {
    // Skylar default
    speak_with(text, Some("db6b0ed5-d5d3-463d-ae85-518a07d3c2b4"))
}

/// Speak using a specific Cartesia voice ID.
pub fn speak_with(text: &str, voice: Option<&str>) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(());
    }

    let voice_id = voice.unwrap_or("db6b0ed5-d5d3-463d-ae85-518a07d3c2b4");

    #[cfg(windows)]
    {
        speak_cartesia(text, voice_id)
    }

    #[cfg(not(windows))]
    {
        let _ = (text, voice_id);
        Err("Cartesia TTS integration audio playback is currently implemented for Windows only.".into())
    }
}

#[cfg(windows)]
fn speak_cartesia(text: &str, voice_id: &str) -> Result<(), String> {
    let generation = SPEECH_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    voice_id.hash(&mut hasher);
    let hash = hasher.finish();
    
    // v2 because v1 cached Cartesia's raw streaming WAV, which PlaySoundW cannot
    // play. Old files are left behind in temp but never read again.
    let wav_path = std::env::temp_dir().join(format!("pointy-speech-v2-{}.wav", hash));

    if !wav_path.exists() || std::fs::metadata(&wav_path).map(|m| m.len()).unwrap_or(0) < 100 {
        let key = get_cartesia_key()?;
        
        let payload = serde_json::json!({
            "transcript": text,
            "model_id": "sonic-3.5",
            "voice": {
                "mode": "id",
                "id": voice_id
            },
            "output_format": {
                "container": "wav",
                "encoding": "pcm_s16le",
                "sample_rate": 44100
            }
        });

        let client = reqwest::blocking::Client::new();
        let response = client
            .post("https://api.cartesia.ai/tts/bytes")
            .header("Authorization", format!("Bearer {}", key))
            .header("Cartesia-Version", "2025-04-16")
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .map_err(|e| format!("Network error connecting to Cartesia: {}", e))?;

        let status = response.status();
        if !status.is_success() {
            let err_text = response.text().unwrap_or_default();
            return Err(format!("Cartesia API error {}: {}", status, err_text.chars().take(200).collect::<String>()));
        }

        let bytes = response.bytes().map_err(|e| format!("Could not read audio bytes: {}", e))?;
        std::fs::write(&wav_path, normalize_wav(&bytes))
            .map_err(|e| format!("Could not save audio file: {}", e))?;
    }

    if SPEECH_GENERATION.load(Ordering::SeqCst) != generation {
        return Ok(());
    }

    play_wav(&wav_path)?;
    eprintln!(
        "TTS: engine=cartesia voice_id={} audio_started_at={} sentence_chars={} cached={}",
        voice_id,
        crate::events::now_millis(),
        text.chars().count(),
        wav_path.exists()
    );
    Ok(())
}

/// Cartesia's `/tts/bytes` streams a WAV whose RIFF/data sizes are `0xFFFFFFFF`
/// (unknown length) and carries an FFmpeg `LIST` metadata chunk. The legacy
/// `PlaySoundW` parser silently refuses that shape, so rewrite it into a plain
/// PCM WAV with correct sizes and only the `fmt `/`data` chunks.
fn normalize_wav(bytes: &[u8]) -> Vec<u8> {
    if bytes.len() < 44 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return bytes.to_vec();
    }

    let mut fmt: Vec<u8> = Vec::new();
    let mut data: Vec<u8> = Vec::new();
    let mut offset = 12usize;

    while offset + 8 <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let raw_size = u32::from_le_bytes([
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        ]);
        let payload_start = offset + 8;

        if raw_size == u32::MAX {
            // Streaming chunk: the payload runs to the end of the buffer.
            if id == b"data" {
                data = bytes[payload_start..].to_vec();
            }
            break;
        }

        let size = raw_size as usize;
        let payload_end = payload_start.saturating_add(size).min(bytes.len());
        match id {
            b"fmt " => fmt = bytes[payload_start..payload_end].to_vec(),
            b"data" => data = bytes[payload_start..payload_end].to_vec(),
            _ => {}
        }
        // Chunks are word-aligned in RIFF.
        offset = payload_end + (size & 1);
    }

    if fmt.is_empty() || data.is_empty() {
        return bytes.to_vec();
    }

    let riff_size = (4 + 8 + fmt.len() + 8 + data.len()) as u32;
    let mut out = Vec::with_capacity(12 + 8 + fmt.len() + 8 + data.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&riff_size.to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&(fmt.len() as u32).to_le_bytes());
    out.extend_from_slice(&fmt);
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(&data);
    out
}

#[cfg(windows)]
fn play_wav(path: &PathBuf) -> Result<(), String> {
    use windows::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_FILENAME, SND_NODEFAULT};
    let wide = windows::core::HSTRING::from(path.to_string_lossy().as_ref());
    unsafe { PlaySoundW(&wide, None, SND_FILENAME | SND_ASYNC | SND_NODEFAULT) }
        .ok()
        .map_err(|err| format!("could not play remote voice: {err}"))
}

/// Cancel current speech immediately.
pub fn stop_speaking() {
    #[cfg(windows)]
    {
        SPEECH_GENERATION.fetch_add(1, Ordering::SeqCst);
        use windows::Win32::Media::Audio::{PlaySoundW, SND_PURGE};
        unsafe { let _ = PlaySoundW(windows::core::PCWSTR::null(), None, SND_PURGE); }
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_wav;

    /// The exact WAV shape Cartesia streams: 0xFFFFFFFF RIFF/data sizes plus a
    /// LIST chunk. The normalizer must rewrite it into plain PCM.
    #[test]
    fn streaming_wav_is_normalized_to_plain_pcm() {
        let fmt = [
            0x01u8, 0x00, 0x01, 0x00, // PCM, mono
            0x44, 0xac, 0x00, 0x00, // 44100 Hz
            0x88, 0x58, 0x01, 0x00, // byte rate
            0x02, 0x00, 0x10, 0x00, // block align, 16-bit
        ];
        let pcm = vec![0x7fu8; 100];

        let mut raw = Vec::new();
        raw.extend_from_slice(b"RIFF");
        raw.extend_from_slice(&u32::MAX.to_le_bytes());
        raw.extend_from_slice(b"WAVE");
        raw.extend_from_slice(b"fmt ");
        raw.extend_from_slice(&(fmt.len() as u32).to_le_bytes());
        raw.extend_from_slice(&fmt);
        raw.extend_from_slice(b"LIST");
        raw.extend_from_slice(&26u32.to_le_bytes());
        raw.extend_from_slice(b"INFOISFT\x0e\x00\x00\x00Lavf62.12.101\x00");
        raw.extend_from_slice(b"data");
        raw.extend_from_slice(&u32::MAX.to_le_bytes());
        raw.extend_from_slice(&pcm);

        let out = normalize_wav(&raw);

        assert_eq!(&out[0..4], b"RIFF");
        assert_eq!(&out[8..12], b"WAVE");
        // RIFF size = 4 (WAVE) + 8+16 (fmt) + 8+100 (data) = 136.
        assert_eq!(u32::from_le_bytes([out[4], out[5], out[6], out[7]]), 136);
        assert_eq!(&out[12..16], b"fmt ");
        assert_eq!(u32::from_le_bytes([out[16], out[17], out[18], out[19]]), 16);
        assert_eq!(&out[20..36], &fmt[..]);
        // The LIST chunk is gone; data follows fmt directly.
        assert_eq!(&out[36..40], b"data");
        assert_eq!(u32::from_le_bytes([out[40], out[41], out[42], out[43]]), 100);
        assert_eq!(&out[44..], &pcm[..]);
    }

    /// A clean non-streaming WAV must round-trip unchanged.
    #[test]
    fn already_clean_wav_round_trips() {
        let fmt = [
            0x01u8, 0x00, 0x01, 0x00, 0x44, 0xac, 0x00, 0x00, 0x88, 0x58, 0x01, 0x00,
            0x02, 0x00, 0x10, 0x00,
        ];
        let pcm = vec![0x11u8; 64];
        let mut raw = Vec::new();
        raw.extend_from_slice(b"RIFF");
        raw.extend_from_slice(&(4u32 + 8 + 16 + 8 + 64).to_le_bytes());
        raw.extend_from_slice(b"WAVE");
        raw.extend_from_slice(b"fmt ");
        raw.extend_from_slice(&16u32.to_le_bytes());
        raw.extend_from_slice(&fmt);
        raw.extend_from_slice(b"data");
        raw.extend_from_slice(&64u32.to_le_bytes());
        raw.extend_from_slice(&pcm);

        assert_eq!(normalize_wav(&raw), raw);
    }

    /// Malformed input is returned unchanged, never panics.
    #[test]
    fn malformed_input_is_returned_unchanged() {
        let junk = vec![0u8; 64];
        assert_eq!(normalize_wav(&junk), junk);
    }
}

//! NVIDIA NIM from Rust — reads `.env` off disk and calls the API without CORS.
//!
//! The overlay webview cannot see Vite's `import.meta.env` reliably (env is baked at
//! `vite` start, and a missing key plus a failed fetch both used to show the same
//! "you need a NIM key" message). This module is the source of truth.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

const NIM_URL: &str = "https://integrate.api.nvidia.com/v1/chat/completions";
const TRANSCRIBE_URL: &str = "https://integrate.api.nvidia.com/v1/audio/transcriptions";

const VISION_MODELS: &[&str] = &[
    "meta/llama-3.2-90b-vision-instruct",
    "meta/llama-3.2-11b-vision-instruct",
];
const TEXT_MODELS: &[&str] = &[
    "meta/llama-3.3-70b-instruct",
    "nvidia/llama-3.1-nemotron-70b-instruct",
];
const TRANSCRIBE_MODELS: &[&str] = &[
    "openai/whisper-large-v3",
    "nvidia/whisper-large-v3",
    "nvidia/parakeet-tdt-0.6b-v2",
];

const SYSTEM: &str = r#"You are Pointy. You look at a screenshot of the user's screen and tell them where to click.

Respond with ONLY valid JSON (no markdown fences, no extra text):
{"answer":"2-5 short sentences. Bold UI names with **double asterisks**.","advice":"one encouraging line","target":{"label":"Close","x":0.96,"y":0.02,"w":0.035,"h":0.05}}

target.x/y/w/h are fractions from 0 to 1 of the screenshot.
- x,y is the TOP-LEFT of the control they should click
- w,h is how wide/tall that control is
- label is 1-3 words (Close, File, Save, Send…)

If you can see the control, you MUST fill target. Examples:
- close / exit / X → the rightmost caption button at the top-right of the active window
- minimize → the left or middle caption button
- a named button or menu → that control's box

If there is no clickable control for the question, set "target": null."#;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClickTarget {
    pub label: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NimReply {
    pub answer: String,
    pub advice: String,
    pub target: Option<ClickTarget>,
}

pub fn ask_screen(question: &str, screenshot: Option<&str>) -> Result<NimReply, String> {
    let key = load_key()?;
    let trimmed = question.trim();
    if trimmed.is_empty() {
        return Ok(NimReply {
            answer: "Say or type what you want to do on this screen.".into(),
            advice: "Hold your hotkey and speak, or type your question.".into(),
            target: None,
        });
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|e| format!("Could not reach NVIDIA: {e}"))?;

    if let Some(image) = screenshot.filter(|s| s.starts_with("data:image")) {
        for model in VISION_MODELS {
            match complete(&client, &key, model, trimmed, Some(image)) {
                Ok(reply) => return Ok(reply),
                Err(err) => eprintln!("[nim] vision {model}: {err}"),
            }
        }
    }

    let mut last = "No text model answered.".to_string();
    for model in TEXT_MODELS {
        match complete(&client, &key, model, trimmed, None) {
            Ok(reply) => return Ok(reply),
            Err(err) => {
                eprintln!("[nim] text {model}: {err}");
                last = err;
            }
        }
    }
    Err(format!("NVIDIA NIM did not return an answer. {last}"))
}

pub fn transcribe_wav(wav: &[u8]) -> Result<String, String> {
    if wav.len() < 64 {
        return Err("Nothing to transcribe.".into());
    }
    let key = load_key()?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|e| format!("Could not reach NVIDIA: {e}"))?;

    let mut last = "No speech model answered.".to_string();
    for model in TRANSCRIBE_MODELS {
        match transcribe_once(&client, &key, model, wav) {
            Ok(text) if !text.trim().is_empty() => return Ok(text.trim().to_string()),
            Ok(_) => last = format!("{model} returned empty text."),
            Err(err) => {
                eprintln!("[nim] stt {model}: {err}");
                last = err;
            }
        }
    }
    Err(format!("Could not transcribe speech. {last}"))
}

fn transcribe_once(
    client: &reqwest::blocking::Client,
    key: &str,
    model: &str,
    wav: &[u8],
) -> Result<String, String> {
    let part = reqwest::blocking::multipart::Part::bytes(wav.to_vec())
        .file_name("speech.wav")
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?;
    let form = reqwest::blocking::multipart::Form::new()
        .text("model", model.to_string())
        .text("language", "en")
        .part("file", part);

    let response = client
        .post(TRANSCRIBE_URL)
        .bearer_auth(key)
        .multipart(form)
        .send()
        .map_err(|e| format!("Network error: {e}"))?;

    let status = response.status();
    let body = response.text().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("{status}: {}", body.chars().take(180).collect::<String>()));
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Bad STT JSON: {e}"))?;
    parsed
        .get("text")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "STT response had no text.".into())
}

fn complete(
    client: &reqwest::blocking::Client,
    key: &str,
    model: &str,
    question: &str,
    image: Option<&str>,
) -> Result<NimReply, String> {
    let prompt = format!(
        "{question}\n\nUse the screenshot. If a control should be clicked, set target to its box as 0-1 fractions of the image."
    );
    let user = if let Some(url) = image {
        serde_json::json!([
            { "type": "image_url", "image_url": { "url": url } },
            { "type": "text", "text": prompt }
        ])
    } else {
        serde_json::Value::String(prompt)
    };

    let payload = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": SYSTEM },
            { "role": "user", "content": user }
        ],
        "temperature": 0.2,
        "top_p": 0.7,
        "max_tokens": 700,
        "stream": false
    });

    let response = client
        .post(NIM_URL)
        .bearer_auth(key)
        .header("Accept", "application/json")
        .json(&payload)
        .send()
        .map_err(|e| format!("Network error: {e}"))?;

    let status = response.status();
    let body = response.text().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("{status}: {}", body.chars().take(180).collect::<String>()));
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Bad NIM JSON: {e}"))?;
    let content = parsed["choices"][0]["message"]["content"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "NIM returned an empty answer.".to_string())?;

    Ok(parse_reply(content))
}

fn parse_reply(raw: &str) -> NimReply {
    let cleaned = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```markdown")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    if let Some(json) = extract_json(cleaned) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&json) {
            let answer = value
                .get("answer")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(cleaned)
                .to_string();
            let advice = value
                .get("advice")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .unwrap_or("Click Indicate if you want me to point at it.")
                .to_string();
            return NimReply {
                answer,
                advice,
                target: parse_target(value.get("target")),
            };
        }
    }

    let lines: Vec<&str> = cleaned.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    if lines.len() > 1 {
        let last = *lines.last().unwrap();
        if last.len() < 120 && !last.starts_with('#') {
            return NimReply {
                answer: lines[..lines.len() - 1].join("\n"),
                advice: last.trim_start_matches('*').trim().to_string(),
                target: None,
            };
        }
    }
    NimReply {
        answer: cleaned.to_string(),
        advice: "Click Indicate if you want me to point at it.".into(),
        target: None,
    }
}

fn extract_json(raw: &str) -> Option<String> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    if end <= start {
        return None;
    }
    Some(raw[start..=end].to_string())
}

fn parse_target(value: Option<&serde_json::Value>) -> Option<ClickTarget> {
    let value = value?;
    if value.is_null() {
        return None;
    }
    let x = norm(value.get("x")?.as_f64()?);
    let y = norm(value.get("y")?.as_f64()?);
    let mut w = norm(value.get("w").and_then(|v| v.as_f64()).unwrap_or(0.04));
    let mut h = norm(value.get("h").and_then(|v| v.as_f64()).unwrap_or(0.05));
    if w < 0.012 {
        w = 0.04;
    }
    if h < 0.012 {
        h = 0.045;
    }
    if x > 0.995 || y > 0.995 {
        return None;
    }
    let label = value
        .get("label")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("here")
        .to_string();
    Some(ClickTarget { label, x, y, w, h })
}

/// Models sometimes return percents (0-100) or pixels. Fold everything onto 0..1.
fn norm(value: f64) -> f64 {
    if value > 1.5 && value <= 100.0 {
        (value / 100.0).clamp(0.0, 1.0)
    } else if value > 100.0 {
        (value / 1280.0).clamp(0.0, 1.0)
    } else {
        value.clamp(0.0, 1.0)
    }
}

fn load_key() -> Result<String, String> {
    for name in [
        "NVIDIA_API_KEY",
        "NVIDIA_NIM_API_KEY",
        "VITE_NVIDIA_API_KEY",
        "VITE_NVIDIA_NIM_API_KEY",
    ] {
        if let Ok(value) = std::env::var(name) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }
    }
    for path in env_paths() {
        if let Some(key) = key_from_file(&path) {
            return Ok(key);
        }
    }
    Err("Found no NVIDIA API key. Put VITE_NVIDIA_API_KEY in pointy-software/.env and restart.".into())
}

fn env_paths() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        dirs.push(cwd.clone());
        if let Some(parent) = cwd.parent() {
            dirs.push(parent.to_path_buf());
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.to_path_buf());
            if let Some(parent) = dir.parent() {
                dirs.push(parent.to_path_buf());
                if let Some(grand) = parent.parent() {
                    dirs.push(grand.to_path_buf());
                }
            }
        }
    }
    let mut paths = Vec::new();
    for dir in dirs {
        paths.push(dir.join(".env"));
        paths.push(dir.join(".env.local"));
    }
    paths
}

fn key_from_file(path: &PathBuf) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if !matches!(
            key,
            "NVIDIA_API_KEY" | "NVIDIA_NIM_API_KEY" | "VITE_NVIDIA_API_KEY" | "VITE_NVIDIA_NIM_API_KEY"
        ) {
            continue;
        }
        let value = value.trim().trim_matches('"').trim_matches('\'');
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

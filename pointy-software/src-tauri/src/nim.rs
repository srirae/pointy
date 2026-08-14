//! NVIDIA NIM from Rust — reads `.env` off disk and calls the API without CORS.
//!
//! The key must never reach the webview: Vite inlines `VITE_*` vars into the bundle
//! at build time, so a browser-side key would ship inside the installer. Only
//! unprefixed names are accepted here, and this module is the single source of truth.

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

const SYSTEM: &str = r#"You are Pointy, a screen guide. You receive a screenshot taken at the moment the user sent their question, cropped to the app they chose to work on. Pointy's own glass was hidden for that shot.

Respond with ONLY valid JSON (no markdown fences, no extra text):
{"answer":"2-5 short sentences. Bold UI names with **double asterisks**.","advice":"one short next step","target":{"label":"Editor","x":0.22,"y":0.12,"w":0.55,"h":0.70}}

Rules:
- Answer for the app in the image (Cursor, VS Code, Chrome, Word, Explorer, …). Describe only controls you can actually see.
- Never mention Pointy, never describe Pointy's glass panel, never tell the user to click Pointy.
- If a frosted panel labeled Pointy is somehow in the image, ignore it completely.
- "Cursor" means the Cursor code editor (like VS Code). Where to type code is the large editor pane in the center — not a mouse pointer, not Pointy, not the window title.
- Cursor's chat/composer is usually a right-hand sidebar or a bar at the bottom. The file editor is the big center text area. Use the screenshot to choose the one they asked about.
- Do not invent buttons or menus that are not visible.
- answer and advice are plain sentences only. Never put JSON, coordinates, or the word Target in them.
- target is the EXACT bounding box of the UI element they asked about, as fractions 0-1 of the image: x,y = top-left, w,h = width and height. A glowing border is drawn on those edges, so the box must hug the control — not a tiny marker, not a random corner, not the whole image.
- Never set target to Pointy or this assistant's panel.
- If you cannot see a clickable control, set "target": null and still answer from what you can see."#;

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

pub fn ask_screen(
    question: &str,
    screenshot: Option<&str>,
    app: Option<&str>,
) -> Result<NimReply, String> {
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

    let subject = app.map(str::trim).filter(|s| !s.is_empty());

    if let Some(image) = screenshot.filter(|s| s.starts_with("data:image")) {
        for model in VISION_MODELS {
            match complete(&client, &key, model, trimmed, Some(image), subject) {
                Ok(reply) => return Ok(reply),
                Err(err) => eprintln!("[nim] vision {model}: {err}"),
            }
        }
    }

    let mut last = "No text model answered.".to_string();
    for model in TEXT_MODELS {
        match complete(&client, &key, model, trimmed, None, subject) {
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
    app: Option<&str>,
) -> Result<NimReply, String> {
    let subject = match app {
        Some(name) => format!("The user is working in {name}. "),
        None => String::new(),
    };
    let prompt = format!(
        "{subject}The user asked: {question}\n\nThis screenshot is what they are looking at right now. Answer where to click. target must be that element's exact box (0-1 fractions of this image). JSON only."
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
            let answer = scrub_visible(
                value
                    .get("answer")
                    .and_then(|v| v.as_str())
                    .unwrap_or(""),
            );
            let advice = scrub_visible(
                value
                    .get("advice")
                    .and_then(|v| v.as_str())
                    .unwrap_or(""),
            );
            if !answer.is_empty() {
                return NimReply {
                    answer,
                    advice: if is_cta_advice(&advice) {
                        String::new()
                    } else {
                        advice
                    },
                    target: parse_target(value.get("target")),
                };
            }
        }
    }

    let visible = scrub_visible(cleaned);
    if visible.is_empty() {
        return NimReply {
            answer: "I can see the screen, but I could not read a clear answer. Ask again in a few words.".into(),
            advice: String::new(),
            target: None,
        };
    }
    NimReply {
        answer: visible,
        advice: String::new(),
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
    if label.to_lowercase().contains("pointy") {
        return None;
    }
    Some(ClickTarget { label, x, y, w, h })
}

/// Drop leaked JSON / "Target:" dumps so the glass never shows model plumbing.
fn scrub_visible(text: &str) -> String {
    let mut s = text.trim().to_string();
    if let Some(idx) = s.to_lowercase().find("target:") {
        s.truncate(idx);
    }
    if let Some(idx) = s.find("```") {
        s.truncate(idx);
    }
    if let Some(idx) = s.rfind('{') {
        let tail = &s[idx..];
        if tail.contains("\"label\"") || tail.contains("\"x\"") || tail.contains("\"advice\"") {
            s.truncate(idx);
        }
    }
    s.split('\n')
        .map(str::trim)
        .filter(|line| {
            if line.is_empty() {
                return false;
            }
            let lower = line.to_lowercase();
            !lower.starts_with("click indicate")
                && !lower.contains("if you want me to point")
                && !line.starts_with('{')
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn is_cta_advice(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.is_empty()
        || lower.contains("indicate")
        || lower.contains("point it")
        || lower.contains('{')
        || lower.contains("target:")
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
    for name in ["NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY"] {
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
    Err("Found no NVIDIA API key. Put NVIDIA_API_KEY in pointy-software/.env and restart.".into())
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
        if !matches!(key, "NVIDIA_API_KEY" | "NVIDIA_NIM_API_KEY") {
            continue;
        }
        let value = value.trim().trim_matches('"').trim_matches('\'');
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

//! AI calls from Rust — reads `.env` off disk and calls the API without CORS.
//!
//! Chat, vision and speech-to-text run through a cascade of free-tier providers
//! (Groq, Gemini, OpenRouter); whichever free keys are present are used, fastest
//! first. The keys must never reach the
//! webview: Vite inlines `VITE_*` vars into the bundle at build time, so a
//! browser-side key would ship inside the installer. Only unprefixed names are
//! accepted here, and this module is the single source of truth.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// One free-tier provider. Providers are tried in order and skipped when their
/// key is absent, so Pointy works with whichever free keys the user has added.
struct Provider {
    name: &'static str,
    url: &'static str,
    keys: &'static [&'static str],
    vision: &'static [&'static str],
    text: &'static [&'static str],
    /// Some providers reject `response_format: json_object`; omit it for them.
    json_mode: bool,
    /// Disable the model's internal reasoning so the answer is fast, clean and
    /// never leaks a `<think>` chain into the chat or the spoken reply.
    no_think: bool,
}

const PROVIDERS: &[Provider] = &[
    Provider {
        name: "groq",
        url: "https://api.groq.com/openai/v1/chat/completions",
        keys: &["GROQ_API_KEY"],
        vision: &["qwen/qwen3.6-27b"],
        text: &["llama-3.3-70b-versatile"],
        // qwen3.6's thinking mode makes Groq's json_object validation fail with
        // a 400; the parser handles plain JSON text anyway, so don't force it.
        json_mode: false,
        no_think: true,
    },
    Provider {
        name: "gemini",
        url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        keys: &["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        vision: &["gemini-3.6-flash"],
        text: &["gemini-3.6-flash", "gemini-3.5-flash-lite"],
        json_mode: false,
        no_think: false,
    },
    Provider {
        name: "openrouter",
        url: "https://openrouter.ai/api/v1/chat/completions",
        keys: &["OPEN_ROUTER_API_KEY", "OPENROUTER_API_KEY"],
        vision: &[
            "google/gemma-4-26b-a4b-it:free",
            "google/gemma-4-31b-it:free",
            "nvidia/nemotron-nano-12b-v2-vl:free",
        ],
        text: &["google/gemma-4-26b-a4b-it:free"],
        json_mode: true,
        no_think: false,
    },
];

/// Providers whose last call hit a rate limit or a dead connection are skipped
/// for a few seconds so the cascade does not re-hammer a hot free pool on every
/// click and heartbeat. Cleared lazily as the cooldown expires.
static COOLDOWNS: Mutex<Option<HashMap<&'static str, Instant>>> = Mutex::new(None);

fn in_cooldown(name: &'static str) -> bool {
    let mut guard = COOLDOWNS.lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    match map.get(name) {
        Some(until) if *until > Instant::now() => true,
        Some(_) => {
            map.remove(name);
            false
        }
        None => false,
    }
}

fn mark_cooldown(name: &'static str) {
    COOLDOWNS
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(name, Instant::now() + Duration::from_secs(8));
}

/// Free-tier speech-to-text providers, tried fastest-first. Groq's Whisper is
/// free and fast; NVIDIA remains a fallback for users who already have that key.
struct SttProvider {
    name: &'static str,
    url: &'static str,
    keys: &'static [&'static str],
    models: &'static [&'static str],
}

const STT_PROVIDERS: &[SttProvider] = &[
    SttProvider {
        name: "groq",
        url: "https://api.groq.com/openai/v1/audio/transcriptions",
        keys: &["GROQ_API_KEY"],
        models: &["whisper-large-v3-turbo", "whisper-large-v3"],
    },
    SttProvider {
        name: "nvidia",
        url: "https://integrate.api.nvidia.com/v1/audio/transcriptions",
        keys: &["NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY"],
        models: &[
            "openai/whisper-large-v3",
            "nvidia/whisper-large-v3",
            "nvidia/parakeet-tdt-0.6b-v2",
        ],
    },
];

/// One shared client so each question reuses the TLS connection instead of
/// paying a fresh handshake per request.
fn client() -> &'static reqwest::blocking::Client {
    static CLIENT: OnceLock<reqwest::blocking::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::blocking::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .pool_idle_timeout(Duration::from_secs(120))
            .build()
            .expect("build the HTTP client")
    })
}

/// Flatten the full error chain so a bare "error sending request" log also
/// shows *why* (DNS, timeout, connection reset, TLS …).
fn describe_error(err: &reqwest::Error) -> String {
    let mut parts = vec![err.to_string()];
    let mut source = std::error::Error::source(err);
    while let Some(next) = source {
        parts.push(next.to_string());
        source = std::error::Error::source(next);
    }
    parts.join(": ")
}

/// POST to a provider with one bounded retry. Retries transport errors and
/// 429/5xx — the free tier rate-limits often — then parks the provider in a
/// short cooldown instead of hammering it.
fn post_json(
    url: &str,
    payload: &serde_json::Value,
    key: &str,
    provider: &'static str,
) -> Result<String, String> {
    let mut last_err = String::new();
    for attempt in 0..2 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(250));
            eprintln!("[nim] retry {attempt} after: {last_err}");
        }
        let response = match client()
            .post(url)
            .bearer_auth(key)
            .header("Accept", "application/json")
            .header("X-Title", "Pointy")
            .json(payload)
            .send()
        {
            Ok(response) => response,
            Err(err) => {
                last_err = describe_error(&err);
                mark_cooldown(provider);
                continue;
            }
        };
        let status = response.status();
        let body = response.text().map_err(|e| e.to_string())?;
        if status.is_success() {
            return Ok(body);
        }
        last_err = format!("{status}: {}", body.chars().take(180).collect::<String>());
        let retryable =
            status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error();
        if !retryable {
            mark_cooldown(provider);
            return Err(last_err);
        }
    }
    mark_cooldown(provider);
    Err(last_err)
}

const SYSTEM: &str = r#"You are Pointy, a screen guide. You receive a screenshot taken at the moment the user sent their question, cropped to the app they chose to work on. Pointy's own glass was hidden for that shot.

Respond with ONLY valid JSON (no markdown fences, no extra text):
{"answer":"1-2 short sentences. Bold UI names with **double asterisks**.","advice":"one short next step","multi_step":false,"target":{"label":"Send","x":0.22,"y":0.12,"w":0.08,"h":0.04}}

Rules:
- Answer for the app in the image (Cursor, VS Code, Chrome, Word, Explorer, …). Describe only controls you can actually see.
- Never mention Pointy, never describe Pointy's glass panel, never tell the user to click Pointy.
- If a frosted panel labeled Pointy is somehow in the image, ignore it completely.
- "Cursor" means the Cursor code editor (like VS Code). Where to type code is the large editor pane in the center — not a mouse pointer, not Pointy, not the window title.
- Cursor's chat/composer is usually a right-hand sidebar or a bar at the bottom. The file editor is the big center text area. Use the screenshot to choose the one they asked about.
- Do not invent buttons or menus that are not visible.
- Be kind and plain-spoken: short sentences, no jargon. Assume the reader may not know technical terms.
- answer and advice are plain sentences only. Never put JSON, coordinates, or the word Target in them.
- label is the control's short, exact name as the app calls it (e.g. "Send", "New chat", "Run", "Close"), so Pointy can match it against the real UI.
- target is the EXACT bounding box of the UI element they asked about, as fractions 0-1 of the image: x,y = top-left, w,h = width and height. A glowing border is drawn on those edges, so the box must hug the control — not a tiny marker, not a random corner, not the whole image.
- Never set target to Pointy or this assistant's panel.
- If you cannot see a clickable control, set "target": null and still answer from what you can see.
- Set "multi_step": true only when finishing the task needs more than one action (filling out a form, signing up, joining a call). For a single click or a simple question, set false. When true, the answer should state only the first step, in one short plain sentence."#;

const WALKTHROUGH_SYSTEM: &str = r#"You are Pointy, a patient guide helping someone finish a task one step at a time. The user may be older or less comfortable with computers. Be warm and plain-spoken — short words, no jargon.

Respond with ONLY valid JSON (no markdown fences, no extra text):
{"status":"next","say":"one short plain sentence telling the single next action","target":{"label":"Continue","x":0.1,"y":0.2,"w":0.08,"h":0.04}}
When the task is already finished, respond:
{"status":"done","say":"one warm short sentence saying it is finished","target":null}

Rules:
- One action at a time. Never list more than one step.
- say is one short sentence, at most ~15 words, meant to be spoken aloud.
- target is the EXACT bounding box of the element to act on next, as 0-1 fractions of the image. null when there is nothing to click.
- label is the element's short, exact name as the app calls it.
- Never mention Pointy. Never tell the user to click Pointy.
- If the task is already finished in this screenshot, return status "done"."#;

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
    pub multi_step: bool,
    pub target: Option<ClickTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuideReply {
    pub status: String,
    pub say: String,
    pub target: Option<ClickTarget>,
}

pub fn ask_screen(
    question: &str,
    screenshot: Option<&str>,
    app: Option<&str>,
    image_dims: Option<(u32, u32)>,
) -> Result<NimReply, String> {
    let trimmed = question.trim();
    if trimmed.is_empty() {
        return Ok(NimReply {
            answer: "Say or type what you want to do on this screen.".into(),
            advice: "Hold your hotkey and speak, or type your question.".into(),
            multi_step: false,
            target: None,
        });
    }

    let subject = app.map(str::trim).filter(|s| !s.is_empty());
    let image = screenshot.filter(|s| s.starts_with("data:image"));

    let mut last = "No free model answered.".to_string();
    for provider in PROVIDERS {
        if in_cooldown(provider.name) {
            continue;
        }
        let key = match load_key(provider.keys, provider.name) {
            Ok(key) => key,
            Err(_) => continue,
        };
        let models: &[&str] = if image.is_some() { provider.vision } else { provider.text };
        for model in models {
            match complete(
                provider.url,
                provider.json_mode,
                &key,
                model,
                trimmed,
                image,
                subject,
                image_dims,
                provider.name,
                provider.no_think,
            ) {
                Ok(reply) => return Ok(reply),
                Err(err) => {
                    eprintln!("[nim] {} {model}: {err}", provider.name);
                    last = err;
                }
            }
        }
    }
    Err(format!("No free model answered. {last}"))
}

pub fn transcribe_wav(wav: &[u8]) -> Result<String, String> {
    if wav.len() < 64 {
        return Err("Nothing to transcribe.".into());
    }

    let mut last = "No speech model answered.".to_string();
    for provider in STT_PROVIDERS {
        let key = match load_key(provider.keys, provider.name) {
            Ok(key) => key,
            Err(_) => continue,
        };
        for model in provider.models {
            match transcribe_once(client(), provider.url, &key, model, wav) {
                Ok(text) if !text.trim().is_empty() => return Ok(text.trim().to_string()),
                Ok(_) => last = format!("{model} returned empty text."),
                Err(err) => {
                    eprintln!("[nim] stt {} {model}: {err}", provider.name);
                    last = err;
                }
            }
        }
    }
    Err(format!("Could not transcribe speech. {last}"))
}

fn transcribe_once(
    client: &reqwest::blocking::Client,
    url: &str,
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
        .post(url)
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
    url: &str,
    json_mode: bool,
    key: &str,
    model: &str,
    question: &str,
    image: Option<&str>,
    app: Option<&str>,
    dims: Option<(u32, u32)>,
    provider: &'static str,
    no_think: bool,
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

    // 512 leaves room for a thinking model's internal reasoning without
    // truncating the JSON answer.
    let mut payload = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": SYSTEM },
            { "role": "user", "content": user }
        ],
        "temperature": 0.2,
        "top_p": 0.7,
        "max_tokens": 512,
        "stream": false
    });
    if json_mode {
        payload["response_format"] = serde_json::json!({ "type": "json_object" });
    }
    if no_think {
        payload["reasoning_effort"] = serde_json::json!("none");
    }

    let body = post_json(url, &payload, key, provider)?;

    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Bad provider JSON: {e}"))?;
    let raw = parsed["choices"][0]["message"]["content"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "The model returned an empty answer.".to_string())?;
    let content = strip_think(raw);

    Ok(parse_reply(&content, dims))
}

/// Timestamps (epoch milliseconds) of one streamed model round-trip.
#[derive(Debug, Clone, Copy)]
pub struct StreamTimings {
    /// Request sent.
    pub t2: u128,
    /// First content token received (time-to-first-token).
    pub t3: u128,
    /// Full response received.
    pub t4: u128,
}

/// Like `next_step`, but streams the response so the first complete sentence
/// can be spoken before the rest has finished generating. `on_first_sentence`
/// is called exactly once, the moment the first sentence of the `say` field is
/// complete.
pub fn next_step_streaming(
    task: &str,
    screenshot: &str,
    step_number: u32,
    image_dims: Option<(u32, u32)>,
    on_first_sentence: &dyn Fn(&str),
) -> Result<(GuideReply, StreamTimings), String> {
    let image = screenshot.starts_with("data:image").then_some(screenshot);
    let prompt = format!(
        "Task: {task}\nThe user just finished the previous step. This is step {step_number}. This screenshot is the current state. Reply JSON only with the single next action, or \"done\" if the task is finished."
    );

    let mut last = "No free model answered.".to_string();
    for provider in PROVIDERS {
        if in_cooldown(provider.name) {
            continue;
        }
        let key = match load_key(provider.keys, provider.name) {
            Ok(key) => key,
            Err(_) => continue,
        };
        for model in provider.vision {
            match complete_guide_streaming(
                provider,
                &key,
                model,
                &prompt,
                image,
                image_dims,
                on_first_sentence,
            ) {
                Ok(pair) => return Ok(pair),
                Err(err) => {
                    eprintln!("[nim] stream {} {model}: {err}", provider.name);
                    last = err;
                }
            }
        }
    }
    Err(format!("No free model answered. {last}"))
}

fn complete_guide_streaming(
    provider: &'static Provider,
    key: &str,
    model: &str,
    prompt: &str,
    image: Option<&str>,
    dims: Option<(u32, u32)>,
    on_first_sentence: &dyn Fn(&str),
) -> Result<(GuideReply, StreamTimings), String> {
    let user = if let Some(image_url) = image {
        serde_json::json!([
            { "type": "image_url", "image_url": { "url": image_url } },
            { "type": "text", "text": prompt }
        ])
    } else {
        serde_json::Value::String(prompt.to_string())
    };

    let mut payload = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": WALKTHROUGH_SYSTEM },
            { "role": "user", "content": user }
        ],
        "temperature": 0.2,
        "top_p": 0.7,
        "max_tokens": 384,
        "stream": true
    });
    if provider.json_mode {
        payload["response_format"] = serde_json::json!({ "type": "json_object" });
    }
    if provider.no_think {
        payload["reasoning_effort"] = serde_json::json!("none");
    }

    let mut first_sent = false;
    let mut acc = String::new();
    let (content, t2, t3, t4) = post_stream(
        provider.url,
        &payload,
        key,
        provider.name,
        |delta| {
            acc.push_str(delta);
            if !first_sent {
                if let Some(sentence) = first_sentence_of_say(&acc) {
                    first_sent = true;
                    on_first_sentence(sentence.as_str());
                }
            }
        },
    )?;

    let content = strip_think(&content);
    let reply = parse_guide(&content, dims);
    Ok((reply, StreamTimings { t2, t3, t4 }))
}

/// POST with `stream: true` and fold the SSE deltas into the full content.
/// Returns (content, t2, t3, t4) — request-sent, first-token and full-response
/// timestamps in epoch milliseconds.
fn post_stream(
    url: &str,
    payload: &serde_json::Value,
    key: &str,
    provider: &'static str,
    mut on_delta: impl FnMut(&str),
) -> Result<(String, u128, u128, u128), String> {
    use std::io::Read;

    let t2 = crate::events::now_millis();
    let response = client()
        .post(url)
        .bearer_auth(key)
        .header("Accept", "application/json")
        .header("X-Title", "Pointy")
        .json(payload)
        .send()
        .map_err(|e| {
            mark_cooldown(provider);
            format!("Network error: {}", describe_error(&e))
        })?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().map_err(|e| e.to_string())?;
        mark_cooldown(provider);
        return Err(format!("{status}: {}", body.chars().take(180).collect::<String>()));
    }

    let mut full = String::new();
    let mut buf = String::new();
    let mut t3: Option<u128> = None;
    let mut reader = response;
    let mut chunk = [0u8; 4096];
    loop {
        let n = reader
            .read(&mut chunk)
            .map_err(|e| format!("Stream read error: {e}"))?;
        if n == 0 {
            break;
        }
        buf.push_str(&String::from_utf8_lossy(&chunk[..n]));
        while let Some(nl) = buf.find('\n') {
            let line: String = buf.drain(..=nl).collect();
            let line = line.trim();
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(delta) = value["choices"][0]["delta"]["content"].as_str() {
                    if !delta.is_empty() {
                        if t3.is_none() {
                            t3 = Some(crate::events::now_millis());
                        }
                        full.push_str(delta);
                        on_delta(delta);
                    }
                }
            }
        }
    }
    let t4 = crate::events::now_millis();
    Ok((full, t2, t3.unwrap_or(t4), t4))
}

/// Extract the first complete sentence of the streamed JSON's `say` field, if
/// it has finished yet. The raw stream accumulates as
/// `{"status":"next","say":"Click the blue...` — cut at the first sentence
/// terminator inside `say`.
fn first_sentence_of_say(acc: &str) -> Option<String> {
    let marker = "\"say\":\"";
    let idx = acc.find(marker)?;
    let start = idx + marker.len();
    let rest = &acc[start..];
    let mut end = None;
    for (i, ch) in rest.char_indices() {
        if ch == '.' || ch == '!' || ch == '?' {
            end = Some(i);
            break;
        }
    }
    let end = end?;
    let sentence = rest[..end + 1].trim();
    if sentence.is_empty() {
        return None;
    }
    let sentence = strip_think(sentence).trim().to_string();
    if sentence.is_empty() {
        None
    } else {
        Some(sentence)
    }
}

fn parse_guide(raw: &str, dims: Option<(u32, u32)>) -> GuideReply {
    let cleaned = raw
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```markdown")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    if let Some(json) = extract_json(cleaned) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&json) {
            let status = value
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("correct")
                .to_lowercase();
            let say = value
                .get("say")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .unwrap_or("")
                .to_string();
            if !say.is_empty() {
                return GuideReply {
                    status,
                    say,
                    target: parse_target(value.get("target"), dims),
                };
            }
        }
    }

    GuideReply {
        status: "correct".to_string(),
        say: scrub_visible(cleaned),
        target: None,
    }
}

fn parse_reply(raw: &str, dims: Option<(u32, u32)>) -> NimReply {
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
                    multi_step: value
                        .get("multi_step")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                    target: parse_target(value.get("target"), dims),
                };
            }
        }
    }

    let visible = scrub_visible(cleaned);
    if visible.is_empty() {
        return NimReply {
            answer: "I can see the screen, but I could not read a clear answer. Ask again in a few words.".into(),
            advice: String::new(),
            multi_step: false,
            target: None,
        };
    }
    NimReply {
        answer: visible,
        advice: String::new(),
        multi_step: false,
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

fn parse_target(
    value: Option<&serde_json::Value>,
    dims: Option<(u32, u32)>,
) -> Option<ClickTarget> {
    let value = value?;
    if value.is_null() {
        return None;
    }
    let (dw, dh) = dims.unwrap_or((1280, 1280));
    let x = norm(value.get("x")?.as_f64()?, dw as f64);
    let y = norm(value.get("y")?.as_f64()?, dh as f64);
    let mut w = norm(value.get("w").and_then(|v| v.as_f64()).unwrap_or(0.04), dw as f64);
    let mut h = norm(value.get("h").and_then(|v| v.as_f64()).unwrap_or(0.05), dh as f64);
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

/// Remove `<think>...</think>` reasoning blocks that a model may have leaked
/// into the visible content (Qwen/Gemma thinking modes do this). Case-insensitive,
/// and an unclosed `<think>` swallows the rest so nothing raw reaches the glass
/// or the spoken reply.
fn strip_think(text: &str) -> String {
    let lower = text.to_lowercase();
    let bytes = text.as_bytes();
    let mut depth = 0usize;
    let mut out = String::with_capacity(text.len());
    let mut i = 0usize;
    while i < bytes.len() {
        let rest = &lower[i..];
        if let Some(tail) = rest.strip_prefix("<think") {
            depth += 1;
            i += "<think".len();
            // Skip the rest of the opening tag if there is one.
            if let Some(gt) = tail.find('>') {
                i += gt + 1;
            }
            continue;
        }
        if let Some(tail) = rest.strip_prefix("</think") {
            if depth > 0 {
                depth -= 1;
            }
            i += "</think".len();
            if let Some(gt) = tail.find('>') {
                i += gt + 1;
            }
            continue;
        }
        if depth == 0 {
            out.push(bytes[i] as char);
        }
        i += 1;
    }
    out.trim().to_string()
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

/// Models sometimes return percents (0-100) or pixels. Fold everything onto 0..1,
/// using the real dimensions of the image we sent rather than a hardcoded width.
fn norm(value: f64, denom: f64) -> f64 {
    if value > 100.0 {
        (value / denom.max(1.0)).clamp(0.0, 1.0)
    } else if value > 1.5 {
        (value / 100.0).clamp(0.0, 1.0)
    } else {
        value.clamp(0.0, 1.0)
    }
}

fn load_key(names: &[&str], provider: &str) -> Result<String, String> {
    for name in names {
        if let Ok(value) = std::env::var(name) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }
    }
    for path in env_paths() {
        if let Some(key) = key_from_file(&path, names) {
            return Ok(key);
        }
    }
    Err(format!(
        "Found no {provider} API key. Put {} in pointy-software/.env and restart.",
        names[0]
    ))
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

fn key_from_file(path: &PathBuf, names: &[&str]) -> Option<String> {
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
        if !names.contains(&key) {
            continue;
        }
        let value = value.trim().trim_matches('"').trim_matches('\'');
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    /// Real end-to-end timing: capture + downscale + OpenRouter round-trip.
    /// Ignored by default — run with:
    ///   cargo test end_to_end_timing -- --ignored --nocapture
    #[test]
    #[ignore]
    fn end_to_end_timing() {
        let t0 = Instant::now();
        let shot = crate::capture::capture_ask(None, 1280).expect("screen capture");
        println!(
            "[timing] capture+downscale+encode: {:?} ({}x{}, {} chars)",
            t0.elapsed(),
            shot.width,
            shot.height,
            shot.image.len()
        );

        let t1 = Instant::now();
        let reply = ask_screen(
            "What app is on screen? Answer where to click to close the active window.",
            Some(&shot.image),
            None,
            Some((shot.width, shot.height)),
        );
        println!("[timing] model round-trip: {:?}", t1.elapsed());
        match &reply {
            Ok(r) => {
                println!("[answer] {}", r.answer);
                println!("[target] {:?}", r.target);
            }
            Err(e) => println!("[error] {e}"),
        }
        assert!(reply.is_ok(), "OpenRouter round-trip failed");
    }

    /// Walkthrough smoke test: one streamed "what is the next step" round-trip.
    /// Ignored by default — run with:
    ///   cargo test next_step_smoke -- --ignored --nocapture
    #[test]
    #[ignore]
    fn next_step_smoke() {
        let shot = crate::capture::capture_ask(None, 1280).expect("screen capture");
        let t0 = Instant::now();
        let reply = next_step_streaming(
            "Help me send an email.",
            &shot.image,
            2,
            Some((shot.width, shot.height)),
            &|sentence| println!("[next_step first sentence] {sentence}"),
        );
        println!("[next_step timing] round-trip: {:?}", t0.elapsed());
        match &reply {
            Ok((r, timings)) => {
                println!(
                    "[next_step timings] t2={} t3={} t4={} first_token={}ms generation={}ms",
                    timings.t2,
                    timings.t3,
                    timings.t4,
                    timings.t3.saturating_sub(timings.t2),
                    timings.t4.saturating_sub(timings.t3)
                );
                println!("[next_step status] {}", r.status);
                println!("[next_step say] {}", r.say);
                println!("[next_step target] {:?}", r.target);
            }
            Err(e) => println!("[next_step error] {e}"),
        }
        assert!(reply.is_ok(), "next_step round-trip failed");
    }

    /// Full Part-3 cycle: trigger a real accessibility event, then flow through
    /// capture → streamed model call → dot → TTS, logging the LATENCY line.
    /// Run with:
    ///   cargo test latency_cycle -- --ignored --nocapture
    #[test]
    #[ignore]
    fn latency_cycle() {
        use std::sync::{Arc, Mutex};

        // T0: register listeners, then cause a genuine UI change.
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let listener = crate::events::listen(
            None,
            Arc::new(move |_kind| {
                let _ = tx.send(());
            }),
        )
        .expect("register a11y listeners");
        std::thread::sleep(Duration::from_millis(600));
        let mut child = std::process::Command::new("notepad.exe")
            .spawn()
            .expect("spawn notepad");
        let t0 = rx
            .recv_timeout(Duration::from_secs(8))
            .map(|_| crate::events::now_millis())
            .expect("no a11y event fired");

        // T1: capture, cropped to the focused window.
        let window = crate::uia::foreground_window();
        let shot = crate::capture::capture_ask(window, 1280).expect("capture");
        let t1 = crate::events::now_millis();

        // T2..T4 (from the stream) + T6 (first sentence spoken).
        let t6: Arc<Mutex<Option<u128>>> = Arc::new(Mutex::new(None));
        let t6_clone = t6.clone();
        let result = crate::nim::next_step_streaming(
            "Help me write a short note.",
            &shot.image,
            2,
            Some((shot.width, shot.height)),
            &move |sentence| {
                *t6_clone.lock().unwrap() = Some(crate::events::now_millis());
                eprintln!("[latency] T6 speak (first sentence): {sentence}");
                let text = sentence.to_string();
                std::thread::spawn(move || {
                    let _ = crate::tts::speak(&text);
                });
            },
        );
        let (reply, timings) = result.expect("streamed next_step");

        // T5: resolve the dot against the real accessibility tree (logs POSITION).
        if let (Some(target), Some(id)) = (reply.target.as_ref(), window) {
            let _ = crate::uia::resolve(id, &shot, target);
        }
        let t5 = crate::events::now_millis();
        let t6v = t6.lock().unwrap().unwrap_or(timings.t4);

        println!("[latency reply] status={} say={}", reply.status, reply.say);
        crate::events::log_latency(t0, t1, timings.t2, timings.t3, timings.t4, t5, t6v);

        let _ = child.kill();
        listener.stop();
    }
}

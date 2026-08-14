//! Local usage tracking — the always-free second feature.
//!
//! A background thread attributes the foreground window to its app every two
//! seconds and persists the totals to a JSON file. "How long did I spend on X?"
//! is answered from this data with no cloud call at all.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

const TICK_SECS: u64 = 2;
const FLUSH_TICKS: u32 = 15; // write to disk every ~30s

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UsageData {
    /// app name or window title (lowercased) -> lifetime seconds.
    pub total: BTreeMap<String, u64>,
    /// same, but for the current day only.
    pub today: BTreeMap<String, u64>,
    /// days since the Unix epoch, so "today" rolls over without a date lib.
    pub day: u64,
}

pub struct UsageTracker {
    data: Arc<Mutex<UsageData>>,
    path: PathBuf,
}

impl UsageTracker {
    pub fn new(path: PathBuf) -> Self {
        let data = load(&path);
        let tracker = Self {
            data: Arc::new(Mutex::new(data)),
            path,
        };
        tracker.spawn();
        tracker
    }

    pub fn snapshot(&self) -> UsageData {
        self.data.lock().map(|d| d.clone()).unwrap_or_default()
    }

    fn spawn(&self) {
        let data = self.data.clone();
        let path = self.path.clone();
        std::thread::Builder::new()
            .name("pointy-usage".into())
            .spawn(move || {
                let mut ticks = 0u32;
                loop {
                    std::thread::sleep(Duration::from_secs(TICK_SECS));
                    let app = focused_name();
                    {
                        let mut d = data.lock().unwrap();
                        let day = today_key();
                        if d.day != day {
                            d.day = day;
                            d.today.clear();
                        }
                        if let Some(name) = app {
                            *d.total.entry(name.clone()).or_insert(0) += TICK_SECS;
                            *d.today.entry(name).or_insert(0) += TICK_SECS;
                        }
                    }
                    ticks += 1;
                    if ticks % FLUSH_TICKS == 0 {
                        let snapshot = data.lock().unwrap().clone();
                        let _ = save(&path, &snapshot);
                    }
                }
            })
            .ok();
    }
}

/// Answer "how long did I spend on X?" from the local data, or None when the
/// question is not a usage question or nothing matches.
pub fn answer_usage(question: &str, data: &UsageData) -> Option<String> {
    let q = question.to_lowercase();
    if !is_usage_question(&q) {
        return None;
    }

    let mut matches: Vec<(&str, u64, u64)> = data
        .total
        .iter()
        .filter(|(name, _)| name_mentioned(&q, name))
        .map(|(name, total)| {
            let today = data.today.get(name).copied().unwrap_or(0);
            (name.as_str(), *total, today)
        })
        .collect();

    if matches.is_empty() {
        return None;
    }

    matches.sort_by(|a, b| b.2.cmp(&a.2));
    let lines: Vec<String> = matches
        .into_iter()
        .take(3)
        .map(|(name, total, today)| {
            format!(
                "**{}** — {} today, {} all time.",
                name,
                fmt_duration(today),
                fmt_duration(total)
            )
        })
        .collect();

    Some(format!(
        "Here's what I've tracked on this device:\n{}",
        lines.join("\n")
    ))
}

fn is_usage_question(q: &str) -> bool {
    [
        "how long",
        "how much time",
        "spend",
        "spent",
        "time on",
        "screen time",
        "usage",
    ]
    .iter()
    .any(|phrase| q.contains(phrase))
}

const STOPWORDS: &[&str] = &[
    "how", "long", "did", "you", "spend", "spent", "time", "much", "on", "the",
    "have", "been", "using", "use", "usage", "what", "which", "apps", "app",
    "screen", "tell", "me", "my", "this", "that", "day", "today", "all", "for",
];

fn name_mentioned(q: &str, name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    if q.contains(name) || name.contains(q) {
        return true;
    }
    q.split(|c: char| !c.is_alphanumeric())
        .filter(|word| word.len() >= 3 && !STOPWORDS.contains(word))
        .any(|word| name.contains(word))
}

fn fmt_duration(secs: u64) -> String {
    let hours = secs / 3600;
    let minutes = (secs % 3600) / 60;
    if hours > 0 {
        format!("{hours}h {minutes}m")
    } else if minutes > 0 {
        format!("{minutes}m")
    } else {
        format!("{secs}s")
    }
}

fn focused_name() -> Option<String> {
    let windows = xcap::Window::all().ok()?;
    let focused = windows
        .into_iter()
        .find(|w| w.is_focused().unwrap_or(false))?;
    let title = focused.title().ok()?.trim().to_string();
    let name = if title.is_empty() {
        focused.app_name().ok()?
    } else {
        title
    };
    let lower = name.to_lowercase();
    if lower.contains("pointy") {
        return None;
    }
    Some(lower)
}

fn today_key() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0)
}

fn load(path: &PathBuf) -> UsageData {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save(path: &PathBuf, data: &UsageData) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

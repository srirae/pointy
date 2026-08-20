//! Live microphone input: device enumeration and a level/band stream for the UI.
//!
//! The capture thread owns the cpal stream (a WASAPI stream is not `Send`, so it must
//! be built and dropped on the same thread) and does nothing but copy mono samples
//! into a ring buffer. A second loop on that thread runs the FFT and emits
//! `mic://level` at ~60 Hz. Keeping the transform out of the audio callback is what
//! Phase 3's wake-word listener will need too: the callback stays realtime-safe and
//! consumers read frames at their own pace.

use std::collections::VecDeque;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{ErrorKind, SampleFormat, StreamConfig};
use rustfft::num_complex::Complex32;
use rustfft::FftPlanner;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Bars in the visualiser. Matches `barCount` on the AgentAudioVisualizerBar.
pub const BANDS: usize = 5;
const FFT_SIZE: usize = 1024;
const EMIT_INTERVAL: Duration = Duration::from_millis(16);
/// Deepgram is fed the most recent 20s of a hold; anything older is dropped.
const MAX_RECORD_SECONDS: usize = 20;
/// Hard ceiling for one record session. A missed hotkey-up or a hung webview
/// flush must never hold the device longer than this; the watchdog force-closes
/// the session and emits `mic://stopped` so the UI can react.
const RECORD_CAP: Duration = Duration::from_secs(30);
/// The transcript pipeline needs the sample rate to build a WAV.
const TARGET_RATE: u32 = 16_000;

/// Voice-relevant band edges in Hz — six edges, five bands.
const BAND_EDGES_HZ: [f32; BANDS + 1] = [80.0, 250.0, 600.0, 1400.0, 3000.0, 6500.0];

/// Floor for the dB → 0..1 mapping. Anything quieter than this reads as silence.
const NOISE_FLOOR_DB: f32 = -62.0;
/// Rise fast so a spoken syllable registers immediately, fall slowly so the bars
/// read as a level meter instead of flickering.
const ATTACK: f32 = 0.55;
const RELEASE: f32 = 0.13;

#[derive(Debug, Clone, Serialize)]
pub struct AudioDevice {
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize)]
struct MicLevel {
    /// Per-band magnitudes, 0..1, ready to hand to the visualiser.
    bands: [f32; BANDS],
    /// Overall input level, 0..1. Used for the "we hear nothing" hint.
    level: f32,
    device: String,
}

/// Who holds the microphone right now. Only one capture stream may exist, and
/// starting a new use evicts the previous owner (logged, never silent).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MicUse {
    /// Live level/band stream for the visualisers.
    Levels,
    /// A dictation session: levels plus a WAV of the hold for Deepgram.
    Record,
}

impl std::fmt::Display for MicUse {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MicUse::Levels => write!(f, "levels"),
            MicUse::Record => write!(f, "record"),
        }
    }
}

/// What the capture thread is asked to do.
enum CaptureMode {
    /// Levels only.
    Levels,
    /// Levels plus a rolling WAV of the session, drained by `snapshot_record`
    /// (interim transcription) or `stop_record` (final flush).
    Record { session: Arc<Mutex<RecordBuffer>> },
}

/// Rolling mono samples of the current hold, capped at `MAX_RECORD_SECONDS`.
/// Written by the capture thread, read (locked) by snapshot/stop commands.
struct RecordBuffer {
    samples: Vec<f32>,
    /// Device sample rate, set once the stream is configured.
    rate: u32,
}

impl RecordBuffer {
    fn new() -> Self {
        Self {
            samples: Vec::new(),
            rate: 0,
        }
    }

    fn set_rate(&mut self, rate: u32) {
        self.rate = rate;
    }

    fn push(&mut self, mono: &[f32], rate: u32) {
        self.rate = rate;
        self.samples.extend_from_slice(mono);
        let max = rate as usize * MAX_RECORD_SECONDS;
        if self.samples.len() > max {
            self.samples.drain(..(self.samples.len() - max));
        }
    }

    /// Encode what has been captured so far as a mono 16 kHz WAV, base64-encoded
    /// for the webview's transcription command. Empty when there is not yet
    /// `min_seconds` of audio (the webview gates interim/final the same way).
    fn wav_base64(&self, min_seconds: f32) -> String {
        if self.rate == 0 || (self.samples.len() as f32) < (self.rate as f32) * min_seconds {
            return String::new();
        }
        let wav = encode_wav(&self.samples, self.rate as f32, TARGET_RATE);
        base64::engine::general_purpose::STANDARD.encode(wav)
    }
}

/// Linear downsample — the same scheme the webview used when it owned recording.
fn downsample(input: &[f32], from_rate: f32, to_rate: u32) -> Vec<f32> {
    if from_rate as u32 == to_rate {
        return input.to_vec();
    }
    let ratio = from_rate / to_rate as f32;
    let length = ((input.len() as f32) / ratio).floor().max(1.0) as usize;
    (0..length)
        .map(|i| {
            let start = (i as f32 * ratio).floor() as usize;
            let end = (((i + 1) as f32) * ratio).floor().min(input.len() as f32) as usize;
            let span = end.saturating_sub(start).max(1);
            let sum: f32 = input.get(start..end).map(|s| s.iter().sum()).unwrap_or(0.0);
            sum / span as f32
        })
        .collect()
}

/// Encode mono f32 samples as a standard 16-bit PCM WAV.
fn encode_wav(input: &[f32], from_rate: f32, to_rate: u32) -> Vec<u8> {
    let samples: Vec<i16> = downsample(input, from_rate, to_rate)
        .into_iter()
        .map(|s| {
            let s = s.clamp(-1.0, 1.0);
            if s < 0.0 {
                (s * 32768.0) as i16
            } else {
                (s * 32767.0) as i16
            }
        })
        .collect();

    let mut out = Vec::with_capacity(44 + samples.len() * 2);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36u32 + samples.len() as u32 * 2).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&to_rate.to_le_bytes());
    out.extend_from_slice(&(to_rate * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(samples.len() as u32 * 2).to_le_bytes());
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
}

/// List input devices, default first.
pub fn input_devices() -> Result<Vec<AudioDevice>, String> {
    let host = cpal::default_host();
    // cpal 0.18 exposes the human-readable name through Display.
    let default_name = host.default_input_device().map(|d| d.to_string());

    let mut devices: Vec<AudioDevice> = host
        .input_devices()
        .map_err(|e| format!("Could not list input devices: {e}"))?
        .map(|d| d.to_string())
        .map(|name| AudioDevice {
            is_default: Some(&name) == default_name.as_ref(),
            name,
        })
        .collect();

    devices.sort_by(|a, b| b.is_default.cmp(&a.is_default).then(a.name.cmp(&b.name)));
    devices.dedup_by(|a, b| a.name == b.name);
    Ok(devices)
}

/// Open the default input device just long enough to learn whether the OS lets us.
/// This is the honest microphone-permission signal on Windows, where an unpackaged
/// app gets no capability declaration to inspect: WASAPI fails device activation with
/// an access-denied error when the microphone privacy toggle is off.
pub enum MicProbe {
    Ok,
    Denied(String),
    Unavailable(String),
}

pub fn probe_microphone() -> MicProbe {
    let host = cpal::default_host();
    let Some(device) = host.default_input_device() else {
        return MicProbe::Unavailable("No input device found.".into());
    };
    let config = match device.default_input_config() {
        Ok(config) => config,
        Err(err) => {
            return match err.kind() {
                ErrorKind::PermissionDenied => MicProbe::Denied(err.to_string()),
                _ => MicProbe::Unavailable(err.to_string()),
            }
        }
    };

    let build = build_probe_stream(&device, &config.config(), config.sample_format());
    match build {
        Ok(()) => MicProbe::Ok,
        Err(err) => match err.kind() {
            ErrorKind::PermissionDenied => MicProbe::Denied(err.to_string()),
            _ => MicProbe::Unavailable(err.to_string()),
        },
    }
}

fn build_probe_stream(
    device: &cpal::Device,
    config: &StreamConfig,
    format: SampleFormat,
) -> Result<(), cpal::Error> {
    macro_rules! probe {
        ($t:ty) => {{
            let stream = device.build_input_stream(
                config.clone(),
                |_: &[$t], _: &cpal::InputCallbackInfo| {},
                |_| {},
                Some(Duration::from_millis(500)),
            )?;
            stream.play()?;
            // Long enough for WASAPI to surface an access denial, short enough that the
            // permissions screen still feels instant.
            std::thread::sleep(Duration::from_millis(60));
            drop(stream);
            Ok(())
        }};
    }

    match format {
        SampleFormat::F32 => probe!(f32),
        SampleFormat::I16 => probe!(i16),
        SampleFormat::U16 => probe!(u16),
        SampleFormat::I32 => probe!(i32),
        other => Err(cpal::Error::with_message(
            ErrorKind::InvalidInput,
            format!("Unsupported sample format: {other:?}"),
        )),
    }
}

/// Rolling window of mono samples, written by the audio callback and read by the
/// emit loop.
struct Window {
    samples: VecDeque<f32>,
}

impl Window {
    fn new() -> Self {
        Self {
            samples: VecDeque::with_capacity(FFT_SIZE * 2),
        }
    }

    fn push_interleaved(&mut self, data: &[f32], channels: usize) {
        if channels <= 1 {
            self.samples.extend(data.iter().copied());
        } else {
            // Downmix to mono: the visualiser and, later, the wake-word model both
            // want a single channel.
            for frame in data.chunks(channels) {
                let sum: f32 = frame.iter().copied().sum();
                self.samples.push_back(sum / frame.len() as f32);
            }
        }
        while self.samples.len() > FFT_SIZE {
            self.samples.pop_front();
        }
    }

    fn snapshot(&self) -> Option<Vec<f32>> {
        if self.samples.len() < FFT_SIZE {
            return None;
        }
        Some(self.samples.iter().copied().collect())
    }
}

/// Turns a sample window into per-band 0..1 values with an attack/release envelope.
struct Analyser {
    fft: Arc<dyn rustfft::Fft<f32>>,
    smoothed: [f32; BANDS],
    bins: [(usize, usize); BANDS],
}

impl Analyser {
    fn new(sample_rate: f32) -> Self {
        let mut planner = FftPlanner::<f32>::new();
        let bin_hz = sample_rate / FFT_SIZE as f32;
        let mut bins = [(0usize, 0usize); BANDS];
        for (i, bin) in bins.iter_mut().enumerate() {
            let lo = (BAND_EDGES_HZ[i] / bin_hz).floor().max(1.0) as usize;
            let hi = (BAND_EDGES_HZ[i + 1] / bin_hz).ceil() as usize;
            *bin = (lo.min(FFT_SIZE / 2 - 1), hi.min(FFT_SIZE / 2).max(lo + 1));
        }
        Self {
            fft: planner.plan_fft_forward(FFT_SIZE),
            smoothed: [0.0; BANDS],
            bins,
        }
    }

    fn analyse(&mut self, window: &[f32]) -> ([f32; BANDS], f32) {
        let mut buffer: Vec<Complex32> = window
            .iter()
            .enumerate()
            .map(|(i, s)| {
                // Hann window: without it, band energy smears across the spectrum.
                let w =
                    0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / (FFT_SIZE as f32 - 1.0)).cos();
                Complex32::new(s * w, 0.0)
            })
            .collect();
        self.fft.process(&mut buffer);

        let mut out = [0.0f32; BANDS];
        for (band, (lo, hi)) in self.bins.iter().copied().enumerate() {
            let mut sum = 0.0f32;
            for bin in lo..hi {
                sum += buffer[bin].norm();
            }
            let mean = sum / (hi - lo).max(1) as f32;
            // Normalise by window length, then map dB onto 0..1.
            let db = 20.0 * (mean / (FFT_SIZE as f32 / 4.0) + 1e-9).log10();
            let target = ((db - NOISE_FLOOR_DB) / -NOISE_FLOOR_DB).clamp(0.0, 1.0);
            let prev = self.smoothed[band];
            let coeff = if target > prev { ATTACK } else { RELEASE };
            self.smoothed[band] = prev + (target - prev) * coeff;
            out[band] = self.smoothed[band];
        }

        let rms = (window.iter().map(|s| s * s).sum::<f32>() / window.len() as f32).sqrt();
        let rms_db = 20.0 * (rms + 1e-9).log10();
        let level = ((rms_db - NOISE_FLOOR_DB) / -NOISE_FLOOR_DB).clamp(0.0, 1.0);
        (out, level)
    }
}

pub struct AudioManager {
    /// Sender used to stop the capture thread.
    stop: Mutex<Option<mpsc::Sender<()>>>,
    /// Join handle, so a record session can be drained only once the thread
    /// (which owns the non-`Send` cpal stream) has actually stopped writing.
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
    /// What is open right now; `None` means the device is free.
    owner: Mutex<Option<MicUse>>,
    /// Device currently open.
    current: Mutex<Option<String>>,
    /// Shared record buffer while a dictation is open.
    record: Mutex<Option<Arc<Mutex<RecordBuffer>>>>,
    /// When the current record session must be force-closed even if nobody asks.
    record_deadline: Mutex<Option<Instant>>,
    /// When the current session opened, for the close log line.
    opened_at: Mutex<Option<Instant>>,
}

impl AudioManager {
    pub fn new() -> Self {
        Self {
            stop: Mutex::new(None),
            thread: Mutex::new(None),
            owner: Mutex::new(None),
            current: Mutex::new(None),
            record: Mutex::new(None),
            record_deadline: Mutex::new(None),
            opened_at: Mutex::new(None),
        }
    }

    pub fn current_device(&self) -> Option<String> {
        self.current.lock().unwrap().clone()
    }

    /// Start streaming `mic://level` events. Passing `None` uses the OS default input.
    /// Returns the device actually opened. Evicts any current owner (logged).
    pub fn start_levels(
        &self,
        app: AppHandle,
        device_name: Option<String>,
    ) -> Result<String, String> {
        self.stop_open("replaced by levels");
        self.spawn_capture(app, device_name, CaptureMode::Levels, MicUse::Levels)
    }

    /// Start a dictation session: `mic://level` for the visualisers plus a rolling
    /// WAV drained by `snapshot_record` / `stop_record`. The single capture stream
    /// is the only microphone Pointy ever opens, so levels and dictation share it.
    pub fn start_record(
        &self,
        app: AppHandle,
        device_name: Option<String>,
    ) -> Result<String, String> {
        self.stop_open("replaced by record");
        let session = Arc::new(Mutex::new(RecordBuffer::new()));
        let opened = self.spawn_capture(
            app,
            device_name,
            CaptureMode::Record {
                session: session.clone(),
            },
            MicUse::Record,
        )?;
        *self.record.lock().unwrap() = Some(session);
        *self.record_deadline.lock().unwrap() = Some(Instant::now() + RECORD_CAP);
        Ok(opened)
    }

    /// Interim transcription: WAV of the audio captured so far, without stopping.
    /// Empty string when there is not yet enough audio or nothing is recording.
    pub fn snapshot_record(&self) -> Result<String, String> {
        let buffer = self.record.lock().unwrap().clone();
        Ok(buffer
            .map(|b| b.lock().unwrap().wav_base64(0.6))
            .unwrap_or_default())
    }

    /// Final flush: stop the session and return the WAV of the hold. Empty when
    /// nothing was open (already stopped by the cap watchdog, for instance).
    pub fn stop_record(&self) -> Result<String, String> {
        let buffer = self.record.lock().unwrap().take();
        self.record_deadline.lock().unwrap().take();
        self.stop_open("webview flush");
        Ok(buffer
            .map(|b| b.lock().unwrap().wav_base64(0.25))
            .unwrap_or_default())
    }

    /// True once a record session has outlived `RECORD_CAP`. The watchdog calls
    /// this so a wedged webview can never hold the device indefinitely.
    pub fn record_cap_exceeded(&self) -> bool {
        self.record_deadline
            .lock()
            .unwrap()
            .is_some_and(|deadline| Instant::now() >= deadline)
    }

    /// Force-close the record session because the cap was reached. The buffered
    /// audio is discarded (the webview gets an empty flush); the `mic://stopped`
    /// event is the caller's job so the UI knows why it went quiet.
    pub fn force_stop_record(&self) {
        self.record.lock().unwrap().take();
        self.record_deadline.lock().unwrap().take();
        self.stop_open("record cap reached");
    }

    /// Release whatever is open — used when the overlay hides or settings reset,
    /// so hiding Pointy always hands the device back.
    pub fn release_all(&self, reason: &str) {
        self.record.lock().unwrap().take();
        self.record_deadline.lock().unwrap().take();
        self.stop_open(reason);
    }

    pub fn stop_levels(&self) {
        self.stop_open("levels stopped");
    }

    /// Tear down the open capture, if any, and log the close so release is
    /// provable from the terminal. Returns what was open and on which device.
    fn stop_open(&self, reason: &str) -> Option<(MicUse, String)> {
        let owner = self.owner.lock().unwrap().take();
        let device = self.current.lock().unwrap().take();
        let stop = self.stop.lock().unwrap().take();
        if let Some(tx) = stop {
            let _ = tx.send(());
        }
        // The capture thread drops the (non-`Send`) cpal stream itself; joining
        // guarantees the record buffer is quiescent before anyone drains it.
        if let Some(handle) = self.thread.lock().unwrap().take() {
            let _ = handle.join();
        }
        if let (Some(owner), Some(device)) = (owner, device) {
            let held = self
                .opened_at
                .lock()
                .unwrap()
                .take()
                .map(|t| Instant::now().saturating_duration_since(t).as_secs_f32())
                .unwrap_or(0.0);
            eprintln!(
                "[pointy] mic close: {owner} (reason=\"{reason}\", device=\"{device}\", held={held:.1}s)"
            );
            return Some((owner, device));
        }
        None
    }

    fn spawn_capture(
        &self,
        app: AppHandle,
        device_name: Option<String>,
        mode: CaptureMode,
        owner: MicUse,
    ) -> Result<String, String> {
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<String, String>>();

        let thread = std::thread::Builder::new()
            .name("pointy-mic-capture".into())
            .spawn(move || capture_loop(app, device_name, stop_rx, ready_tx, mode))
            .map_err(|e| format!("Could not start the capture thread: {e}"))?;

        // The thread reports setup success before we hand control back to the UI, so a
        // failure to open the microphone surfaces as a command error, not as silence.
        let opened = match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(result) => result?,
            Err(_) => return Err("The microphone did not start in time.".into()),
        };

        *self.stop.lock().unwrap() = Some(stop_tx);
        *self.thread.lock().unwrap() = Some(thread);
        *self.owner.lock().unwrap() = Some(owner);
        *self.current.lock().unwrap() = Some(opened.clone());
        *self.opened_at.lock().unwrap() = Some(Instant::now());
        match owner {
            MicUse::Record => eprintln!(
                "[pointy] mic open: record (device=\"{opened}\", cap={RECORD_CAP:?})"
            ),
            MicUse::Levels => eprintln!("[pointy] mic open: levels (device=\"{opened}\")"),
        }
        Ok(opened)
    }
}

fn capture_loop(
    app: AppHandle,
    device_name: Option<String>,
    stop_rx: mpsc::Receiver<()>,
    ready_tx: mpsc::Sender<Result<String, String>>,
    mode: CaptureMode,
) {
    let host = cpal::default_host();

    let device = match device_name {
        Some(ref wanted) => host
            .input_devices()
            .ok()
            .and_then(|mut devices| devices.find(|d| d.to_string() == *wanted))
            .or_else(|| host.default_input_device()),
        None => host.default_input_device(),
    };

    let Some(device) = device else {
        let _ = ready_tx.send(Err("No microphone found.".into()));
        return;
    };
    let name = device.to_string();

    let supported = match device.default_input_config() {
        Ok(config) => config,
        Err(err) => {
            let _ = ready_tx.send(Err(describe(&err)));
            return;
        }
    };
    let config = supported.config();
    let channels = config.channels as usize;
    let sample_rate = config.sample_rate as f32;

    let session = match &mode {
        CaptureMode::Record { session } => Some(session.clone()),
        CaptureMode::Levels => None,
    };
    if let Some(buffer) = &session {
        buffer.lock().unwrap().set_rate(sample_rate as u32);
    }

    let window = Arc::new(Mutex::new(Window::new()));
    let error_app = app.clone();

    let stream = {
        let window = window.clone();
        let session = session.clone();
        let on_error = move |err: cpal::Error| {
            let _ = error_app.emit("mic://error", describe(&err));
        };

        macro_rules! stream_for {
            ($t:ty, $conv:expr) => {{
                let convert: fn($t) -> f32 = $conv;
                device.build_input_stream(
                    config.clone(),
                    move |data: &[$t], _: &cpal::InputCallbackInfo| {
                        let mono: Vec<f32> = data.iter().copied().map(convert).collect();
                        if let Ok(mut window) = window.lock() {
                            window.push_interleaved(&mono, channels);
                        }
                        if let Some(buffer) = &session {
                            if let Ok(mut buffer) = buffer.lock() {
                                buffer.push(&mono, sample_rate as u32);
                            }
                        }
                    },
                    on_error,
                    None,
                )
            }};
        }

        match supported.sample_format() {
            SampleFormat::F32 => stream_for!(f32, |s| s),
            SampleFormat::I16 => stream_for!(i16, |s| s as f32 / i16::MAX as f32),
            SampleFormat::U16 => stream_for!(u16, |s| (s as f32 / u16::MAX as f32) * 2.0 - 1.0),
            SampleFormat::I32 => stream_for!(i32, |s| s as f32 / i32::MAX as f32),
            other => {
                let _ = ready_tx.send(Err(format!("Unsupported sample format: {other:?}")));
                return;
            }
        }
    };

    let stream = match stream {
        Ok(stream) => stream,
        Err(err) => {
            let _ = ready_tx.send(Err(describe(&err)));
            return;
        }
    };

    if let Err(err) = stream.play() {
        let _ = ready_tx.send(Err(describe(&err)));
        return;
    }

    let _ = ready_tx.send(Ok(name.clone()));

    let mut analyser = Analyser::new(sample_rate);
    loop {
        match stop_rx.recv_timeout(EMIT_INTERVAL) {
            Ok(()) | Err(RecvTimeoutError::Disconnected) => break,
            Err(RecvTimeoutError::Timeout) => {}
        }

        let snapshot = window.lock().ok().and_then(|w| w.snapshot());
        let Some(snapshot) = snapshot else { continue };
        let (bands, level) = analyser.analyse(&snapshot);
        let _ = app.emit(
            "mic://level",
            MicLevel {
                bands,
                level,
                device: name.clone(),
            },
        );
    }

    // Dropping the stream on this thread is required: cpal streams are not `Send`.
    drop(stream);
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_RATE: f32 = 48_000.0;

    fn sine(freq: f32, amplitude: f32) -> Vec<f32> {
        (0..FFT_SIZE)
            .map(|i| {
                let t = i as f32 / SAMPLE_RATE;
                (std::f32::consts::TAU * freq * t).sin() * amplitude
            })
            .collect()
    }

    /// Feed the analyser enough frames for the envelope to settle.
    fn settle(analyser: &mut Analyser, window: &[f32]) -> ([f32; BANDS], f32) {
        let mut out = ([0.0; BANDS], 0.0);
        for _ in 0..40 {
            out = analyser.analyse(window);
        }
        out
    }

    #[test]
    fn silence_reads_as_silence() {
        let mut analyser = Analyser::new(SAMPLE_RATE);
        let (bands, level) = settle(&mut analyser, &vec![0.0; FFT_SIZE]);
        assert!(level < 0.01, "level was {level}");
        for (index, value) in bands.iter().enumerate() {
            assert!(*value < 0.01, "band {index} was {value}");
        }
    }

    #[test]
    fn a_tone_lands_in_the_band_that_contains_it() {
        // 1 kHz sits inside the fourth band (1400 Hz upper edge is band 3's top, so
        // 1 kHz belongs to band index 2: 600–1400 Hz).
        let mut analyser = Analyser::new(SAMPLE_RATE);
        let (bands, level) = settle(&mut analyser, &sine(1_000.0, 0.5));

        let loudest = bands
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .map(|(index, _)| index)
            .unwrap();

        assert_eq!(loudest, 2, "bands were {bands:?}");
        assert!(level > 0.4, "level was {level}");
    }

    #[test]
    fn a_low_tone_and_a_high_tone_land_in_different_bands() {
        let mut low = Analyser::new(SAMPLE_RATE);
        let mut high = Analyser::new(SAMPLE_RATE);
        let (low_bands, _) = settle(&mut low, &sine(150.0, 0.5));
        let (high_bands, _) = settle(&mut high, &sine(4_000.0, 0.5));

        let peak = |bands: [f32; BANDS]| {
            bands
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
                .map(|(index, _)| index)
                .unwrap()
        };

        assert_eq!(peak(low_bands), 0, "low bands were {low_bands:?}");
        assert_eq!(peak(high_bands), 4, "high bands were {high_bands:?}");
    }

    #[test]
    fn louder_input_reads_higher() {
        let mut quiet = Analyser::new(SAMPLE_RATE);
        let mut loud = Analyser::new(SAMPLE_RATE);
        let (_, quiet_level) = settle(&mut quiet, &sine(1_000.0, 0.02));
        let (_, loud_level) = settle(&mut loud, &sine(1_000.0, 0.9));
        assert!(loud_level > quiet_level, "{loud_level} !> {quiet_level}");
    }

    #[test]
    fn stereo_input_is_downmixed_to_one_channel() {
        let mut window = Window::new();
        // Two channels, left at +1.0 and right at -1.0 — the mix must cancel.
        let interleaved: Vec<f32> = (0..FFT_SIZE * 2)
            .map(|i| if i % 2 == 0 { 1.0 } else { -1.0 })
            .collect();
        window.push_interleaved(&interleaved, 2);

        let snapshot = window.snapshot().expect("a full window");
        assert_eq!(snapshot.len(), FFT_SIZE);
        assert!(snapshot.iter().all(|s| s.abs() < 1e-6));
    }

    #[test]
    fn the_window_keeps_only_the_most_recent_samples() {
        let mut window = Window::new();
        window.push_interleaved(&vec![0.5; FFT_SIZE * 3], 1);
        let snapshot = window.snapshot().expect("a full window");
        assert_eq!(snapshot.len(), FFT_SIZE);
    }

    #[test]
    fn a_partial_window_yields_nothing() {
        let mut window = Window::new();
        window.push_interleaved(&vec![0.5; FFT_SIZE / 2], 1);
        assert!(window.snapshot().is_none());
    }

    #[test]
    fn wav_is_a_valid_mono_16k_pcm_file() {
        // 2 seconds at 48 kHz in, 2 seconds at 16 kHz out.
        let wav = encode_wav(&vec![0.0; 48_000 * 2], 48_000.0, 16_000);
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(&wav[36..40], b"data");
        // 2 seconds at 16 kHz, mono, 16-bit.
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 16_000 * 2 * 2);
        // Header plus the payload.
        assert_eq!(wav.len(), 44 + 16_000 * 2 * 2);
    }

    #[test]
    fn wav_preserves_the_signal() {
        // A full-scale DC offset should survive downsample + 16-bit encoding.
        let wav = encode_wav(&vec![0.5; 48_000 * 2], 48_000.0, 16_000);
        let data = &wav[44..];
        let sample = i16::from_le_bytes([data[0], data[1]]);
        assert_eq!(sample, (0.5 * 32767.0) as i16);
    }

    #[test]
    fn record_buffer_trims_to_twenty_seconds() {
        let mut buffer = RecordBuffer::new();
        buffer.set_rate(16_000);
        buffer.push(&vec![0.25; 16_000 * 30], 16_000);
        assert_eq!(buffer.samples.len(), 16_000 * MAX_RECORD_SECONDS);
        // Trim keeps the tail, not the head.
        assert!(buffer.samples.iter().all(|s| *s == 0.25));
    }

    #[test]
    fn wav_base64_gates_on_minimum_duration() {
        let mut buffer = RecordBuffer::new();
        buffer.set_rate(16_000);
        buffer.push(&vec![0.1; 4_000], 16_000); // 0.25s
        assert!(buffer.wav_base64(0.6).is_empty(), "interim gate must reject 0.25s");
        assert!(!buffer.wav_base64(0.25).is_empty(), "final gate must accept 0.25s");
    }

    #[test]
    fn downsample_halves_the_length() {
        let out = downsample(&vec![1.0; 10_000], 32_000.0, 16_000);
        assert_eq!(out.len(), 5_000);
        assert!(out.iter().all(|s| *s == 1.0));
    }
}

fn describe(err: &cpal::Error) -> String {
    match err.kind() {
        ErrorKind::PermissionDenied => {
            "Windows is blocking microphone access for this app.".to_string()
        }
        ErrorKind::DeviceBusy => "Another app is using the microphone.".to_string(),
        ErrorKind::DeviceNotAvailable => "That microphone is no longer connected.".to_string(),
        _ => err.to_string(),
    }
}

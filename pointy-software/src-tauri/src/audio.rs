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
use std::time::Duration;

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
    stop: Mutex<Option<mpsc::Sender<()>>>,
    current: Mutex<Option<String>>,
}

impl AudioManager {
    pub fn new() -> Self {
        Self {
            stop: Mutex::new(None),
            current: Mutex::new(None),
        }
    }

    pub fn current_device(&self) -> Option<String> {
        self.current.lock().unwrap().clone()
    }

    /// Start streaming `mic://level` events. Passing `None` uses the OS default input.
    /// Returns the device actually opened.
    pub fn start_levels(
        &self,
        app: AppHandle,
        device_name: Option<String>,
    ) -> Result<String, String> {
        self.stop_levels();

        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<String, String>>();

        std::thread::Builder::new()
            .name("pointy-mic-levels".into())
            .spawn(move || capture_loop(app, device_name, stop_rx, ready_tx))
            .map_err(|e| format!("Could not start the capture thread: {e}"))?;

        // The thread reports setup success before we hand control back to the UI, so a
        // failure to open the microphone surfaces as a command error, not as silence.
        let opened = match ready_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(result) => result?,
            Err(_) => return Err("The microphone did not start in time.".into()),
        };

        *self.stop.lock().unwrap() = Some(stop_tx);
        *self.current.lock().unwrap() = Some(opened.clone());
        Ok(opened)
    }

    pub fn stop_levels(&self) {
        if let Some(tx) = self.stop.lock().unwrap().take() {
            let _ = tx.send(());
        }
        *self.current.lock().unwrap() = None;
    }
}

fn capture_loop(
    app: AppHandle,
    device_name: Option<String>,
    stop_rx: mpsc::Receiver<()>,
    ready_tx: mpsc::Sender<Result<String, String>>,
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

    let window = Arc::new(Mutex::new(Window::new()));
    let error_app = app.clone();

    let stream = {
        let window = window.clone();
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

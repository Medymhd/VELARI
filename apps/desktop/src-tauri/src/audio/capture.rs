// Live audio capture — port of rival `microphone.rs` + `speaker/windows.rs`
// + the DSP loop from rival `lib.rs`, adapted to emit Tauri events instead of
// napi threadsafe functions.
//
// Per channel:
// 1. Owner thread creates the OS stream (CPAL mic / WASAPI loopback) and
//    reports the init result over mpsc (bounded wait) to the caller.
// 2. The same thread runs the DSP loop: drains the lock-free ring buffer,
//    resamples (anti-aliased) to 16kHz, frames 20ms chunks through the
//    two-stage gate, batches frames, emits `audio://mic` / `audio://system`.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Result;
use cpal::traits::{DeviceTrait, HostTrait};
use ringbuf::traits::{Consumer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::batch::BatchEmitter;
use super::config::{DSP_POLL_MS, RING_BUFFER_SAMPLES, SAMPLE_RATE};
use super::resampler::Resampler;
use super::silence::{FrameAction, SilenceSuppressionConfig, SilenceSuppressor, SpeechEdge};

pub const EVENT_MIC: &str = "audio://mic";
pub const EVENT_SYSTEM: &str = "audio://system";

const CHANNEL_MIC: &str = "mic";
const CHANNEL_SYSTEM: &str = "system";
const INIT_TIMEOUT_SECS: u64 = 5;

/// A live capture session for one channel. `stop()` (or drop) signals the
/// owner thread and joins it, flushing any pending batch.
pub struct ChannelSession {
    pub channel: &'static str,
    pub native_rate: u32,
    pub started_at_ms: u64,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl ChannelSession {
    pub fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for ChannelSession {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioChunkPayload {
    channel: String,
    rate: u32,
    data_b64: String,
    speech: bool,
    rms: f32,
    at_ms: u64,
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[inline]
fn i16_slice_to_le_bytes(samples: &[i16]) -> Vec<u8> {
    samples.iter().flat_map(|s| s.to_le_bytes()).collect()
}

fn rms_of(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_of_squares: f64 = samples.iter().step_by(4).map(|&s| (s as f64) * (s as f64)).sum();
    let count = (samples.len() + 3) / 4;
    (sum_of_squares / count as f64).sqrt() as f32
}

// ============================================================================
// Base64 (hand-rolled to avoid a new dependency)
// ============================================================================

const B64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = ((*chunk.get(0).unwrap_or(&0) as u32) << 16)
            | ((*chunk.get(1).unwrap_or(&0) as u32) << 8)
            | (*chunk.get(2).unwrap_or(&0) as u32);
        out.push(B64_ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(B64_ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64_ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64_ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
}

// ============================================================================
// Shared DSP loop
// ============================================================================

fn run_dsp_loop(
    channel: &'static str,
    native_rate: u32,
    mut consumer: HeapCons<f32>,
    stop: Arc<AtomicBool>,
    app: AppHandle,
    mic_err: Option<Arc<Mutex<Option<String>>>>,
) {
    // Anti-aliased resampler native -> 16kHz; passthrough when native is
    // already 16kHz or construction fails (the declared rate must always
    // match the emitted bytes).
    let mut resampler: Option<Resampler> = if native_rate == SAMPLE_RATE {
        None
    } else {
        match Resampler::new(native_rate as f64) {
            Ok(r) => Some(r),
            Err(e) => {
                eprintln!("[{channel}] resampler init failed ({e}); passthrough at {native_rate}Hz");
                None
            }
        }
    };
    let emitted_rate = if resampler.is_some() { SAMPLE_RATE } else { native_rate };

    let base_config = if channel == CHANNEL_SYSTEM {
        SilenceSuppressionConfig::for_system_audio()
    } else {
        SilenceSuppressionConfig::for_microphone()
    };
    let mut suppressor = SilenceSuppressor::new(SilenceSuppressionConfig {
        native_sample_rate: emitted_rate,
        ..base_config
    });

    // 20ms frames at the EMITTED rate (320 samples at 16kHz).
    let chunk_size = (emitted_rate as usize / 1000) * 20;
    let mut frame_buffer: Vec<i16> = Vec::with_capacity(chunk_size * 4);
    let mut raw_batch: Vec<f32> = Vec::with_capacity(4096);
    let mut frame_scratch: Vec<i16> = Vec::with_capacity(chunk_size);

    // Speech/rms snapshot read by the emitter at flush time.
    let speech_flag = Arc::new(AtomicBool::new(false));
    let rms_bits = Arc::new(AtomicU32::new(0.0f32.to_bits()));

    let mut emitter = {
        let app = app.clone();
        let speech_flag = speech_flag.clone();
        let rms_bits = rms_bits.clone();
        let rate = emitted_rate;
        let channel_str = channel.to_string();
        BatchEmitter::new(chunk_size * 2, move |bytes| {
            let payload = AudioChunkPayload {
                channel: channel_str.clone(),
                rate,
                data_b64: base64_encode(&bytes),
                speech: speech_flag.load(Ordering::Relaxed),
                rms: f32::from_bits(rms_bits.load(Ordering::Relaxed)),
                at_ms: epoch_ms(),
            };
            if let Err(e) = app.emit(if channel_str == CHANNEL_SYSTEM { EVENT_SYSTEM } else { EVENT_MIC }, payload) {
                eprintln!("[{channel_str}] emit failed: {e}");
            }
        })
    };

    println!("[{channel}] DSP started (native={native_rate}Hz, emitted={emitted_rate}Hz, chunk={chunk_size})");

    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }

        // Surface CPAL callback-thread errors once (first-error-wins cell).
        if let Some(err_cell) = &mic_err {
            if let Ok(mut slot) = err_cell.lock() {
                if let Some(msg) = slot.take() {
                    eprintln!("[{channel}] cpal stream error: {msg}");
                    emitter.flush();
                }
            }
        }

        // 1. Drain ALL available samples (lock-free).
        while let Some(sample) = consumer.try_pop() {
            raw_batch.push(sample);
        }

        // 2. Resample (anti-aliased) to 16kHz i16, or f32 -> i16 passthrough.
        if !raw_batch.is_empty() {
            match resampler.as_mut() {
                Some(r) => match r.resample_to_i16(&raw_batch) {
                    Ok(out) => frame_buffer.extend_from_slice(&out),
                    Err(e) => eprintln!("[{channel}] resample error: {e}"),
                },
                None => {
                    for &f in &raw_batch {
                        frame_buffer.push((f * 32767.0).clamp(-32768.0, 32767.0) as i16);
                    }
                }
            }
            raw_batch.clear();
        }

        // 3. Process 20ms frames through the two-stage gate.
        while frame_buffer.len() >= chunk_size {
            frame_scratch.clear();
            frame_scratch.extend(frame_buffer.drain(0..chunk_size));

            let (action, edge) = suppressor.process_edges(&frame_scratch);

            match action {
                FrameAction::Send(data) => {
                    speech_flag.store(suppressor.is_speech(), Ordering::Relaxed);
                    rms_bits.store(rms_of(&data).to_bits(), Ordering::Relaxed);
                    emitter.push(&i16_slice_to_le_bytes(&data));
                }
                FrameAction::SendSilence => {
                    speech_flag.store(false, Ordering::Relaxed);
                    rms_bits.store(0.0f32.to_bits(), Ordering::Relaxed);
                    emitter.push(&vec![0u8; chunk_size * 2]);
                }
                FrameAction::Suppress => {
                    // Nothing — a partial batch ages out via the timeout.
                }
            }

            // Flush pending audio FIRST so the backend sees trailing audio
            // before the utterance is considered over.
            if edge == SpeechEdge::Ended {
                emitter.flush();
            }
        }

        emitter.maybe_flush_timeout();

        std::thread::sleep(Duration::from_millis(DSP_POLL_MS));
    }

    emitter.flush();
    println!("[{channel}] DSP stopped.");
}

// ============================================================================
// Microphone (CPAL, cross-platform)
// ============================================================================

/// Normalize a device name for fuzzy matching across plug/unplug cycles
/// where the OS may renumber the device or use a different unicode dash.
fn normalize_device_name(s: &str) -> String {
    s.trim()
        .trim_start_matches(|c: char| c == '(' || c.is_ascii_digit() || c == '-' || c == ' ')
        .trim_end_matches(|c: char| c == ')' || c == ' ')
        .chars()
        .map(|c| match c {
            '\u{2013}' | '\u{2014}' | '\u{2212}' => '-',
            other => other,
        })
        .collect::<String>()
        .to_lowercase()
}

fn resolve_input_device(host: &cpal::Host, device_id: Option<&str>) -> Result<cpal::Device> {
    let requested_id = device_id
        .map(str::trim)
        .filter(|id| !id.is_empty() && !id.eq_ignore_ascii_case("default"));

    let Some(requested_id) = requested_id else {
        return host
            .default_input_device()
            .ok_or_else(|| anyhow::anyhow!("No input device found"));
    };

    let normalized_request = normalize_device_name(requested_id);
    // Tiered matching: 0 = exact, 1 = case-insensitive, 2 = fuzzy.
    let mut best: Option<(u8, cpal::Device, String)> = None;
    let mut available = Vec::new();

    for device in host.input_devices()? {
        let name = device.name().unwrap_or_else(|_| "<unknown input>".to_string());
        let tier = if name == requested_id {
            Some(0u8)
        } else if name.eq_ignore_ascii_case(requested_id) {
            Some(1u8)
        } else if normalize_device_name(&name) == normalized_request {
            Some(2u8)
        } else {
            None
        };

        available.push(name.clone());
        if let Some(t) = tier {
            if best.as_ref().map_or(true, |(bt, _, _)| t < *bt) {
                best = Some((t, device, name));
                if t == 0 {
                    break;
                }
            }
        }
    }

    match best {
        Some((tier, device, matched)) => {
            let label = ["exact", "case-insensitive", "fuzzy"][tier as usize];
            println!("[mic] {label} match: requested='{requested_id}' matched='{matched}'");
            Ok(device)
        }
        None => Err(anyhow::anyhow!(
            "Input device '{requested_id}' not found. Available: {}",
            available.join(", ")
        )),
    }
}

/// Pick a usable input config: the OS default first; if its sample format is
/// not F32/I16/I32, negotiate from supported configs (F32 > I16 > I32),
/// clamped to at most 48kHz.
fn pick_supported_config(device: &cpal::Device) -> Result<cpal::SupportedStreamConfig> {
    use cpal::SampleFormat;

    let default_cfg = device
        .default_input_config()
        .map_err(|e| anyhow::anyhow!("Failed to get default input config: {e}"))?;

    if matches!(
        default_cfg.sample_format(),
        SampleFormat::F32 | SampleFormat::I16 | SampleFormat::I32
    ) {
        return Ok(default_cfg);
    }

    let configs: Vec<_> = device
        .supported_input_configs()
        .map_err(|e| anyhow::anyhow!("supported_input_configs failed: {e}"))?
        .collect();

    for preferred in [SampleFormat::F32, SampleFormat::I16, SampleFormat::I32] {
        if let Some(range) = configs.iter().find(|r| r.sample_format() == preferred) {
            let target_rate = range
                .max_sample_rate()
                .0
                .min(48_000)
                .max(range.min_sample_rate().0);
            let cfg = range.clone().with_sample_rate(cpal::SampleRate(target_rate));
            println!(
                "[mic] negotiated fallback config: {}Hz, {}ch, {:?}",
                cfg.sample_rate().0,
                cfg.channels(),
                cfg.sample_format()
            );
            return Ok(cfg);
        }
    }

    Err(anyhow::anyhow!(
        "Microphone exposes no supported format (need F32/I16/I32); default was {:?}",
        default_cfg.sample_format()
    ))
}

type ErrCell = Arc<Mutex<Option<String>>>;

fn make_err_fn(cell: ErrCell) -> impl Fn(cpal::StreamError) + Send + 'static {
    move |err: cpal::StreamError| {
        let msg = format!("{err}");
        eprintln!("[mic] stream error: {msg}");
        // First error wins; drop the rest to avoid log spam.
        if let Ok(mut slot) = cell.lock() {
            if slot.is_none() {
                *slot = Some(msg);
            }
        }
    }
}

/// Build the input stream generically over the device sample format. The
/// callback is real-time safe: convert + lock-free ring push only. Mono
/// extraction takes the first channel of each interleaved frame.
fn build_input_stream<T: cpal::SizedSample + 'static>(
    device: &cpal::Device,
    config: &cpal::SupportedStreamConfig,
    mut producer: HeapProd<f32>,
    channels: usize,
    is_running: Arc<AtomicBool>,
    data_ready: Arc<(Mutex<bool>, std::sync::Condvar)>,
    err_cell: &ErrCell,
    convert: fn(T) -> f32,
) -> Result<cpal::Stream> {
    device
        .build_input_stream(
            &config.clone().into(),
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                if !is_running.load(Ordering::Relaxed) {
                    return;
                }
                if channels > 1 {
                    for frame in data.chunks(channels) {
                        let _ = producer.try_push(convert(frame[0]));
                    }
                } else {
                    for &sample in data {
                        let _ = producer.try_push(convert(sample));
                    }
                }
                let (lock, cvar) = &*data_ready;
                if let Ok(mut ready) = lock.lock() {
                    *ready = true;
                    cvar.notify_one();
                }
            },
            make_err_fn(err_cell.clone()),
            None,
        )
        .map_err(|e| anyhow::anyhow!("Failed to build input stream: {e}"))
}

/// Lock-free microphone stream: the CPAL callback ONLY pushes to the ring
/// buffer (real-time safe); the DSP loop polls the consumer. Mono extraction
/// takes the first channel of each interleaved frame.
struct MicrophoneStream {
    stream: Option<cpal::Stream>,
    consumer: Option<HeapCons<f32>>,
    sample_rate: u32,
    is_running: Arc<AtomicBool>,
    err_signal: ErrCell,
}

impl MicrophoneStream {
    fn new(device_id: Option<String>) -> Result<Self> {
        use cpal::SampleFormat;

        let host = cpal::default_host();
        let device = resolve_input_device(&host, device_id.as_deref())?;
        let config = pick_supported_config(&device)?;

        let sample_rate = config.sample_rate().0;
        let channels = config.channels() as usize;

        println!(
            "[mic] device: {}, rate: {sample_rate}Hz, channels: {channels}, format: {:?}",
            device.name().unwrap_or_default(),
            config.sample_format()
        );

        let rb = HeapRb::<f32>::new(RING_BUFFER_SAMPLES);
        let (producer, consumer) = rb.split();
        let is_running = Arc::new(AtomicBool::new(false));
        let err_signal: ErrCell = Arc::new(Mutex::new(None));
        let data_ready: Arc<(Mutex<bool>, std::sync::Condvar)> =
            Arc::new((Mutex::new(false), std::sync::Condvar::new()));

        let stream = match config.sample_format() {
            SampleFormat::F32 => build_input_stream::<f32>(
                &device, &config, producer, channels, is_running.clone(), data_ready, &err_signal, |s| s,
            )?,
            SampleFormat::I16 => build_input_stream::<i16>(
                &device, &config, producer, channels, is_running.clone(), data_ready, &err_signal,
                |s| s as f32 / 32768.0,
            )?,
            SampleFormat::I32 => build_input_stream::<i32>(
                &device, &config, producer, channels, is_running.clone(), data_ready, &err_signal,
                |s| s as f32 / 2147483648.0,
            )?,
            format => return Err(anyhow::anyhow!("Unsupported sample format: {format:?}")),
        };

        Ok(Self {
            stream: Some(stream),
            consumer: Some(consumer),
            sample_rate,
            is_running,
            err_signal,
        })
    }

    fn play(&self) -> Result<()> {
        use cpal::traits::StreamTrait;
        if let Some(ref stream) = self.stream {
            stream
                .play()
                .map_err(|e| anyhow::anyhow!("Failed to start stream: {e}"))?;
            self.is_running.store(true, Ordering::SeqCst);
            println!("[mic] stream started");
        }
        Ok(())
    }

    fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    fn take_consumer(&mut self) -> Option<HeapCons<f32>> {
        self.consumer.take()
    }

    fn err_signal(&self) -> ErrCell {
        self.err_signal.clone()
    }
}

impl Drop for MicrophoneStream {
    fn drop(&mut self) {
        self.is_running.store(false, Ordering::SeqCst);
        // Stream is dropped → CPAL stops the capture.
    }
}

fn mic_owner(
    device_id: Option<String>,
    stop: Arc<AtomicBool>,
    init_tx: mpsc::Sender<Result<u32, String>>,
    app: AppHandle,
) {
    let built = (|| -> Result<MicrophoneStream> {
        let stream = MicrophoneStream::new(device_id)?;
        stream.play()?;
        Ok(stream)
    })();

    match built {
        Ok(mut stream) => {
            let rate = stream.sample_rate();
            let _ = init_tx.send(Ok(rate));
            if let Some(consumer) = stream.take_consumer() {
                let err_cell = stream.err_signal();
                run_dsp_loop(CHANNEL_MIC, rate, consumer, stop, app, Some(err_cell));
            }
            // stream dropped here → CPAL capture stops
        }
        Err(e) => {
            let _ = init_tx.send(Err(format!("{e}")));
        }
    }
}

pub fn start_microphone(app: &AppHandle, device_id: Option<String>) -> Result<ChannelSession, String> {
    spawn_session("mic-capture", CHANNEL_MIC, device_id, app, mic_owner)
}

// ============================================================================
// System audio (WASAPI loopback) — Windows; explicit error elsewhere
// ============================================================================

pub fn start_system(app: &AppHandle, device_id: Option<String>) -> Result<ChannelSession, String> {
    #[cfg(windows)]
    {
        spawn_session("system-capture", CHANNEL_SYSTEM, device_id, app, |device_id, stop, tx, app| {
            system_owner(device_id, stop, tx, app)
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (app, device_id);
        Err("System audio capture requires Windows (WASAPI loopback)".into())
    }
}

fn spawn_session<F>(
    thread_name: &str,
    channel: &'static str,
    device_id: Option<String>,
    app: &AppHandle,
    owner: F,
) -> Result<ChannelSession, String>
where
    F: FnOnce(Option<String>, Arc<AtomicBool>, mpsc::Sender<Result<u32, String>>, AppHandle)
        + Send
        + 'static,
{
    let stop = Arc::new(AtomicBool::new(false));
    let (init_tx, init_rx) = mpsc::channel();
    let stop_for_thread = stop.clone();
    let app_for_thread = app.clone();

    let handle = std::thread::Builder::new()
        .name(thread_name.into())
        .spawn(move || owner(device_id, stop_for_thread, init_tx, app_for_thread))
        .map_err(|e| format!("Failed to spawn capture thread: {e}"))?;

    match init_rx.recv_timeout(Duration::from_secs(INIT_TIMEOUT_SECS)) {
        Ok(Ok(rate)) => Ok(ChannelSession {
            channel,
            native_rate: rate,
            started_at_ms: epoch_ms(),
            stop,
            thread: Some(handle),
        }),
        Ok(Err(e)) => {
            stop.store(true, Ordering::SeqCst);
            let _ = handle.join();
            Err(format!("{} init failed: {e}", channel))
        }
        Err(_) => {
            stop.store(true, Ordering::SeqCst);
            let _ = handle.join();
            Err(format!("{} init timed out after {}s", channel, INIT_TIMEOUT_SECS))
        }
    }
}

#[cfg(windows)]
mod wasapi_loopback {
    use super::RING_BUFFER_SAMPLES;
    use anyhow::Result;
    use ringbuf::traits::{Producer, Split};
    use ringbuf::{HeapCons, HeapProd, HeapRb};
    use std::collections::VecDeque;
    use std::sync::{mpsc, Arc, Mutex};
    use std::thread;
    use std::time::Duration;
    use wasapi::{get_default_device, DeviceCollection, Direction, SampleType, ShareMode, WaveFormat};

    struct WakerState {
        shutdown: bool,
    }

    pub struct SpeakerInput {
        device_id: Option<String>,
    }

    pub struct SpeakerStream {
        consumer: Option<HeapCons<f32>>,
        waker_state: Arc<Mutex<WakerState>>,
        capture_thread: Option<thread::JoinHandle<()>>,
        actual_sample_rate: u32,
    }

    impl SpeakerStream {
        pub fn sample_rate(&self) -> u32 {
            self.actual_sample_rate
        }

        pub fn take_consumer(&mut self) -> Option<HeapCons<f32>> {
            self.consumer.take()
        }
    }

    // Loopback captures the eMultimedia/eConsole default render device (or a
    // user-specified id). VoIP apps routing to eCommunications need raw
    // windows-rs (this crate version has no Role API) — known follow-up.
    fn find_device_by_id(direction: &Direction, device_id: &str) -> Option<wasapi::Device> {
        let collection = DeviceCollection::new(direction).ok()?;
        let count = collection.get_nbr_devices().ok()?;
        (0..count).find_map(|i| {
            collection
                .get_device_at_index(i)
                .ok()
                .and_then(|d| d.get_id().ok())
                .filter(|id| id == device_id)
                .and_then(|_| collection.get_device_at_index(i).ok())
        })
    }

    impl SpeakerInput {
        pub fn new(device_id: Option<String>) -> Result<Self> {
            let device_id = device_id.filter(|id| !id.is_empty() && id != "default");
            Ok(Self { device_id })
        }

        /// Spawn the WASAPI capture thread and wait for the real sample rate.
        /// Errors on init failure/timeout so callers surface the failure
        /// instead of silently degrading to a zero-sample stream.
        pub fn stream(self) -> Result<SpeakerStream> {
            let rb = HeapRb::<f32>::new(RING_BUFFER_SAMPLES);
            let (producer, consumer) = rb.split();

            let waker_state = Arc::new(Mutex::new(WakerState { shutdown: false }));
            let (init_tx, init_rx) = mpsc::channel();
            let waker_clone = waker_state.clone();
            let device_id = self.device_id;

            let capture_thread = thread::spawn(move || {
                if let Err(e) = Self::capture_audio_loop(producer, waker_clone, init_tx, device_id) {
                    eprintln!("[system] WASAPI capture loop failed: {e}");
                }
            });

            let actual_sample_rate = match init_rx.recv_timeout(Duration::from_secs(5)) {
                Ok(Ok(rate)) => rate,
                Ok(Err(e)) => {
                    if let Ok(mut state) = waker_state.lock() {
                        state.shutdown = true;
                    }
                    let _ = capture_thread.join();
                    return Err(anyhow::anyhow!("WASAPI init failed: {e}"));
                }
                Err(_) => {
                    if let Ok(mut state) = waker_state.lock() {
                        state.shutdown = true;
                    }
                    let _ = capture_thread.join();
                    return Err(anyhow::anyhow!(
                        "WASAPI init timed out (no default render device, or device busy in exclusive mode)"
                    ));
                }
            };

            Ok(SpeakerStream {
                consumer: Some(consumer),
                waker_state,
                capture_thread: Some(capture_thread),
                actual_sample_rate,
            })
        }

        fn capture_audio_loop(
            mut producer: HeapProd<f32>,
            waker_state: Arc<Mutex<WakerState>>,
            init_tx: mpsc::Sender<Result<u32, String>>,
            device_id: Option<String>,
        ) -> Result<()> {
            let init_result = (|| -> Result<_> {
                wasapi::initialize_mta().map_err(|e| anyhow::anyhow!("COM init failed: {e}"))?;

                let device = match device_id.as_deref() {
                    Some(id) if !id.is_empty() => match find_device_by_id(&Direction::Render, id) {
                        Some(d) => d,
                        None => get_default_device(&Direction::Render).map_err(|e| {
                            anyhow::anyhow!("device '{id}' not found and default lookup failed: {e}")
                        })?,
                    },
                    _ => get_default_device(&Direction::Render)
                        .map_err(|e| anyhow::anyhow!("default render device unavailable: {e}"))?,
                };

                let mut audio_client = device.get_iaudioclient().map_err(|e| anyhow::anyhow!("{e}"))?;
                let device_format = audio_client.get_mixformat().map_err(|e| anyhow::anyhow!("{e}"))?;
                let actual_rate = device_format.get_samplespersec();
                let desired_format =
                    WaveFormat::new(32, 32, &SampleType::Float, actual_rate as usize, 1, None);

                let (_def_time, min_time) = audio_client.get_periods().map_err(|e| anyhow::anyhow!("{e}"))?;
                // Loopback: device=Render, initialized with Direction::Capture —
                // this triggers AUDCLNT_STREAMFLAGS_LOOPBACK.
                audio_client
                    .initialize_client(&desired_format, min_time, &Direction::Capture, &ShareMode::Shared, true)
                    .map_err(|e| anyhow::anyhow!("{e}"))?;
                let h_event = audio_client.set_get_eventhandle().map_err(|e| anyhow::anyhow!("{e}"))?;
                let render_client = audio_client.get_audiocaptureclient().map_err(|e| anyhow::anyhow!("{e}"))?;
                audio_client.start_stream().map_err(|e| anyhow::anyhow!("{e}"))?;

                Ok((h_event, render_client, actual_rate, audio_client))
            })();

            match init_result {
                Ok((h_event, render_client, sample_rate, audio_client)) => {
                    let _ = init_tx.send(Ok(sample_rate));
                    loop {
                        if waker_state.lock().unwrap().shutdown {
                            let _ = audio_client.stop_stream();
                            break;
                        }

                        // Timeout is normal during silence — loopback fires no
                        // events when nothing plays. Keep waiting.
                        if h_event.wait_for_event(3000).is_err() {
                            continue;
                        }

                        let mut temp_queue = VecDeque::new();
                        // 32-bit float mono → 4 bytes per frame.
                        if let Err(e) = render_client.read_from_device_to_deque(4, &mut temp_queue) {
                            eprintln!("[system] failed to read audio data: {e}");
                            continue;
                        }
                        if temp_queue.is_empty() {
                            continue;
                        }

                        let mut samples = Vec::with_capacity(temp_queue.len() / 4);
                        while temp_queue.len() >= 4 {
                            let bytes = [
                                temp_queue.pop_front().unwrap(),
                                temp_queue.pop_front().unwrap(),
                                temp_queue.pop_front().unwrap(),
                                temp_queue.pop_front().unwrap(),
                            ];
                            samples.push(f32::from_le_bytes(bytes));
                        }

                        if !samples.is_empty() {
                            let _ = producer.push_slice(&samples);
                        }
                    }
                }
                Err(e) => {
                    let _ = init_tx.send(Err(format!("{e}")));
                }
            }
            Ok(())
        }
    }

    impl Drop for SpeakerStream {
        fn drop(&mut self) {
            if let Ok(mut state) = self.waker_state.lock() {
                state.shutdown = true;
            }
            if let Some(handle) = self.capture_thread.take() {
                let _ = handle.join();
            }
        }
    }
}

#[cfg(windows)]
fn system_owner(
    device_id: Option<String>,
    stop: Arc<AtomicBool>,
    init_tx: mpsc::Sender<Result<u32, String>>,
    app: AppHandle,
) {
    match wasapi_loopback::SpeakerInput::new(device_id).and_then(|i| i.stream()) {
        Ok(mut stream) => {
            let rate = stream.sample_rate();
            let _ = init_tx.send(Ok(rate));
            if let Some(consumer) = stream.take_consumer() {
                run_dsp_loop(CHANNEL_SYSTEM, rate, consumer, stop, app, None);
            }
            // SpeakerStream dropped → shutdown flag + WASAPI thread joined.
        }
        Err(e) => {
            let _ = init_tx.send(Err(format!("{e}")));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn i16_le_bytes_are_little_endian() {
        assert_eq!(i16_slice_to_le_bytes(&[0x0102, -1]), vec![0x02, 0x01, 0xFF, 0xFF]);
    }

    #[test]
    fn normalize_strips_wasapi_index_prefix() {
        assert_eq!(normalize_device_name("(2- USB Audio Device)"), "usb audio device");
        assert_eq!(normalize_device_name("(15- Microphone)"), "microphone");
    }

    #[test]
    fn normalize_collapses_unicode_dashes() {
        assert_eq!(normalize_device_name("AirPods Pro – Hands-Free"), "airpods pro - hands-free");
        assert_eq!(normalize_device_name("AirPods Pro — Hands-Free"), "airpods pro - hands-free");
    }

    #[test]
    fn normalize_trims_and_lowercases() {
        assert_eq!(normalize_device_name("  AirPods Pro  "), "airpods pro");
        assert_eq!(normalize_device_name("AIRPODS PRO"), "airpods pro");
    }
}

// Live audio capture — port of reference `microphone.rs` + `speaker/windows.rs`
// + the DSP loop from reference `lib.rs`, adapted to emit Tauri events instead of
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
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
    // Starvation gates for the loopback keepalive synthesis (see 1b below):
    // last real sample drained, and last synthetic frame emitted.
    let mut last_real_audio = Instant::now();
    let mut last_synth = Instant::now();

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
        let mut drained = false;
        while let Some(sample) = consumer.try_pop() {
            raw_batch.push(sample);
            drained = true;
        }
        if drained {
            last_real_audio = Instant::now();
        }

        // 1b. Loopback starvation keepalives — WASAPI loopback delivers NO
        // packets during silence, so after speech ends this loop sees no
        // samples: the gate never runs again, no keepalives and no
        // SpeechEdge::Ended reach the server, and the server's endpointing
        // (which keys off incoming chunks) can't fire. Partials then hang at
        // ~70% confidence until the API's 10s stale watchdog force-flushes —
        // the reported "partial takes forever to go green, coach responds
        // late".
        //
        // STRICTLY gated and real-time paced:
        //  - `last_real_audio` >= 100ms: loopback packet gaps during active
        //    playback are ~10-40ms — a 100ms starvation means speech truly
        //    ended. Without this gate the synthesis interleaved zeros with
        //    speech at 4-5x real-time and stretched the whole audio
        //    timeline (the "transcription got slower" regression).
        //  - one 20ms zero-frame per 20ms of wall time (last_synth), so the
        //    suppressor's state machine — hangover expiry, Ended edge,
        //    100ms keepalives — advances on the TRUE clock, exactly like
        //    the CPAL mic path which always delivers real silence frames.
        if !drained
            && last_real_audio.elapsed() >= Duration::from_millis(100)
            && last_synth.elapsed() >= Duration::from_millis(20)
        {
            last_synth = Instant::now();
            let zero_frame = vec![0i16; chunk_size];
            let (action, edge) = suppressor.process_edges(&zero_frame);
            if matches!(action, FrameAction::SendSilence | FrameAction::Send(_)) {
                speech_flag.store(false, Ordering::Relaxed);
                rms_bits.store(0.0f32.to_bits(), Ordering::Relaxed);
                emitter.push(&vec![0u8; chunk_size * 2]);
            }
            if edge == SpeechEdge::Ended {
                emitter.flush();
            }
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
fn system_owner(
    device_id: Option<String>,
    stop: Arc<AtomicBool>,
    init_tx: mpsc::Sender<Result<u32, String>>,
    app: AppHandle,
) {
    // Dual-endpoint loopback: WASAPI splits each render device into Console /
    // Multimedia / Communications endpoints, and loopback only captures the
    // endpoint you bind. Meeting apps (Zoom/Teams/Meet) and OS read-aloud
    // (Word/Narrator) route through eCommunications; media players use
    // eMultimedia. Capturing only the default missed read-aloud entirely —
    // the reported "system does not detect OS audio" bug. Both endpoints are
    // captured concurrently and merged into one ring buffer.
    match dual_loopback::SpeakerInput::new(device_id).and_then(|i| i.stream()) {
        Ok(mut stream) => {
            let rate = stream.sample_rate();
            let _ = init_tx.send(Ok(rate));
            if let Some(consumer) = stream.take_consumer() {
                run_dsp_loop(CHANNEL_SYSTEM, rate, consumer, stop, app, None);
            }
        }
        Err(e) => {
            let _ = init_tx.send(Err(format!("{e}")));
        }
    }
}

/// Two WASAPI loopback captures (eMultimedia + eCommunications) merged into a
/// single sample stream, so ANY app's output reaches the interviewer channel.
/// Raw windows-rs: the wasapi crate hardcodes the eConsole role.
mod dual_loopback {
    use super::RING_BUFFER_SAMPLES;
    use anyhow::Result;
    use ringbuf::traits::{Producer, Split};
    use ringbuf::{HeapCons, HeapProd, HeapRb};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc, Mutex};
    use std::thread;
    use std::time::Duration;
    use windows::Win32::Media::Audio::{
        eCommunications, eMultimedia, eRender, ERole, IAudioCaptureClient, IAudioClient,
        IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator,
        AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
    };    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    /// One loopback capture bound to a specific role endpoint, pushing f32
    /// mono samples into the shared producer.
    fn capture_endpoint(
        role: ERole,
        producer: Arc<Mutex<HeapProd<f32>>>,
        stop: Arc<AtomicBool>,
        ready_tx: mpsc::Sender<Result<u32, String>>,
    ) -> thread::JoinHandle<()> {
        thread::Builder::new()
            .name(format!("loopback-{role:?}"))
            .spawn(move || {
                let run = (|| -> Result<()> {
                    unsafe {
                        CoInitializeEx(None, COINIT_MULTITHREADED)
                            .ok()
                            .map_err(|e| anyhow::anyhow!("COM: {e}"))?;
                        let enumerator: IMMDeviceEnumerator =
                            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                                .map_err(|e| anyhow::anyhow!("enumerator: {e}"))?;
                        let device: IMMDevice = enumerator
                            .GetDefaultAudioEndpoint(eRender, role)
                            .map_err(|e| anyhow::anyhow!("endpoint: {e}"))?;
                        let client: IAudioClient = device
                            .Activate(CLSCTX_ALL, None)
                            .map_err(|e| anyhow::anyhow!("activate: {e}"))?;
                        let mixformat = client.GetMixFormat().map_err(|e| anyhow::anyhow!("mixformat: {e}"))?;
                        let wfx = unsafe { &*mixformat };
                        let rate = wfx.nSamplesPerSec;
                        let channels = wfx.nChannels as usize;
                        let align = wfx.nBlockAlign as usize;
                        client
                            .Initialize(
                                AUDCLNT_SHAREMODE_SHARED,
                                AUDCLNT_STREAMFLAGS_LOOPBACK,
                                20_000_000, // 2s buffer, 100ns units
                                0,
                                wfx,
                                None,
                            )
                            .map_err(|e| anyhow::anyhow!("init: {e}"))?;
                        let capture: IAudioCaptureClient = client
                            .GetService()
                            .map_err(|e| anyhow::anyhow!("capture client: {e}"))?;
                        client.Start().map_err(|e| anyhow::anyhow!("start: {e}"))?;
                        let _ = ready_tx.send(Ok(rate));

                        loop {
                            if stop.load(Ordering::Relaxed) {
                                let _ = client.Stop();
                                return Ok(());
                            }
                            // 10ms poll: loopback delivers no events during silence.
                            thread::sleep(Duration::from_millis(10));
                            loop {
                                let packet = match capture.GetNextPacketSize() {
                                    Ok(n) => n,
                                    Err(_) => break,
                                };
                                if packet == 0 {
                                    break;
                                }
                                let mut frames_ptr: *mut u8 = std::ptr::null_mut();
                                let mut written = 0u32;
                                let mut flags = 0u32;
                                if capture
                                    .GetBuffer(&mut frames_ptr, &mut written, &mut flags, None, None)
                                    .is_err()
                                {
                                    break;
                                }
                                // GetBuffer returns FRAMES; mixformat is f32 interleaved,
                                // so float samples = frames x channels. (A bytes/4
                                // conversion here silently discarded 7/8 of every packet —
                                // the reported "system audio not captured" bug.)
                                let sample_count = written as usize * channels;
                                if sample_count > 0 {
                                    let data = std::slice::from_raw_parts(frames_ptr as *const f32, sample_count);
                                    if let Ok(mut p) = producer.lock() {
                                        if channels > 1 {
                                            for frame in data.chunks(channels) {
                                                let _ = p.try_push(frame[0]);
                                            }
                                        } else {
                                            for &s in data {
                                                let _ = p.try_push(s);
                                            }
                                        }
                                    }
                                }
                                let _ = capture.ReleaseBuffer(written);
                            }
                        }
                    }
                })();
                if let Err(e) = run {
                    eprintln!("[system:{role:?}] capture ended: {e}");
                }
            })
            .expect("spawn loopback thread")
    }

    pub struct SpeakerStream {
        consumer: Option<HeapCons<f32>>,
        stops: Vec<Arc<AtomicBool>>,
        handles: Vec<thread::JoinHandle<()>>,
        sample_rate: u32,
    }

    impl SpeakerStream {
        pub fn sample_rate(&self) -> u32 {
            self.sample_rate
        }
        pub fn take_consumer(&mut self) -> Option<HeapCons<f32>> {
            self.consumer.take()
        }
    }

    impl SpeakerInput {
        pub fn new(_device_id: Option<String>) -> Result<Self> {
            Ok(SpeakerInput)
        }

        /// Bind loopback to BOTH eMultimedia and eCommunications endpoints of
        /// the default render device; whichever carries audio, we get it.
        pub fn stream(self) -> Result<SpeakerStream> {
            let rb = HeapRb::<f32>::new(RING_BUFFER_SAMPLES * 2);
            let (producer, consumer) = rb.split();
            let producer = Arc::new(Mutex::new(producer));
            let stop = Arc::new(AtomicBool::new(false));

            let mut rates: Vec<u32> = Vec::new();
            let mut handles = Vec::new();
            for role in [eMultimedia, eCommunications] {
                let (tx, rx) = mpsc::channel();
                handles.push(capture_endpoint(role, producer.clone(), stop.clone(), tx));
                match rx.recv_timeout(Duration::from_secs(5)) {
                    Ok(Ok(r)) => rates.push(r),
                    Ok(Err(e)) => eprintln!("[system] endpoint {role:?} unavailable (continuing): {e}"),
                    Err(_) => eprintln!("[system] endpoint {role:?} init timeout (continuing)"),
                }
            }
            if rates.is_empty() {
                stop.store(true, Ordering::SeqCst);
                for h in handles {
                    let _ = h.join();
                }
                return Err(anyhow::anyhow!("no render endpoints available for loopback"));
            }
            let sample_rate = rates[0];
            Ok(SpeakerStream {
                consumer: Some(consumer),
                stops: vec![stop],
                handles,
                sample_rate,
            })
        }
    }

    pub struct SpeakerInput;

    impl Drop for SpeakerStream {
        fn drop(&mut self) {
            for s in &self.stops {
                s.store(true, Ordering::SeqCst);
            }
            for h in self.handles.drain(..) {
                let _ = h.join();
            }
        }
    }
}


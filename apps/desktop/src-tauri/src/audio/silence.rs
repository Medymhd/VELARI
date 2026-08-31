// Silence suppression for streaming STT â€” low latency, exact semantic port
// of reference `silence_suppression.rs`.
//
// TWO-STAGE GATING:
// 1. RMS volume check (fast, catches obvious silence)
// 2. WebRTC VAD (ML-based, rejects non-speech noise like typing/fans)
//
// PRINCIPLES: STT needs timing continuity (no gaps); keepalives during
// silence; speech frames NEVER delayed; hangover is for cost savings only.

use std::time::{Duration, Instant};
use webrtc_vad::{SampleRate as VadSampleRate, Vad, VadMode};

/// Configuration for silence suppression.
pub struct SilenceSuppressionConfig {
    /// Initial RMS threshold (seed for the adaptive threshold).
    pub speech_threshold_rms: f32,
    /// How long to keep sending full audio after speech ends.
    pub speech_hangover: Duration,
    /// Keepalive frame interval during silence.
    pub silence_keepalive_interval: Duration,
    /// Speech threshold multiplier above the noise-floor EMA.
    pub adaptive_multiplier: f32,
    /// Minimum adaptive threshold floor.
    pub adaptive_min_floor: f32,
    /// EMA smoothing factor (0..1). Lower = slower adaptation.
    pub ema_alpha: f32,
    /// Native sample rate of processed audio (for VAD decimation).
    pub native_sample_rate: u32,
    /// Whether to run the WebRTC VAD in addition to the RMS gate.
    pub use_vad: bool,
    pub vad_mode: VadMode,
}

impl Default for SilenceSuppressionConfig {
    fn default() -> Self {
        Self {
            speech_threshold_rms: 100.0,
            speech_hangover: Duration::from_millis(200),
            silence_keepalive_interval: Duration::from_millis(100),
            adaptive_multiplier: 3.0,
            adaptive_min_floor: 20.0,
            ema_alpha: 0.02,
            native_sample_rate: 48000,
            use_vad: true,
            vad_mode: VadMode::Quality,
        }
    }
}

impl SilenceSuppressionConfig {
    /// System audio: very permissive, VAD OFF â€” media/game audio is often
    /// non-human, which the ML VAD rigidly suppresses.
    pub fn for_system_audio() -> Self {
        Self {
            speech_threshold_rms: 30.0,
            speech_hangover: Duration::from_millis(600),
            silence_keepalive_interval: Duration::from_millis(100),
            adaptive_multiplier: 3.0,
            adaptive_min_floor: 10.0,
            ema_alpha: 0.02,
            native_sample_rate: 48000,
            use_vad: false,
            vad_mode: VadMode::Quality,
        }
    }

    /// Microphone: PLATFORM SPLIT on stage 2. Windows device DSP routinely
    /// pulls speech below what the VAD accepts (gate never opens â†’ only zero
    /// keepalives emitted), so VAD is OFF there; cloud STT runs its own
    /// speech detection and the adaptive RMS gate still suppresses idle mics.
    /// Non-Windows keeps VAD ON to reject typing/fans/speaker bleed.
    ///
    /// Note: `speech_threshold_rms` is only the INITIAL adaptive threshold;
    /// the suppressor starts Suppressed so the live knobs are
    /// `adaptive_min_floor` and `adaptive_multiplier`.
    pub fn for_microphone() -> Self {
        Self::for_microphone_on(cfg!(target_os = "windows"))
    }

    /// `for_microphone` with the platform decision injected so tests on ANY
    /// host exercise BOTH branches.
    pub fn for_microphone_on(is_windows: bool) -> Self {
        Self {
            speech_threshold_rms: 100.0,
            speech_hangover: Duration::from_millis(500),
            silence_keepalive_interval: Duration::from_millis(100),
            adaptive_multiplier: 3.0,
            adaptive_min_floor: 20.0,
            ema_alpha: 0.02,
            native_sample_rate: 48000,
            use_vad: !is_windows,
            vad_mode: VadMode::Quality,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum SuppressionState {
    Active,     // Speech detected, send everything
    Hangover,   // Speech ended recently, still sending
    Suppressed, // Confirmed silence, send keepalives only
}

/// Result of processing a frame.
#[derive(Debug, Clone)]
pub enum FrameAction {
    /// Send this frame to STT.
    Send(Vec<i16>),
    /// Replace with a silence keepalive frame.
    SendSilence,
    /// Suppress this frame (timing maintained by keepalives).
    Suppress,
}

/// Speech edge observed on a processed frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpeechEdge {
    None,
    /// First speech frame after silence.
    Started,
    /// Hangover elapsed after the last speech frame.
    Ended,
}

/// Silence suppression state machine with adaptive threshold + WebRTC VAD.
pub struct SilenceSuppressor {
    config: SilenceSuppressionConfig,
    state: SuppressionState,
    last_speech_time: Instant,
    last_keepalive_time: Instant,
    /// EMA of ambient noise-floor RMS.
    noise_floor_ema: f32,
    /// Current adaptive speech threshold.
    adaptive_threshold: f32,
    /// Whether the previous frame was speech (edge detection).
    was_speaking: bool,
    /// WebRTC VAD (ML-based, 16kHz).
    vad: Vad,
    /// native_sample_rate / 16000 (may be non-integer, e.g. 2.75625).
    decimation_factor: f64,
    /// Reusable decimated-16kHz scratch buffer.
    vad_buf: Vec<i16>,
}

impl SilenceSuppressor {
    pub fn new(config: SilenceSuppressionConfig) -> Self {
        let now = Instant::now();
        let initial_threshold = config.speech_threshold_rms;
        let decimation_factor = config.native_sample_rate as f64 / 16000.0;

        let mode_clone = match &config.vad_mode {
            VadMode::Quality => VadMode::Quality,
            VadMode::LowBitrate => VadMode::LowBitrate,
            VadMode::Aggressive => VadMode::Aggressive,
            VadMode::VeryAggressive => VadMode::VeryAggressive,
        };
        let vad = Vad::new_with_rate_and_mode(VadSampleRate::Rate16kHz, mode_clone);

        Self {
            noise_floor_ema: config.adaptive_min_floor,
            adaptive_threshold: initial_threshold,
            vad_buf: Vec::with_capacity(480), // max VAD frame @16kHz (30ms)
            decimation_factor,
            vad,
            config,
            // MUST start suppressed to avoid a false speech_ended on startup.
            state: SuppressionState::Suppressed,
            last_speech_time: now,
            last_keepalive_time: now,
            // Prevents a false edge immediately after init.
            was_speaking: false,
        }
    }

    /// Thin wrapper returning `speech_just_ended` (kept as a test hook).
    #[cfg(test)]
    pub fn process(&mut self, frame: &[i16]) -> (FrameAction, bool) {
        let (action, edge) = self.process_edges(frame);
        (action, edge == SpeechEdge::Ended)
    }

    /// `process` with BOTH edges reported. `Started` fires on the first
    /// speech frame after silence; `Ended` on the hangover-expiry frame.
    pub fn process_edges(&mut self, frame: &[i16]) -> (FrameAction, SpeechEdge) {
        let now = Instant::now();
        let rms = calculate_rms(frame);

        // TWO-STAGE GATE: RMS first (cheap), then WebRTC VAD.
        let has_speech = if rms >= self.adaptive_threshold {
            if self.config.use_vad {
                self.is_voice(frame)
            } else {
                true
            }
        } else {
            false
        };

        // ALWAYS check for speech first â€” immediate response, zero added latency.
        if has_speech {
            self.state = SuppressionState::Active;
            self.last_speech_time = now;
            let edge = if self.was_speaking { SpeechEdge::None } else { SpeechEdge::Started };
            self.was_speaking = true;
            return (FrameAction::Send(frame.to_vec()), edge);
        }

        // No speech â€” check hangover state.
        let mut speech_just_ended = false;
        match self.state {
            SuppressionState::Active | SuppressionState::Hangover => {
                if now.duration_since(self.last_speech_time) > self.config.speech_hangover {
                    self.state = SuppressionState::Suppressed;
                    if self.was_speaking {
                        speech_just_ended = true;
                        self.was_speaking = false;
                    }
                } else {
                    // Still in hangover â€” send full frame.
                    self.state = SuppressionState::Hangover;
                    return (FrameAction::Send(frame.to_vec()), SpeechEdge::None);
                }
            }
            SuppressionState::Suppressed => {}
        }

        // Adapt the noise floor only during confirmed silence.
        let alpha = self.config.ema_alpha;
        self.noise_floor_ema = self.noise_floor_ema * (1.0 - alpha) + rms * alpha;
        self.adaptive_threshold = (self.noise_floor_ema * self.config.adaptive_multiplier)
            .max(self.config.adaptive_min_floor);

        let edge = if speech_just_ended { SpeechEdge::Ended } else { SpeechEdge::None };
        if now.duration_since(self.last_keepalive_time) >= self.config.silence_keepalive_interval {
            self.last_keepalive_time = now;
            (FrameAction::SendSilence, edge)
        } else {
            (FrameAction::Suppress, edge)
        }
    }

    /// Decimate the native-rate frame to ~16kHz and run the WebRTC VAD.
    /// VAD requires exactly 160/320/480 samples at 16kHz; the closest valid
    /// size is chosen, handling non-integer ratios (e.g. 44.1kHz).
    #[inline]
    fn is_voice(&mut self, frame: &[i16]) -> bool {
        self.vad_buf.clear();

        let factor = self.decimation_factor;
        if factor <= 1.0 {
            self.vad_buf.extend_from_slice(frame);
        } else {
            let mut pos = 0.0_f64;
            while (pos as usize) < frame.len() {
                self.vad_buf.push(frame[pos as usize]);
                pos += factor;
            }
        }

        let len = self.vad_buf.len();
        let target = if len >= 480 {
            480
        } else if len >= 320 {
            320
        } else if len >= 160 {
            160
        } else {
            // Too small for VAD â€” fall back to RMS-only.
            return true;
        };

        match self.vad.is_voice_segment(&self.vad_buf[..target]) {
            Ok(is_voice) => is_voice,
            Err(_) => true, // never block audio on a VAD error
        }
    }

    pub fn is_speech(&self) -> bool {
        matches!(self.state, SuppressionState::Active | SuppressionState::Hangover)
    }

    /// Current adaptive threshold (test hook for the EMA behavior).
    #[cfg(test)]
    pub fn adaptive_threshold(&self) -> f32 {
        self.adaptive_threshold
    }
}

/// RMS of i16 samples (every 4th sample â€” plenty for RMS).
fn calculate_rms(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_of_squares: f64 = samples
        .iter()
        .step_by(4)
        .map(|&s| (s as f64) * (s as f64))
        .sum();
    let count = (samples.len() + 3) / 4;
    (sum_of_squares / count as f64).sqrt() as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_speech_immediate() {
        let mut suppressor = SilenceSuppressor::new(SilenceSuppressionConfig {
            native_sample_rate: 16000,
            ..SilenceSuppressionConfig::default()
        });

        let loud_frame: Vec<i16> = (0..320)
            .map(|i| ((i as f32 * 0.1).sin() * 10000.0) as i16)
            .collect();
        let (action, ended) = suppressor.process(&loud_frame);
        assert!(matches!(action, FrameAction::Send(_)));
        assert!(!ended, "Speech should not have 'ended' on a loud frame");
        assert!(suppressor.is_speech());
    }

    #[test]
    fn test_silence_keepalive() {
        let mut suppressor = SilenceSuppressor::new(SilenceSuppressionConfig {
            speech_threshold_rms: 100.0,
            speech_hangover: Duration::from_millis(0),
            silence_keepalive_interval: Duration::from_millis(50),
            adaptive_multiplier: 3.0,
            adaptive_min_floor: 20.0,
            ema_alpha: 0.02,
            native_sample_rate: 16000,
            use_vad: true,
            vad_mode: VadMode::Quality,
        });

        let silent_frame: Vec<i16> = vec![0; 320];
        let (action, _ended) = suppressor.process(&silent_frame);
        assert!(matches!(
            action,
            FrameAction::SendSilence | FrameAction::Suppress
        ));
    }

    #[test]
    fn test_speech_started_edge_fires_once_per_utterance() {
        let mut s = SilenceSuppressor::new(SilenceSuppressionConfig {
            use_vad: false,
            speech_hangover: Duration::from_millis(0),
            ..SilenceSuppressionConfig::default()
        });
        let loud: Vec<i16> = vec![10_000; 320];
        let quiet: Vec<i16> = vec![0; 320];

        let (_, e) = s.process_edges(&loud);
        assert_eq!(e, SpeechEdge::Started, "first speech frame is the rising edge");
        let (_, e) = s.process_edges(&loud);
        assert_eq!(e, SpeechEdge::None, "sustained speech is not a new edge");
        let (_, e) = s.process_edges(&quiet);
        assert_eq!(e, SpeechEdge::Ended);
        let (_, e) = s.process_edges(&quiet);
        assert_eq!(e, SpeechEdge::None, "sustained silence is not a new edge");
        let (_, e) = s.process_edges(&loud);
        assert_eq!(e, SpeechEdge::Started, "a second utterance rises again");
    }

    #[test]
    fn test_speech_ended_detection() {
        let mut suppressor = SilenceSuppressor::new(SilenceSuppressionConfig {
            speech_threshold_rms: 100.0,
            speech_hangover: Duration::from_millis(0),
            silence_keepalive_interval: Duration::from_millis(50),
            adaptive_multiplier: 3.0,
            adaptive_min_floor: 20.0,
            ema_alpha: 0.02,
            native_sample_rate: 16000,
            use_vad: true,
            vad_mode: VadMode::Quality,
        });

        let loud_frame: Vec<i16> = (0..320)
            .map(|i| ((i as f32 * 0.1).sin() * 10000.0) as i16)
            .collect();
        let (_, ended) = suppressor.process(&loud_frame);
        assert!(!ended, "Speech should not end on a loud frame");

        let silent_frame: Vec<i16> = vec![0; 320];
        let (_, ended) = suppressor.process(&silent_frame);
        assert!(ended, "Speech should have ended on transition to silence");

        let (_, ended) = suppressor.process(&silent_frame);
        assert!(!ended, "Speech_ended should only fire once per transition");
    }

    /// The mic VAD split is platform-scoped on purpose; assert BOTH branches
    /// from whichever host runs the suite.
    #[test]
    fn test_microphone_vad_is_platform_scoped() {
        assert!(
            !SilenceSuppressionConfig::for_microphone_on(true).use_vad,
            "Windows mic must bypass the WebRTC VAD (device DSP starves it)"
        );
        assert!(
            SilenceSuppressionConfig::for_microphone_on(false).use_vad,
            "non-Windows mic must keep the WebRTC VAD (typing/fan/bleed rejection)"
        );

        assert_eq!(
            SilenceSuppressionConfig::for_microphone().use_vad,
            !cfg!(target_os = "windows")
        );

        let win = SilenceSuppressionConfig::for_microphone_on(true);
        let mac = SilenceSuppressionConfig::for_microphone_on(false);
        assert_eq!(win.speech_threshold_rms, mac.speech_threshold_rms);
        assert_eq!(win.speech_hangover, mac.speech_hangover);
        assert_eq!(win.adaptive_multiplier, mac.adaptive_multiplier);
        assert_eq!(win.adaptive_min_floor, mac.adaptive_min_floor);
        assert_eq!(win.ema_alpha, mac.ema_alpha);

        assert!(!SilenceSuppressionConfig::for_system_audio().use_vad);
    }

    /// The initial speech_threshold_rms is NOT the gate: one non-speech frame
    /// replaces it with the adaptive value.
    #[test]
    fn test_initial_threshold_is_superseded_by_adaptive() {
        let mut suppressor = SilenceSuppressor::new(SilenceSuppressionConfig {
            speech_threshold_rms: 50.0,
            native_sample_rate: 16000,
            ..SilenceSuppressionConfig::for_microphone()
        });
        assert_eq!(suppressor.adaptive_threshold(), 50.0, "seeded from the initial value");

        let silent_frame: Vec<i16> = vec![0; 320];
        let _ = suppressor.process(&silent_frame);

        let expected = (20.0_f32 * 0.98) * 3.0; // ema decays from min_floor toward 0
        assert!(
            (suppressor.adaptive_threshold() - expected).abs() < 0.5,
            "adaptive threshold {} should have replaced the initial 50.0",
            suppressor.adaptive_threshold()
        );
        assert!(
            suppressor.adaptive_threshold() > 50.0,
            "the adaptive gate sits ABOVE a 'lowered' initial value"
        );
    }
}

// Audio configuration constants — port of reference `audio_config.rs`.
// Tuned for low-latency streaming STT.

/// Canonical pipeline sample rate. All STT providers receive audio at this
/// rate, produced once (anti-aliased) by the rubato resampler in the DSP loop.
pub const SAMPLE_RATE: u32 = 16_000;

/// Frame duration in milliseconds (20ms = good latency vs overhead balance).
pub const FRAME_MS: u32 = 20;

/// DSP thread poll interval in milliseconds (fallback timeout).
pub const DSP_POLL_MS: u64 = 5;

/// Ring buffer size in samples (~680ms headroom at 48kHz).
pub const RING_BUFFER_SAMPLES: usize = 32_768;

/// Coalesce N 20ms frames per emitted batch (cuts event-boundary crossings 3x).
pub const CHUNK_BATCH_COUNT: usize = 3;
pub const CHUNK_BATCH_TIMEOUT_MS: u128 = 100;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_geometry_is_consistent() {
        // 20ms @ 16kHz = 320 samples — the framing every stage relies on.
        assert_eq!((SAMPLE_RATE as usize / 1000) * FRAME_MS as usize, 320);
    }
}

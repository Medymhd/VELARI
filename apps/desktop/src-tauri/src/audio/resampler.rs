use anyhow::Result;
use rubato::{FftFixedIn, Resampler as RubatoResampler};

/// High-quality anti-aliased resampler (rubato FftFixedIn).
/// Converts f32 audio from the input rate to 16kHz i16 output.
pub struct Resampler {
    resampler: FftFixedIn<f32>,
    input_buffer: Vec<Vec<f32>>,
    output_buffer: Vec<Vec<f32>>,
}

impl Resampler {
    pub fn new(input_sample_rate: f64) -> Result<Self> {
        let output_sample_rate = 16000.0_f64;
        let resampler = FftFixedIn::<f32>::new(
            input_sample_rate as usize,
            output_sample_rate as usize,
            1024, // chunk size (internal buffer)
            2,    // sub-chunks for better quality
            1,    // mono
        )
        .map_err(|e| anyhow::anyhow!("Failed to create resampler: {}", e))?;

        Ok(Self {
            resampler,
            input_buffer: vec![Vec::new()],
            output_buffer: vec![Vec::new()],
        })
    }

    /// Resample f32 audio to i16 at 16kHz (streaming; buffers partial chunks).
    /// Named `resample_to_i16` to avoid colliding with rubato's trait method.
    pub fn resample_to_i16(&mut self, input_data: &[f32]) -> Result<Vec<i16>> {
        if input_data.is_empty() {
            return Ok(Vec::new());
        }

        self.input_buffer[0].extend_from_slice(input_data);

        let mut output_samples = Vec::new();
        let frames_needed = self.resampler.input_frames_next();

        while self.input_buffer[0].len() >= frames_needed {
            let chunk: Vec<f32> = self.input_buffer[0].drain(0..frames_needed).collect();
            let input_chunk = vec![chunk];

            let output_frames = self.resampler.output_frames_next();
            self.output_buffer[0].resize(output_frames, 0.0);

            match self
                .resampler
                .process_into_buffer(&input_chunk, &mut self.output_buffer, None)
            {
                Ok((_, out_len)) => {
                    for i in 0..out_len {
                        let sample = self.output_buffer[0][i];
                        let scaled = (sample * 32767.0).clamp(-32768.0, 32767.0);
                        output_samples.push(scaled as i16);
                    }
                }
                Err(e) => {
                    eprintln!("[Resampler] Process error: {}", e);
                }
            }
        }

        Ok(output_samples)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    /// Generate `n` samples of a sine at `freq` Hz sampled at `rate` Hz.
    fn sine(freq: f64, rate: f64, n: usize) -> Vec<f32> {
        (0..n)
            .map(|i| (2.0 * PI * freq * (i as f64) / rate).sin() as f32 * 0.8)
            .collect()
    }

    /// Goertzel single-bin power for `target` Hz in an i16 signal at `rate` Hz.
    fn bin_power(samples: &[i16], rate: f64, target: f64) -> f64 {
        if samples.is_empty() {
            return 0.0;
        }
        let n = samples.len();
        let k = (target / rate) * n as f64;
        let w = 2.0 * PI * k / n as f64;
        let coeff = 2.0 * w.cos();
        let (mut s1, mut s2) = (0.0_f64, 0.0_f64);
        for &x in samples {
            let s0 = (x as f64 / 32768.0) + coeff * s1 - s2;
            s2 = s1;
            s1 = s0;
        }
        (s1 * s1 + s2 * s2 - coeff * s1 * s2).abs() / (n as f64)
    }

    fn feed(input_rate: f64, input: &[f32]) -> Vec<i16> {
        let mut r = Resampler::new(input_rate).expect("resampler ctor");
        // Feed in streaming-sized blocks to mirror real DSP usage.
        let mut out = Vec::new();
        for chunk in input.chunks(512) {
            out.extend(r.resample_to_i16(chunk).expect("resample"));
        }
        out
    }

    #[test]
    fn resamples_48k_to_16k_preserves_in_band_tone() {
        let input = sine(1000.0, 48000.0, 48000); // 1s
        let out = feed(48000.0, &input);
        assert!(!out.is_empty(), "expected resampled output");
        let in_band = bin_power(&out, 16000.0, 1000.0);
        assert!(in_band > 1e-3, "1kHz tone lost after 48k->16k: {}", in_band);
    }

    #[test]
    fn resamples_48k_to_16k_rejects_above_nyquist_alias() {
        // 11kHz is above the 8kHz output Nyquist; a naive decimator folds it
        // to ~5kHz. A proper anti-aliased resampler attenuates it.
        let input = sine(11000.0, 48000.0, 48000);
        let out = feed(48000.0, &input);
        assert!(!out.is_empty());
        let alias = bin_power(&out, 16000.0, 5000.0);
        let reference = bin_power(&feed(48000.0, &sine(1000.0, 48000.0, 48000)), 16000.0, 1000.0);
        assert!(
            alias < reference * 0.1,
            "alias from 11kHz not attenuated: alias={} reference={}",
            alias,
            reference
        );
    }

    #[test]
    fn resamples_24k_to_16k_non_integer_ratio_preserves_tone() {
        // Bluetooth headset (HFP) case: 24kHz native, factor 1.5
        // (non-integer) — the ratio naive decimators corrupt.
        let input = sine(1000.0, 24000.0, 24000); // 1s
        let out = feed(24000.0, &input);
        assert!(!out.is_empty(), "expected output for 24k->16k");
        let in_band = bin_power(&out, 16000.0, 1000.0);
        assert!(in_band > 1e-3, "1kHz tone lost after 24k->16k: {}", in_band);
    }

    #[test]
    fn resamples_24k_to_16k_rejects_alias() {
        // 10kHz at 24kHz native is above output Nyquist; must not fold to 6kHz.
        let input = sine(10000.0, 24000.0, 24000);
        let out = feed(24000.0, &input);
        let alias = bin_power(&out, 16000.0, 6000.0);
        let reference = bin_power(&feed(24000.0, &sine(1000.0, 24000.0, 24000)), 16000.0, 1000.0);
        assert!(
            alias < reference * 0.15,
            "alias from 10kHz not attenuated: alias={} reference={}",
            alias,
            reference
        );
    }

    #[test]
    fn output_length_approximates_target_rate() {
        let input = sine(1000.0, 48000.0, 48000);
        let out = feed(48000.0, &input);
        let ratio = out.len() as f64 / 16000.0;
        assert!(
            ratio > 0.9 && ratio < 1.1,
            "expected ~16000 output samples, got {}",
            out.len()
        );
    }
}

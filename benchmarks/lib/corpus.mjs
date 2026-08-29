/**
 * Deterministic synthetic STT corpus: PCM16 mono 16 kHz with speech-like
 * bursts (harmonic stacks), noise, and pauses — plus a WAV writer. Good
 * enough to exercise gates and measure timing; real-corpus WER uses files
 * dropped into benchmarks/corpus/.
 */

const SR = 16_000;

/** One utterance: 0.9s harmonic burst, 0.3s gap, 0.6s burst, 0.5s pause. */
export function utterance(seed = 1) {
  const out = [];
  const tone = (freq, n, amp) => {
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const v =
        Math.sin(2 * Math.PI * freq * t) * 0.5 +
        Math.sin(2 * Math.PI * freq * 2 * t) * 0.25 +
        Math.sin(2 * Math.PI * freq * 3 * t) * 0.125;
      out.push(Math.max(-32768, Math.min(32767, Math.round(v * amp * 32767))));
    }
  };
  tone(140 + (seed % 7) * 20, SR * 0.9, 0.5);
  silence(out, SR * 0.3);
  tone(180 + (seed % 5) * 25, SR * 0.6, 0.45);
  silence(out, SR * 0.5);
  return out;
}

export function noise(n = SR, amp = 0.02) {
  const out = [];
  let s = 12345;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out.push(Math.round((((s / 0x7fffffff) * 2 - 1) * amp * 32767) | 0));
  }
  return out;
}

function silence(out, n) {
  for (let i = 0; i < n; i++) out.push(0);
}

/** Full session pattern: 6 utterances separated by noise beds. */
export function session() {
  const out = [];
  for (let i = 1; i <= 6; i++) {
    out.push(...utterance(i));
    out.push(...noise(SR * 0.4));
  }
  return Int16Array.from(out);
}

export function wavFromPcm16(pcm, sampleRate = SR) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length * 2, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length * 2, 40);
  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}

export function toBuffers(int16, chunkSamples = 320) {
  const chunks = [];
  for (let i = 0; i < int16.length; i += chunkSamples) {
    chunks.push(Buffer.from(int16.buffer, i * 2, Math.min(chunkSamples, int16.length - i) * 2));
  }
  return chunks;
}

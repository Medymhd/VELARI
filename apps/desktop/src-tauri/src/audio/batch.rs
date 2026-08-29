// BatchEmitter — coalesces up to CHUNK_BATCH_COUNT DSP frames into a single
// callback invocation. Each callback crosses the Rust→host boundary (here:
// a Tauri event emit + base64 encode); batching 3 frames (=60ms of audio)
// cuts crossings 3x with no perceptible STT-side latency. The timeout guard
// flushes a partial batch so trailing speech is not held up in light traffic.

use std::time::{Duration, Instant};

use super::config::{CHUNK_BATCH_COUNT, CHUNK_BATCH_TIMEOUT_MS};

pub struct BatchEmitter<S: FnMut(Vec<u8>)> {
    buffer: Vec<u8>,
    frames: usize,
    first_push_at: Option<Instant>,
    batch_count: usize,
    batch_timeout: Duration,
    send: S,
}

impl<S: FnMut(Vec<u8>)> BatchEmitter<S> {
    pub fn new(estimated_chunk_bytes: usize, send: S) -> Self {
        Self::with_timings(
            estimated_chunk_bytes,
            CHUNK_BATCH_COUNT,
            Duration::from_millis(CHUNK_BATCH_TIMEOUT_MS as u64),
            send,
        )
    }

    pub fn with_timings(
        estimated_chunk_bytes: usize,
        batch_count: usize,
        batch_timeout: Duration,
        send: S,
    ) -> Self {
        Self {
            buffer: Vec::with_capacity(estimated_chunk_bytes * batch_count),
            frames: 0,
            first_push_at: None,
            batch_count,
            batch_timeout,
            send,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        if self.first_push_at.is_none() {
            self.first_push_at = Some(Instant::now());
        }
        self.buffer.extend_from_slice(bytes);
        self.frames += 1;
        if self.frames >= self.batch_count {
            self.flush();
        }
    }

    pub fn maybe_flush_timeout(&mut self) {
        if let Some(t) = self.first_push_at {
            if t.elapsed() >= self.batch_timeout {
                self.flush();
            }
        }
    }

    pub fn flush(&mut self) {
        if self.buffer.is_empty() {
            self.first_push_at = None;
            self.frames = 0;
            return;
        }
        // Move the contents out (keeping the allocation for the next batch).
        let take = std::mem::take(&mut self.buffer);
        self.buffer.reserve(take.capacity());
        (self.send)(take);
        self.frames = 0;
        self.first_push_at = None;
    }

    #[cfg(test)]
    pub fn pending_frames(&self) -> usize {
        self.frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn flushes_on_count() {
        let out: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = out.clone();
        let mut em = BatchEmitter::new(320 * 2, move |b| sink.lock().unwrap().push(b));

        em.push(&[1u8; 640]);
        em.push(&[2u8; 640]);
        assert_eq!(em.pending_frames(), 2);
        assert!(out.lock().unwrap().is_empty(), "no flush before batch count");
        em.push(&[3u8; 640]);
        let batches = out.lock().unwrap();
        assert_eq!(batches.len(), 1, "flushes exactly on the 3rd frame");
        assert_eq!(batches[0].len(), 640 * 3);
    }

    #[test]
    fn flushes_on_timeout() {
        let out: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = out.clone();
        let mut em = BatchEmitter::with_timings(
            320 * 2,
            3,
            Duration::from_millis(20),
            move |b| sink.lock().unwrap().push(b),
        );
        em.push(&[9u8; 640]);
        assert!(out.lock().unwrap().is_empty());
        std::thread::sleep(Duration::from_millis(40));
        em.maybe_flush_timeout();
        assert_eq!(out.lock().unwrap().len(), 1, "partial batch ages out");
        assert_eq!(em.pending_frames(), 0);
    }

    #[test]
    fn explicit_flush_emits_partial_batch() {
        let out: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = out.clone();
        let mut em = BatchEmitter::new(320 * 2, move |b| sink.lock().unwrap().push(b));
        em.push(&[7u8; 100]);
        em.flush();
        assert_eq!(out.lock().unwrap().len(), 1);
        // Flushing an empty emitter is a no-op.
        em.flush();
        assert_eq!(out.lock().unwrap().len(), 1);
    }
}

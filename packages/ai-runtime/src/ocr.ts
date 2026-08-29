/**
 * OCR provider — port of rival `OcrProvider.ts` (tesseract.js).
 * Fallback when vision is denied (`private_vision` mode); the worker is
 * cached and the factory is injectable so tests never touch the network.
 */
export interface OcrResult {
  text: string;
  confidence: number; // 0..1
}

export interface OcrWorker {
  recognize(image: Buffer | string): Promise<{ data: { text?: string; confidence?: number } }>;
  terminate(): Promise<unknown>;
}

type WorkerFactory = (lang: string) => Promise<OcrWorker>;

let cachedWorker: OcrWorker | null = null;
let injectedFactory: WorkerFactory | null = null;

/** Test seam: inject a fake worker factory (null restores tesseract.js). */
export function setOcrWorkerFactory(factory: WorkerFactory | null): void {
  injectedFactory = factory;
  cachedWorker = null;
}

async function getWorker(lang = "eng"): Promise<OcrWorker> {
  if (cachedWorker) return cachedWorker;
  if (injectedFactory) {
    cachedWorker = await injectedFactory(lang);
    return cachedWorker;
  }
  const { createWorker } = await import("tesseract.js");
  cachedWorker = await createWorker(lang);
  return cachedWorker;
}

export async function ocrImage(base64: string): Promise<OcrResult> {
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(Buffer.from(base64, "base64"));
    return {
      text: (data.text ?? "").trim(),
      confidence: Math.min(1, Math.max(0, (data.confidence ?? 0) / 100)),
    };
  } catch {
    // OCR must never break the vision pipeline; empty result = degraded mode.
    return { text: "", confidence: 0 };
  }
}

export async function ocrWithFallback(base64: string, visionDenied: boolean): Promise<OcrResult | null> {
  if (!visionDenied) return null;
  return ocrImage(base64);
}

/**
 * TTS seam — contract only (rival has no TTS yet, spec §5 reserves `tts`).
 * Keep as typed no-op so future verticals can plug ElevenLabs/OpenAI TTS without churn.
 */
export interface TtsRequest {
  text: string;
  voice?: string;
  format?: "mp3" | "pcm_s16le_16k";
}

export interface TtsResult {
  audioBase64: string;
  mimeType: string;
}

export async function synthesize(_req: TtsRequest): Promise<TtsResult> {
  throw new Error("TTS not configured — add provider (e.g. ElevenLabs) and wire via ai-runtime");
}

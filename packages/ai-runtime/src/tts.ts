/**
 * TTS — OpenAI-compatible `/v1/audio/speech` endpoint via env config.
 * Free-first: falls back to browser Web Speech API on the client side; this
 * server-side module handles the cloud/local TTS rung. ElevenLabs also
 * speaks this protocol with a base-url swap.
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

export async function synthesize(req: TtsRequest): Promise<TtsResult> {
  const baseUrl = process.env.TTS_BASE_URL;
  const apiKey = process.env.TTS_API_KEY;
  const model = process.env.TTS_MODEL ?? "tts-1";
  const voice = req.voice ?? process.env.TTS_VOICE ?? "alloy";

  if (!baseUrl || !apiKey) {
    throw new Error("TTS not configured — set TTS_BASE_URL and TTS_API_KEY");
  }

  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/audio/speech`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      input: req.text.slice(0, 4096),
      voice,
      response_format: req.format === "pcm_s16le_16k" ? "pcm" : "mp3",
    }),
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    audioBase64: buf.toString("base64"),
    mimeType: req.format === "pcm_s16le_16k" ? "audio/pcm" : "audio/mpeg",
  };
}

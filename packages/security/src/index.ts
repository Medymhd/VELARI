/**
 * App security primitives.
 * - Envelope encryption for BYOK secrets (AES-256-GCM).
 * - Policy checks enforcing privacy modes before any provider call.
 * No plaintext secret is ever persisted or returned by any API surface.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export interface SealedSecret {
  /** Format: v1.<iv_b64>.<tag_b64>.<ciphertext_b64> â€” stored as secret_ref. */
  sealed: string;
}

export class SecretBox {
  private readonly key: Buffer;

  /**
   * Accepts 32-byte hex master key; falls back to SHA-256 of the provided
   * value so dev environments with arbitrary strings still work safely.
   */
  constructor(masterKeyMaterial: string) {
    if (/^[0-9a-f]{64}$/i.test(masterKeyMaterial)) {
      this.key = Buffer.from(masterKeyMaterial, "hex");
    } else {
      this.key = createHash("sha256").update(masterKeyMaterial).digest();
    }
  }

  seal(plaintext: string): SealedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { sealed: `v1.${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}` };
  }

  open(sealedRef: string): string {
    const [version, ivB64, tagB64, ctB64] = sealedRef.split(".");
    if (version !== "v1" || !ivB64 || !tagB64 || !ctB64) {
      throw new Error("malformed sealed secret");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }
}

/** Redact anything that looks like an API key/token before logging. */
export function redactSecretLike(input: string): string {
  return input
    .replace(/(sk|rk|pk|api[_-]?key|token|bearer)\S{8,}/gi, "[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[REDACTED]");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export type PrivacyMode = "local_only" | "byok_only" | "managed_allowed";
export type CandidatePrivacy = "local" | "byok" | "managed";

/** Hard gate evaluated before routing; mirrors ai-runtime soft scoring. */
export function privacyAllows(mode: PrivacyMode, candidate: CandidatePrivacy): boolean {
  switch (mode) {
    case "local_only":
      return candidate === "local";
    case "byok_only":
      return candidate !== "managed";
    case "managed_allowed":
      return true;
  }
}


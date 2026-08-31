/**
 * Image optimizer — port of reference `ImageOptimizer.ts` + `ScreenshotHelper.getImagePreview`
 * (sharp: EXIF-aware rotate, resize to provider limits, jpeg compress).
 */
import sharp from "sharp";

export interface OptimizeOptions {
  maxLongEdge?: number;
  quality?: number;
}

export async function optimizeImage(base64: string, opts: OptimizeOptions = {}): Promise<string> {
  if (!base64 || base64.length < 10) throw new Error("invalid image");
  const maxEdge = opts.maxLongEdge ?? 1024;
  const out = await sharp(Buffer.from(base64, "base64"))
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: opts.quality ?? 70 })
    .toBuffer();
  return out.toString("base64");
}

/** FNV-1a 32-bit dedup hash — mirrors reference `ImageHashService.ts`. */
export function imageHash(base64: string): string {
  let h = 2166136261;
  for (let i = 0; i < Math.min(base64.length, 4096); i++) {
    h ^= base64.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

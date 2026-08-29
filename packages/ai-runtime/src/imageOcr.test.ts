import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { optimizeImage, imageHash } from "./image.js";
import { ocrImage, ocrWithFallback, setOcrWorkerFactory, type OcrWorker } from "./ocr.js";

test("optimizeImage resizes oversized images and emits jpeg", async () => {
  const wide = await sharp({
    create: { width: 2000, height: 600, channels: 3, background: { r: 40, g: 90, b: 200 } },
  })
    .png()
    .toBuffer();
  const out = await optimizeImage(wide.toString("base64"), { maxLongEdge: 480, quality: 70 });
  const meta = await sharp(Buffer.from(out, "base64")).metadata();
  assert.equal(meta.format, "jpeg");
  assert.ok(Math.max(meta.width ?? 0, meta.height ?? 0) <= 480, "long edge clamped");
});

test("optimizeImage never upscales and rejects garbage", async () => {
  const tiny = await sharp({
    create: { width: 40, height: 30, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .png()
    .toBuffer();
  const out = await optimizeImage(tiny.toString("base64"));
  const meta = await sharp(Buffer.from(out, "base64")).metadata();
  assert.equal(meta.width, 40, "withoutEnlargement keeps small images");
  await assert.rejects(() => optimizeImage("not-an-image"));
});

test("imageHash is stable and input-sensitive", () => {
  assert.equal(imageHash("velari"), imageHash("velari"));
  assert.notEqual(imageHash("velari"), imageHash("velari2"));
});

test("ocrImage maps worker output to text + normalized confidence", async () => {
  const fake: OcrWorker = {
    recognize: async () => ({ data: { text: "  hello world  ", confidence: 87 } }),
    terminate: async () => {},
  };
  setOcrWorkerFactory(() => Promise.resolve(fake));
  const r = await ocrImage("aGVsbG8=");
  assert.equal(r.text, "hello world");
  assert.equal(r.confidence, 0.87);
  setOcrWorkerFactory(null);
});

test("ocr failures degrade to empty instead of throwing", async () => {
  setOcrWorkerFactory(() => Promise.reject(new Error("worker init failed")));
  const r = await ocrImage("aGVsbG8=");
  assert.deepEqual(r, { text: "", confidence: 0 });
  setOcrWorkerFactory(null);
});

test("ocrWithFallback only runs when vision is denied", async () => {
  let called = 0;
  setOcrWorkerFactory(() => {
    called += 1;
    return Promise.reject(new Error("unused"));
  });
  assert.equal(await ocrWithFallback("x", false), null);
  await ocrWithFallback("x", true);
  assert.equal(called, 1, "runs only in the vision-denied path");
  setOcrWorkerFactory(null);
});

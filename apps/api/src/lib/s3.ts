import { S3Client, PutObjectCommand, GetObjectCommand, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";

const endpoint = process.env.S3_ENDPOINT ?? "http://localhost:9000";
const accessKey = process.env.S3_ACCESS_KEY ?? "app";
const secretKey = process.env.S3_SECRET_KEY ?? "app-secret";
const bucket = process.env.S3_BUCKET ?? "app-artifacts";
const region = process.env.S3_REGION ?? "us-east-1";

let client: S3Client | null = null;
function getClient(): S3Client {
  if (!client) {
    client = new S3Client({
      region,
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
    });
  }
  return client;
}

async function ensureBucket(): Promise<void> {
  const c = getClient();
  try {
    await c.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    try {
      await c.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch {}
  }
}

export async function uploadJson(key: string, json: unknown): Promise<{ s3Key: string; url: string }> {
  const c = getClient();
  await ensureBucket();
  const body = Buffer.from(JSON.stringify(json, null, 2));
  await c.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/json" }));
  const url = await getPresignedUrl(key, 3600).catch(() => `${endpoint.replace(/\/$/, "")}/${bucket}/${key}`);
  return { s3Key: `${bucket}/${key}`, url };
}

export async function getPresignedUrl(key: string, expiresIn = 3600): Promise<string> {
  // Manual SigV4 presign — avoids @aws-sdk/s3-presigner (404 on pnpm) but is wire-compatible.
  // For MinIO the direct URL also works; this adds X-Amz-* query for real S3.
  const { createHmac, createHash } = await import("node:crypto");
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);
  const credential = `${accessKey}/${dateStamp}/${region}/s3/aws4_request`;
  const host = new URL(endpoint).host;
  const canonicalUri = `/${bucket}/${key}`;
  const query = [
    `X-Amz-Algorithm=AWS4-HMAC-SHA256`,
    `X-Amz-Credential=${encodeURIComponent(credential)}`,
    `X-Amz-Date=${amzDate}`,
    `X-Amz-Expires=${expiresIn}`,
    `X-Amz-SignedHeaders=host`,
  ].join("&");
  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = "host";
  const payloadHash = "UNSIGNED-PAYLOAD";
  const canonicalRequest = `GET\n${canonicalUri}\n${query}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${dateStamp}/${region}/s3/aws4_request\n${createHash("sha256").update(canonicalRequest).digest("hex")}`;
  const kDate = createHmac("sha256", `AWS4${secretKey}`).update(dateStamp).digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update("s3").digest();
  const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  return `${endpoint.replace(/\/$/, "")}${canonicalUri}?${query}&X-Amz-Signature=${signature}`;
}

export function getBucket(): string {
  return bucket;
}

import { Queue, Worker, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { logger } from "@app/observability";
import { postSessionSummary, retentionSweep } from "./jobs.js";

const log = logger({ svc: "worker" });

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

function createConnection(): Redis {
  const conn = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
  });
  conn.on("error", (err: Error) => log.warn("redis error", { error: String(err) }));
  return conn;
}

async function main(): Promise<void> {
  const connection = createConnection();
  try {
    await connection.ping();
    log.info("redis connected", { redisUrl: redisUrl.replace(/:[^@]+@/, ":***@") });
  } catch (e) {
    log.warn("redis unavailable â€” worker will run retention sweep on interval without queue", { error: String(e) });
    // Fallback: interval sweep without BullMQ when Redis is down (dev convenience).
    setInterval(() => void retentionSweep().catch((err: unknown) => log.warn("sweep failed", { error: String(err) })), 60_000);
    await retentionSweep().catch((err: unknown) => log.warn("initial sweep failed", { error: String(err) }));
    return;
  }

  const queue = new Queue("app-jobs", { connection });
  const events = new QueueEvents("app-jobs", { connection });
  events.on("failed", ({ jobId, failedReason }: { jobId: string; failedReason: string }) => log.warn("job failed", { jobId, failedReason }));

  // Schedule recurring retention sweep
  await queue.add(
    "retention-sweep",
    {},
    { repeat: { every: 60_000 }, jobId: "retention-sweep", removeOnComplete: true, removeOnFail: true },
  );
  log.info("scheduled retention sweep every 60s");

  const worker = new Worker(
    "app-jobs",
    async (job: { name: string; data: { sessionId?: string } }) => {
      if (job.name === "retention-sweep") return retentionSweep();
      if (job.name === "post-session-summary" && job.data.sessionId) return postSessionSummary(job.data.sessionId);
      log.warn("unknown job", { name: job.name });
      return null;
    },
    { connection, concurrency: 2 },
  );

  worker.on("completed", (job: any) => log.info("job completed", { jobId: job.id, name: job.name }));
  worker.on("failed", (job: any, err: Error) => log.warn("job failed", { jobId: job?.id, error: String(err) }));

  // Also run once at startup
  void retentionSweep().catch((err: unknown) => log.warn("initial sweep failed", { error: String(err) }));

  const shutdown = async (sig: string) => {
    log.info(`received ${sig}, shutting down worker`);
    await worker.close();
    await queue.close();
    await events.close();
    await connection.quit();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();



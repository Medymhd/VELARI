import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { pathToFileURL } from "node:url";
import { env } from "./env.js";
import { prisma } from "./db.js";
import { registerAuth } from "./auth.js";
import { authRoutes } from "./routes/auth.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { providerRoutes } from "./routes/providers.js";
import { sessionRoutes } from "./routes/sessions.js";
import { browserRoutes } from "./routes/browser.js";
import { sttRelayRoutes } from "./routes/sttRelay.js";
import { visionRoutes } from "./routes/vision.js";
import { recallRoutes } from "./routes/recall.js";
import { registerRealtime } from "./realtime/ws.js";
import { logger } from "@app/observability";
import { VerticalManifest } from "@app/contracts";
import { validateRegistration } from "@app/agent-sdk";
import { vertical as interviewVertical } from "@app/vertical-interview-intelligence";
import { vertical as codingVertical } from "@app/vertical-coding-assistant";

const log = logger({ svc: "api" });

async function buildApp() {
  const app = Fastify({
    logger: false,
    trustProxy: true,
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(websocket, { options: { maxPayload: 1 << 20 } });

  app.setErrorHandler((err: unknown, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    const message = (err as Error).message ?? String(err) ?? "internal error";
    if (status >= 500) log.error("request failed", { status, message });
    void reply.status(status).send({ error: message });
  });

  app.get("/health", async () => ({ ok: true, version: "0.1.0" }));
  app.get("/v1/health", async () => ({ ok: true }));

  authRoutes(app, prisma);

  registerAuth(app);

  workspaceRoutes(app, prisma);
  providerRoutes(app, prisma);
  sessionRoutes(app, prisma);
  browserRoutes(app, prisma);
  sttRelayRoutes(app);
  visionRoutes(app, prisma);
  recallRoutes(app, prisma);

  // Vertical registry — validates each manifest and mounts under /v1/verticals/:id
  const verticals = [interviewVertical, codingVertical];
  for (const v of verticals) {
    const parsed = VerticalManifest.safeParse(v.manifest);
    if (!parsed.success) throw new Error(`${v.manifest.id} manifest invalid: ${parsed.error.message}`);
    const problems = validateRegistration(v);
    if (problems.length > 0) throw new Error(`${v.manifest.id} registration problems: ${problems.join("; ")}`);
    await app.register(
      async (scope) => {
        v.registerRoutes?.({
          get(path: string, handler: never) {
            scope.get(path, handler);
          },
          post(path: string, handler: never) {
            scope.post(path, handler);
          },
          patch(path: string, handler: never) {
            scope.patch(path, handler);
          },
          delete(path: string, handler: never) {
            scope.delete(path, handler);
          },
        });
      },
      { prefix: `/v1/verticals/${v.manifest.id}` },
    );
    log.info("vertical mounted", { id: v.manifest.id, version: v.manifest.version });
  }

  registerRealtime(app, prisma);

  app.addHook("onResponse", async (req, reply) => {
    if (req.url.startsWith("/v1/realtime")) return;
    log.info("request", { method: req.method, url: req.url, status: reply.statusCode });
  });

  return app;
}

async function main(): Promise<void> {
  try {
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;
    log.info("database connected");
  } catch (e) {
    log.error("database connection failed — run `pnpm infra:up` and `pnpm db:migrate`", {
      error: String(e),
      databaseUrl: env.databaseUrl.replace(/:[^@]+@/, ":***@"),
    });
  }

  const app = await buildApp();
  const port = env.port;
  const host = "0.0.0.0";
  await app.listen({ port, host });
  log.info(`App API listening on http://${host}:${port}`, { port });

  const shutdown = async (signal: string) => {
    log.info(`received ${signal}, shutting down`);
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// pathToFileURL handles spaces/encoding (OneDrive paths) — a raw string
// compare never matches there and main() silently never runs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}

export { buildApp };

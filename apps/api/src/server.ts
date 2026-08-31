import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { pathToFileURL } from "node:url";
import { env } from "./env.js";
import { prisma } from "./db.js";
import { registerAuth } from "./auth.js";
import { secretBox } from "./secrets.js";
import { authRoutes } from "./routes/auth.js";
import { workspaceRoutes } from "./routes/workspaces.js";
import { providerRoutes } from "./routes/providers.js";
import { sessionRoutes } from "./routes/sessions.js";
import { browserRoutes } from "./routes/browser.js";
import { sttRelayRoutes } from "./routes/sttRelay.js";
import { visionRoutes } from "./routes/vision.js";
import { recallRoutes } from "./routes/recall.js";
import { profileRoutes } from "./routes/profile.js";
import { registerRealtime } from "./realtime/ws.js";
import { logger } from "@app/observability";
import { VerticalManifest } from "@app/contracts";
import { validateRegistration, type VerticalRegistration } from "@app/agent-sdk";
import { CircuitBreakerRegistry } from "@app/ai-runtime";
import { executeRouted, loadWorkspaceAiConfig } from "./ai/runtime.js";
import type { ChatMessage } from "@app/contracts";

async function discoverVerticals(): Promise<VerticalRegistration[]> {
  const candidates: string[] = [];
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { dependencies?: Record<string, string> };
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      if (name.startsWith("@app/vertical-")) candidates.push(name);
    }
  } catch {}
  if (candidates.length === 0) {
    try {
      const { readdir } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const root = join(process.cwd(), "../../verticals");
      const entries = await readdir(root, { withFileTypes: true });
      for (const e of entries) if (e.isDirectory()) candidates.push(`@app/vertical-${e.name}`);
    } catch {}
  }
  const verticals: VerticalRegistration[] = [];
  for (const pkgName of candidates) {
    try {
      const mod = (await import(pkgName)) as { vertical?: VerticalRegistration };
      if (mod.vertical) verticals.push(mod.vertical);
      else log.warn("vertical package has no `vertical` export", { pkgName });
    } catch (e) {
      log.warn("failed to load vertical", { pkgName, error: String(e) });
    }
  }
  verticals.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  return verticals;
}

const log = logger({ svc: "api" });
const breakers = new CircuitBreakerRegistry();

async function buildApp() {
  const app = Fastify({
    logger: false,
    trustProxy: true,
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(websocket, { options: { maxPayload: 1 << 20 } });

  // Bodyless POSTs (start/pause/complete, approvals) send content-type json with
  // no payload; default parser rejects that with 400. Treat empty as {}.
  app.addContentTypeParser<string>("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (body === "" || body === undefined) return done(null, {});
    try {
      done(null, JSON.parse(body));
    } catch (e) {
      done(e as Error, undefined);
    }
  });

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
profileRoutes(app, prisma);

  // Vertical registry — dynamic, no hard-coded ids. Adding a new vertical alongside the 2-3 built only requires a new `verticals/<id>` package.
  const verticals = await discoverVerticals();
  if (verticals.length === 0) log.warn("no verticals discovered — check verticals/* packages and apps/api dependencies");
  for (const v of verticals) {
    const parsed = VerticalManifest.safeParse(v.manifest);
    if (!parsed.success) throw new Error(`${v.manifest.id} manifest invalid: ${parsed.error.message}`);
    const problems = validateRegistration(v);
    if (problems.length > 0) throw new Error(`${v.manifest.id} registration problems: ${problems.join("; ")}`);
    await app.register(
      async (scope) => {
        v.registerRoutes?.(
          {
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
          },
          {
            db: prisma,
            openSecret: (credentialRef: string) => {
              // credentialRef = "<kind>:<secret_ref or inline secret>". Sealed
              // v1.* payloads resolve through the vault; inline plaintext (dev)
              // passes through. The result is never logged.
              const idx = credentialRef.indexOf(":");
              const payload = idx === -1 ? credentialRef : credentialRef.slice(idx + 1);
              if (payload.startsWith("v1.")) {
                try {
                  return secretBox.open(payload);
                } catch {
                  return null;
                }
              }
              return payload || null;
            },
            ai: {
              ask: async (input) => {
                const cfg = await loadWorkspaceAiConfig(prisma, input.workspaceId);
                const outcome = await executeRouted({ db: prisma, breakers }, cfg, input.workspaceId, null, {
                  taskClass: input.taskClass as never,
                  privacyMode: cfg.privacyMode,
                  messages: input.messages as ChatMessage[],
                  ...(input.responseSchema ? { responseSchema: input.responseSchema as Record<string, unknown> } : {}),
                } as never);
                if (!outcome.ok) {
                  const err = outcome.error as { message?: string; kind?: string } | undefined;
                  throw new Error(err?.message ?? err?.kind ?? "no eligible provider");
                }
                return {
                  text: outcome.text ?? "",
                  ...(outcome.structured ? { structured: outcome.structured } : {}),
                  providerId: (outcome as { providerId?: string }).providerId,
                };
              },
            },
          },
        );
      },
      { prefix: `/v1/verticals/${v.manifest.id}` },
    );
    log.info("vertical mounted", { id: v.manifest.id, version: v.manifest.version });
  }

  app.get("/v1/verticals", async () => ({
    verticals: verticals.map((v) => v.manifest),
  }));

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

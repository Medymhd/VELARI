import { logger } from "@app/observability";

const log = logger({ svc: "api" });

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    log.error(`missing required env ${name}`, { env: name });
    throw new Error(`missing required env: ${name}`);
  }
  return v;
}

export const env = {
  port: Number(process.env.PORT ?? 8787),
  nodeEnv: process.env.NODE_ENV ?? "development",
  databaseUrl: requireEnv("DATABASE_URL", "postgresql://App:App@localhost:5432/App"),
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  jwtSecret: requireEnv("JWT_SECRET", "App-dev-secret-do-not-use-in-prod"),
  secretMasterKey: requireEnv(
    "SECRET_MASTER_KEY",
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  ),
  /** Public origin clients dial for websocket endpoints (wss behind TLS in prod). */
  publicUrl: process.env.PUBLIC_URL ?? "http://localhost:8787",
  /** HMAC secret for short-lived STT relay session tokens. */
  relayHmacSecret: requireEnv("RELAY_HMAC_SECRET", "App-dev-relay-secret-do-not-use-in-prod"),
} as const;



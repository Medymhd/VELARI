import { PrismaClient } from "@prisma/client";

/** JSON serializer that tolerates BigInt columns (usage counters). */
export function toJson(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? Number(v) : v)),
  );
}

export const prisma = new PrismaClient({
  log: process.env.app_LOG_LEVEL === "debug" ? ["query", "warn", "error"] : ["warn", "error"],
});


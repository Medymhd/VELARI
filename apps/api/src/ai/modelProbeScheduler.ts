/**
 * Model-probe scheduler (the anti-hardcoding system on a clock): runs
 * benchmarks/probe-models.mjs on a configurable schedule so COACH_MODEL_*
 * winners in .env track provider lineups automatically — a deprecated,
 * removed or rate-limited model is replaced without anyone touching a
 * hardcoded name.
 *
 * Schedule lives in the workspace policy (benchSchedule): "at_launch"
 * (default) | "hourly" | "4h" | "daily" | "off". Resolution across
 * workspaces: any at_launch → boot run; the shortest configured interval
 * wins; all off → the scheduler idles.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { logger } from "@app/observability";

const log = logger({ svc: "model-probe" });

const SCHEDULES = ["at_launch", "hourly", "4h", "daily", "off"] as const;
type Schedule = (typeof SCHEDULES)[number];

const INTERVAL_MS: Record<Exclude<Schedule, "at_launch" | "off">, number> = {
  hourly: 3_600_000,
  "4h": 14_400_000,
  daily: 86_400_000,
};

const MIN_GAP_MS = 10 * 60_000; // never probe more often than every 10 min

function repoRoot(): string {
  // cwd = apps/api when running the API
  return path.resolve(process.cwd(), "..", "..");
}

function statePath(): string {
  return path.join(repoRoot(), ".data", "model-probe.json");
}

function readLastRunAt(): number {
  try {
    const j = JSON.parse(readFileSync(statePath(), "utf8")) as { lastRunAt?: number };
    return j.lastRunAt ?? 0;
  } catch {
    return 0;
  }
}

function writeLastRunAt(at: number): void {
  try {
    const dir = path.dirname(statePath());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(statePath(), JSON.stringify({ lastRunAt: at }, null, 2), "utf8");
  } catch {
    /* state write is best-effort */
  }
}

async function resolveSchedule(db: PrismaClient): Promise<{ boot: boolean; intervalMs: number | null }> {
  const workspaces = await db.workspace.findMany({ select: { policyJson: true } });
  let boot = false;
  let shortest: number | null = null;
  for (const w of workspaces) {
    const s = (w.policyJson as { benchSchedule?: string } | null)?.benchSchedule;
    if (!SCHEDULES.includes(s as Schedule)) continue;
    if (s === "at_launch") boot = true;
    else if (s !== "off") {
      const ms = INTERVAL_MS[s as Exclude<Schedule, "at_launch" | "off">];
      if (shortest === null || ms < shortest) shortest = ms;
    }
  }
  return { boot, intervalMs: shortest };
}

function runProbe(reason: string): void {
  const now = Date.now();
  if (now - readLastRunAt() < MIN_GAP_MS) {
    log.info("probe skipped: ran recently", { reason });
    return;
  }
  writeLastRunAt(now);
  const script = path.join(repoRoot(), "benchmarks", "probe-models.mjs");
  const logFile = path.join(repoRoot(), ".data", "model-probe.log");
  try {
    mkdirSync(path.dirname(logFile), { recursive: true });
    const out = openSync(logFile, "a");
    const child = spawn(process.execPath, [script], { cwd: repoRoot(), detached: true, stdio: ["ignore", out, out] });
    child.unref();
    log.info("model probe started", { reason, pid: child.pid, log: logFile });
  } catch (e) {
    log.warn("model probe spawn failed", { error: String(e) });
  }
}

/** Boot the scheduler: checks the policy every 5 minutes; also honors
 *  at_launch with a 15s delay so the API finishes mounting first. */
export function startModelProbeScheduler(db: PrismaClient): void {
  let bootRunDone = false;
  const tick = async (reason: string) => {
    try {
      const { boot, intervalMs } = await resolveSchedule(db);
      if (!boot && intervalMs === null) return; // off / nothing configured
      if (boot && !bootRunDone) {
        bootRunDone = true;
        runProbe("at_launch");
        return;
      }
      if (intervalMs !== null && Date.now() - readLastRunAt() >= intervalMs) {
        runProbe(`interval:${intervalMs}`);
      }
    } catch (e) {
      log.warn("probe scheduler tick failed", { error: String(e) });
    }
  };

  setTimeout(() => void tick("boot-check"), 15_000);
  setInterval(() => void tick("interval-check"), 5 * 60_000);
}

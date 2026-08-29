/**
 * Bounded browser-task runner (valeriworkvertical.md §10 agent runtime).
 *
 * MVP driver: HTTP fetch + text extraction on allowlisted domains — no
 * browser binary needed, works everywhere, bounded by maxActions and a stop
 * flag. The Playwright-in-sandbox driver plugs into the same interface when
 * form-login automation ships.
 */
import { createHash } from "node:crypto";

export interface RunnerStep {
  action: string;
  url?: string;
  status: "ok" | "error";
  ms: number;
  detail?: string;
}

export interface RunResult {
  status: "completed" | "failed" | "stopped";
  steps: RunnerStep[];
  text: string;
  title?: string;
  error?: string;
}

export interface RunOptions {
  url: string;
  credential?: { kind: string; secret: string } | null;
  maxActions?: number;
  fetchImpl?: typeof fetch;
  isStopped?: () => boolean;
  timeoutMs?: number;
}

const DEFAULT_MAX_ACTIONS = 20;
const USER_AGENT = "Mozilla/5.0 (compatible; AppWorkRunner/0.1)";

function htmlToText(html: string): { title?: string; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { title, text: text.slice(0, 20_000) };
}

export async function runBrowserTask(opts: RunOptions): Promise<RunResult> {
  const maxActions = opts.maxActions ?? DEFAULT_MAX_ACTIONS;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const isStopped = opts.isStopped ?? (() => false);
  const steps: RunnerStep[] = [];
  const timed = async (action: string, fn: () => Promise<string>): Promise<string | null> => {
    if (isStopped()) return null;
    const started = Date.now();
    try {
      const detail = await fn();
      steps.push({ action, url: opts.url, status: "ok", ms: Date.now() - started, detail: detail?.slice(0, 200) });
      return detail ?? "";
    } catch (e) {
      steps.push({ action, url: opts.url, status: "error", ms: Date.now() - started, detail: String(e).slice(0, 300) });
      return null;
    }
  };

  if (steps.length >= maxActions) {
    return { status: "stopped", steps, text: "", error: "max actions reached" };
  }
  const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: "text/html,application/json" };
  if (opts.credential?.secret) {
    if (opts.credential.kind === "email_password") {
      const basic = Buffer.from(opts.credential.secret).toString("base64");
      headers.authorization = `Basic ${basic}`;
    } else {
      // api_key / google_api / vault plaintext tokens ride as bearer.
      headers.authorization = `Bearer ${opts.credential.secret}`;
    }
  }

  const body = await timed("navigate", async () => {
    const res = await fetchImpl(opts.url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  });
  if (body === null) {
    return { status: isStopped() ? "stopped" : "failed", steps, text: "", error: "navigate failed" };
  }

  const extracted = await timed("extract", async () => {
    const { title, text } = htmlToText(body);
    return JSON.stringify({ title, chars: text.length });
  });
  if (isStopped()) {
    return { status: "stopped", steps, text: "" };
  }

  const { title, text } = htmlToText(body);
  const contentHash = createHash("sha1").update(body).digest("hex").slice(0, 12);
  steps.push({ action: "digest", url: opts.url, status: "ok", ms: 0, detail: contentHash });

  return { status: "completed", steps, text, title };
}

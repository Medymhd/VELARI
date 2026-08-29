/**
 * Playwright-in-sandbox browser driver (valeriworkvertical.md §10) — REAL
 * Chromium automation on allowlisted domains: navigate, fill credentials
 * (vault-injected, never in prompts/logs), extract content.
 *
 * Uses `playwright-core` — the browser binary must exist (env
 * PLAYWRIGHT_BROWSERS_PATH or a system Chrome via channel). Degrades
 * gracefully: the engine reports "playwright unavailable" and the chain
 * falls back to the HTTP driver in agentRunner.ts.
 */
import { createHash } from "node:crypto";

export interface PlaywrightStep {
  action: "navigate" | "fill" | "click" | "extract" | "screenshot";
  url?: string;
  selector?: string;
  value?: string;
  detail?: string;
}

export interface PlaywrightRunResult {
  ok: boolean;
  title?: string;
  text: string;
  steps: PlaywrightStep[];
  error?: string;
}

export interface PlaywrightCredential {
  kind: "google_api" | "api_key" | "email_password";
  secret: string;
  loginUrl?: string;
  userSelector?: string;
  passSelector?: string;
  submitSelector?: string;
}

interface PlaywrightBrowser {
  newContext(opts?: Record<string, unknown>): Promise<PlaywrightContext>;
  close(): Promise<void>;
}
interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}
interface PlaywrightPage {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  title(): Promise<string>;
  content(): Promise<string>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  screenshot(opts?: Record<string, unknown>): Promise<Buffer>;
  waitForLoadState(state?: string): Promise<void>;
  close(): Promise<void>;
}

export interface PlaywrightDriverOptions {
  url: string;
  credential?: PlaywrightCredential | null;
  maxActions?: number;
  timeoutMs?: number;
  /** Chromium executable path; defaults to env PLAYWRIGHT_BROWSERS_PATH or system Chrome. */
  executablePath?: string;
  headless?: boolean;
}

type BrowserFactory = (opts: { executablePath?: string; headless: boolean }) => Promise<PlaywrightBrowser>;

/** Lazy playwright-core load — degrades cleanly when the binary is absent. */
export function defaultBrowserFactory(opts: { executablePath?: string; headless: boolean }): Promise<PlaywrightBrowser> {
  return (async () => {
    const { createRequire } = await import("node:module");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req = (globalThis as any).__app_createRequire ?? (await import("node:module")).createRequire;
    void req;
    const mod = await import("playwright-core");
    const chromium = (mod as any).chromium;
    const launchOpts: Record<string, unknown> = { headless: opts.headless };
    if (opts.executablePath) launchOpts.executablePath = opts.executablePath;
    else {
      // Fall back to system Chrome/Edge — no browser download required.
      launchOpts.channel = process.env.PLAYWRIGHT_CHANNEL ?? "chrome";
    }
    return chromium.launch(launchOpts);
  })();
}

export async function runPlaywrightTask(opts: PlaywrightDriverOptions): Promise<PlaywrightRunResult> {
  const steps: PlaywrightStep[] = [];
  const maxActions = opts.maxActions ?? 20;
  const timeout = opts.timeoutMs ?? 30_000;
  let browser: PlaywrightBrowser | null = null;

  const factory = (globalThis as any).__app_playwright_factory as BrowserFactory | undefined;
  browser = await (factory ?? defaultBrowserFactory)({
    executablePath: opts.executablePath,
    headless: opts.headless ?? true,
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    // ── Navigate ──
    await page.goto(opts.url, { timeout, waitUntil: "domcontentloaded" });
    steps.push({ action: "navigate", url: opts.url, detail: "domcontentloaded" });

    // ── Vault credential login (email/password form fill) ──
    if (opts.credential?.kind === "email_password" && opts.credential.loginUrl) {
      await page.goto(opts.credential.loginUrl, { timeout, waitUntil: "domcontentloaded" });
      steps.push({ action: "navigate", url: opts.credential.loginUrl, detail: "login page" });

      const cred = decodeBasicAuth(opts.credential.secret);
      if (cred && opts.credential.userSelector && opts.credential.passSelector) {
        await page.fill(opts.credential.userSelector, cred.user);
        await page.fill(opts.credential.passSelector, cred.pass);
        steps.push({ action: "fill", detail: "credentials filled (vault-injected, never in DOM text)" });
        if (opts.credential.submitSelector) {
          await page.click(opts.credential.submitSelector);
          steps.push({ action: "click", selector: opts.credential.submitSelector, detail: "submit" });
        }
        await page.waitForLoadState("domcontentloaded");
      }
    }

    // ── Extract ──
    const title = await page.title();
    const html = await page.content();
    const text = stripHtml(html);
    const hash = createHash("sha1").update(html).digest("hex").slice(0, 12);
    steps.push({ action: "extract", detail: `title="${title}" chars=${text.length} hash=${hash}` });

    // ── Optional screenshot (policy-gated upstream) ──
    let screenshot: Buffer | undefined;
    if ((globalThis as any).__app_capture_screenshot) {
      try {
        screenshot = await page.screenshot({ type: "png", fullPage: false });
        steps.push({ action: "screenshot", detail: `${screenshot.length} bytes` });
      } catch {
        // screenshot is best-effort
      }
    }

    return { ok: true, title, text: text.slice(0, 20_000), steps };
  } catch (e) {
    return { ok: false, text: "", steps, error: String(e).slice(0, 300) };
  } finally {
    try {
      await browser?.close();
    } catch {
      // ignore close races
    }
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20_000);
}

function decodeBasicAuth(secret: string): { user: string; pass: string } | null {
  try {
    const decoded = Buffer.from(secret, "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx === -1) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

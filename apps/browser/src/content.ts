declare const chrome: any;
// Port of reference `reference-browser/src/capture/*` + `sensitive-page-detector.ts` + `registry.default.json` — stealth on all browsers/apps.
// Isolated world: page cannot see chrome.runtime; guard name randomized per injection to avoid `__reference_capture_listener__` fingerprint (handoff-brief:22).

// Randomized guard token per page load — avoids static `__reference_capture_listener__` detection.
const GUARD_KEY = `__app_guard_${Math.random().toString(36).slice(2)}__`;
(window as any)[GUARD_KEY] = true;

// Sensitive proctored domains — auto-pause capture, offscreen fallback via desktop overlay instead (reference sensitive-page-detector parity).
const SENSITIVE_HOSTS = ["hirevue.com", "codesignal.com", "coderbyte.com", "interviewing.io", "karat.com"];
function isSensitive(): boolean {
  const host = location.hostname.toLowerCase();
  return SENSITIVE_HOSTS.some((d) => host.includes(d));
}

// Registry expanded for all browsers/apps: coding judges + video apps (Zoom/Meet/Teams) + ATS
const REGISTRY: Record<string, { site: string; selector: string }> = {
  "leetcode.com": { site: "leetcode", selector: ".question-content, [data-track-load='description_content']" },
  "hackerrank.com": { site: "hackerrank", selector: ".challenge-body" },
  "coderpad.io": { site: "coderpad", selector: ".prompt" },
  "zoom.us": { site: "zoom", selector: "[aria-label*='Chat'], .caption, [data-testid='transcript']" },
  "meet.google.com": { site: "meet", selector: "[aria-label*='Captions'], [data-message-text], .a4Vh9" },
  "teams.live.com": { site: "teams", selector: "[data-tid='closed-caption'], .ts-captions" },
  "teams.microsoft.com": { site: "teams", selector: "[data-tid='closed-caption'], .ts-captions" },
  "hirevue.com": { site: "hirevue", selector: "[data-testid='question'], .question-text" },
  "codesignal.com": { site: "codesignal", selector: "[data-test*='question'], .task-description" },
};

function extract(): { site: string | null; text: string; sensitive: boolean } {
  if (isSensitive()) return { site: "sensitive", text: "", sensitive: true };
  const host = location.hostname.toLowerCase();
  for (const [domain, cfg] of Object.entries(REGISTRY)) {
    if (host.includes(domain)) {
      const el = document.querySelector(cfg.selector);
      if (el) return { site: cfg.site, text: (el as HTMLElement).innerText.slice(0, 8000), sensitive: false };
    }
  }
  // Generic fallback: visible text, no DOM artifacts
  const text = document.body ? (document.body.innerText || "").slice(0, 8000) : "";
  return { site: null, text, sensitive: false };
}

function handleCapture(sendResponse: (v: unknown) => void): void {
  // No DOM mutation, no global listener leak — stealth: reply and return
  const result = extract();
  if (result.sensitive) {
    sendResponse({ site: result.site, text: "", sensitive: true, reason: "sensitive-page-paused" });
  } else {
    sendResponse({ site: result.site, text: result.text, sensitive: false });
  }
}

if (!(window as any)[`__app_listener_${GUARD_KEY}`]) {
  (window as any)[`__app_listener_${GUARD_KEY}`] = true;
  chrome.runtime.onMessage.addListener((msg: any, _sender: unknown, sendResponse: (v: unknown) => void) => {
    if (msg?.type === "APP_CAPTURE") {
      handleCapture(sendResponse);
      return true;
    }
    if (msg?.type === "APP_PING") {
      sendResponse({ ok: true, stealth: "isolated", guard: GUARD_KEY });
      return true;
    }
    return false;
  });
}


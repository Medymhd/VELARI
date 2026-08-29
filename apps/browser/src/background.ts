declare const chrome: any;
// Background service worker — extension-click capture with sensitive-page pause
// and isolated-world script fallback (Firefox `browser` namespace compatible).

const API_FALLBACK = "http://localhost:8787/v1";

async function forwardCapture(tab: { url?: string }, res: { site: string | null; text: string; sensitive?: boolean }): Promise<void> {
  if (res.sensitive) return; // proctored page: capture paused by policy
  const api = (await chrome.storage.local.get("apiUrl")).apiUrl ?? API_FALLBACK;
  await fetch(`${api}/browser/capture`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: tab.url, site: res.site, text: res.text, capturedAt: new Date().toISOString() }),
  }).catch(() => {});
}

chrome.action.onClicked.addListener(async (tab: any) => {
  if (!tab?.id) return;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: "APP_CAPTURE" });
    await forwardCapture(tab, res);
  } catch {
    // Content script not injected yet (document_start on fresh tabs) —
    // inject the capture into the ISOLATED world directly.
    try {
      const [frame] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => (document.body?.innerText || "").slice(0, 8000),
        world: "ISOLATED" as any,
      });
      await forwardCapture(tab, { site: "injected", text: frame?.result ?? "" });
    } catch {}
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ apiUrl: API_FALLBACK });
});

chrome.runtime.onMessage.addListener((msg: any, _sender: unknown, sendResponse: (v: unknown) => void) => {
  if (msg?.type === "APP_HEALTH") {
    sendResponse({ ok: true, isolated: true });
    return true;
  }
  return false;
});

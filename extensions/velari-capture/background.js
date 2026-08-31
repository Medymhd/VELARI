/**
 * Velari browser companion (rival Ctrl+Y page-capture parity, MVP):
 * grabs the active tab's selection (or page text) and posts it to the
 * platform, where it lands on the user's live session as web context.
 */

async function config() {
  const { apiUrl, token } = await chrome.storage.local.get(["apiUrl", "token"]);
  return {
    apiUrl: apiUrl || "http://localhost:8787/v1",
    token: token || "",
  };
}

async function capture() {
  const { apiUrl, token } = await config();
  if (!token) {
    chrome.notifications.create({ type: "basic", iconUrl: "icon128.png", title: "Velari Capture", message: "Paste your token in the extension popup first." });
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => (window.getSelection()?.toString() || document.body?.innerText || "").slice(0, 8000),
  });
  if (!result || result.trim().length < 10) {
    chrome.notifications.create({ type: "basic", iconUrl: "icon128.png", title: "Velari Capture", message: "Nothing to capture — select some text first." });
    return;
  }
  try {
    const res = await fetch(`${apiUrl}/context/capture`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ text: result, url: tab.url ?? "", title: tab.title ?? "" }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    chrome.notifications.create({ type: "basic", iconUrl: "icon128.png", title: "Velari Capture", message: "Captured into your live session." });
  } catch (e) {
    chrome.notifications.create({ type: "basic", iconUrl: "icon128.png", title: "Velari Capture", message: `Capture failed: ${e.message}` });
  }
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "capture-page") void capture();
});
chrome.action.onClicked.addListener(() => void capture());

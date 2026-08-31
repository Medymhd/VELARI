const $ = (id) => document.getElementById(id);

chrome.storage.local.get(["apiUrl", "token"]).then(({ apiUrl, token }) => {
  $("apiUrl").value = apiUrl || "http://localhost:8787/v1";
  $("token").value = token || "";
});

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({ apiUrl: $("apiUrl").value.trim(), token: $("token").value.trim() });
  $("status").textContent = "Saved.";
  setTimeout(() => ($("status").textContent = ""), 1500);
});

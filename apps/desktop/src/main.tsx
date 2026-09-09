import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { startOverlayForwarding } from "./lib/overlayForward";
import { initTheme } from "./lib/theme";
import "@app/ui/styles.css";

// Pre-render: set the persisted palette before first paint — no theme flash.
initTheme();
startOverlayForwarding();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

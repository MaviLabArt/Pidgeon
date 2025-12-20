import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";
import { NostrProvider } from "./providers/NostrProvider.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <NostrProvider>
      <App />
    </NostrProvider>
  </React.StrictMode>
);

function shouldEnableConsoleDebug() {
  if (import.meta.env.DEV) return true;
  try {
    const params = new URLSearchParams(window.location.search || "");
    if (params.get("debugMailbox") === "1" || params.get("debug") === "1") return true;
    return localStorage.getItem("pidgeon.debug") === "1";
  } catch {
    return false;
  }
}

if (shouldEnableConsoleDebug()) {
  import("./debug/consoleDebug.js").catch(() => {});
}

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });

      const maybeRefresh = () => {
        if (document.visibilityState !== "visible") return;
        try {
          registration.update();
        } catch {}
      };

      document.addEventListener("visibilitychange", maybeRefresh);
      window.addEventListener("focus", maybeRefresh);
    } catch {
      // ignore
    }
  });
}

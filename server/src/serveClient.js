import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = process.env.CLIENT_DIST || path.resolve(__dirname, "../../client/dist");
const clientIndex = path.join(clientDist, "index.html");
let warnedMissingClient = false;

function hasBuiltClient() {
  try {
    fs.accessSync(clientIndex, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export function mountClient(app) {
  if (!hasBuiltClient()) {
    if (!warnedMissingClient) {
      warnedMissingClient = true;
      console.warn(
        `[client] Built UI not found at ${clientIndex}. ` +
          `Set CLIENT_DIST to your Vite dist folder (must contain index.html).`
      );
    }
    // Avoid noisy sendFile stack traces when the UI bundle isn't present.
    app.get(/^\/(?!api(?:\/|$)).*/, (req, res) => {
      const wantsHtml = (() => {
        try {
          return Boolean(req.accepts?.("html"));
        } catch {
          return false;
        }
      })();
      if (wantsHtml) {
        res
          .status(404)
          .send(
            `<h1>Client not built</h1>` +
              `<p>Run <code>npm install</code> and <code>npm run build</code> in <code>client/</code>, then set <code>CLIENT_DIST</code> to the output folder.</p>`
          );
        return;
      }
      res.status(404).json({ error: "Client not built" });
    });
    return;
  }

  // Serve static assets
  app.use(
    express.static(clientDist, {
      setHeaders(res, filePath) {
        const p = String(filePath || "");
        if (p.endsWith(`${path.sep}sw.js`) || p.endsWith(`${path.sep}manifest.webmanifest`)) {
          res.setHeader("Cache-Control", "no-cache");
          return;
        }
        if (p.endsWith(`${path.sep}index.html`)) {
          res.setHeader("Cache-Control", "no-cache");
        }
      }
    })
  );
  // SPA fallback to index.html
  // Express 5 + path-to-regexp v6 doesn't accept "*" as a path string.
  // Also avoid swallowing unknown /api routes: let them 404 instead of serving the SPA.
  app.get(/^\/(?!api(?:\/|$)).*/, (req, res) => {
    res.sendFile(clientIndex, (err) => {
      if (!err) return;
      if (!warnedMissingClient) {
        warnedMissingClient = true;
        console.warn(`[client] Failed to serve ${clientIndex}: ${err?.message || err}`);
      }
      if (!res.headersSent) res.status(err?.statusCode || 404).end();
    });
  });
}

import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = process.env.CLIENT_DIST || path.resolve(__dirname, "../../client/dist");

export function mountClient(app) {
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
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

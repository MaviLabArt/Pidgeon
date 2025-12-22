import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = process.env.CLIENT_DIST || path.resolve(__dirname, "../../client/dist");
const clientIndex = path.join(clientDist, "index.html");
let warnedMissingClient = false;
let clientSendFileErrorCount = 0;

function hasBuiltClient() {
  try {
    fs.accessSync(clientIndex, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function safeStat(filePath) {
  try {
    const st = fs.statSync(filePath);
    return {
      ok: true,
      isFile: st.isFile(),
      isDir: st.isDirectory(),
      size: Number(st.size) || 0,
      mtimeMs: Number(st.mtimeMs) || 0,
    };
  } catch (err) {
    return { ok: false, error: err?.code || err?.message || String(err) };
  }
}

function safeListDir(dirPath, limit = 20) {
  try {
    return fs.readdirSync(dirPath).slice(0, Math.max(0, Number(limit) || 0));
  } catch {
    return null;
  }
}

function isSuspiciousPath(urlPath = "") {
  const p = String(urlPath || "").toLowerCase();
  if (!p || p === "/") return false;
  // Very common automated scans against non-WordPress sites.
  if (p === "/wp-admin" || p.startsWith("/wp-admin/")) return true;
  if (p === "/wordpress" || p.startsWith("/wordpress/")) return true;
  if (p.startsWith("/wp-content") || p.startsWith("/wp-includes")) return true;
  if (p.startsWith("/wp-login")) return true;
  if (p.startsWith("/xmlrpc")) return true;
  if (p.startsWith("/phpmyadmin") || p.startsWith("/pma")) return true;
  if (p.startsWith("/cgi-bin")) return true;
  // Sensitive dotpaths that should never be served by the SPA.
  if (p.startsWith("/.env") || p.startsWith("/.git")) return true;
  return false;
}

function looksLikeFileRequest(urlPath = "") {
  const p = String(urlPath || "");
  if (!p || p === "/") return false;
  // If the last segment contains a dot, treat it as a file request (e.g. *.php, *.sql, *.bak).
  // SPA routes shouldn't contain extensions, and this avoids serving index.html to obvious scans.
  const base = path.posix.basename(p);
  return base.includes(".");
}

function logSendFileFailure(req, err, { fallback } = {}) {
  clientSendFileErrorCount += 1;
  const summary = `[client] Failed to serve ${clientIndex}: ${err?.message || err}`;
  // Avoid spamming logs with huge debug blobs if something is seriously wrong.
  if (clientSendFileErrorCount > 5) {
    console.warn(summary, fallback ? { fallback } : undefined);
    return;
  }

  const assetsDir = path.join(clientDist, "assets");
  console.warn(summary, {
    count: clientSendFileErrorCount,
    at: new Date().toISOString(),
    request: {
      method: req?.method,
      url: req?.originalUrl || req?.url,
      accept: req?.headers?.accept,
      userAgent: req?.headers?.["user-agent"],
    },
    client: {
      envClientDist: process.env.CLIENT_DIST || "",
      clientDist,
      clientIndex,
      cwd: process.cwd(),
      pid: process.pid,
      node: process.version,
    },
    fs: {
      dist: safeStat(clientDist),
      index: safeStat(clientIndex),
      assets: safeStat(assetsDir),
      distEntries: safeListDir(clientDist),
      assetsEntries: safeListDir(assetsDir),
    },
    error: {
      message: err?.message,
      code: err?.code,
      status: err?.status,
      statusCode: err?.statusCode,
      path: err?.path,
      syscall: err?.syscall,
    },
    ...(fallback ? { fallback } : {}),
  });
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
    // Don't serve index.html for obvious scans or "file-like" paths.
    // This reduces noise and makes it clearer in logs when something is truly wrong with the client bundle.
    const reqPath = req?.path || req?.originalUrl || req?.url || "";
    if (isSuspiciousPath(reqPath) || looksLikeFileRequest(reqPath)) {
      res.status(404).end();
      return;
    }

    res.sendFile(clientIndex, (err) => {
      if (!err) return;
      let fallback = null;
      if (!res.headersSent) {
        try {
          const html = fs.readFileSync(clientIndex, "utf8");
          res.setHeader("Cache-Control", "no-cache");
          res.type("html").send(html);
          fallback = { served: true, bytes: html.length };
        } catch (readErr) {
          fallback = { served: false, error: readErr?.code || readErr?.message || String(readErr) };
        }
      }
      logSendFileFailure(req, err, { fallback });
      if (fallback?.served) return;
      if (!res.headersSent) res.status(err?.statusCode || 404).end();
    });
  });
}

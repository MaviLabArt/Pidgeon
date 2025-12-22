/**
 * PM2 ecosystem config for Debian production.
 *
 * Assumptions:
 * - You run `npm ci && npm run build` in `client/` before starting PM2 (so `client/dist` exists)
 * - Web server reads runtime env from `server/.env` via `dotenv/config` (because `cwd` is `server/`)
 * - DVM reads runtime env from `dvm/.env` via `dotenv/config` (because `cwd` is `dvm/`)
 */

const path = require("path");

const REPO_ROOT = __dirname;
const WEB_DIR = path.join(REPO_ROOT, "server");
const DVM_DIR = path.join(REPO_ROOT, "dvm");
const CLIENT_DIST = path.join(REPO_ROOT, "client", "dist");
const WEB_LOG_DIR = path.join(WEB_DIR, "logs");
const DVM_LOG_DIR = path.join(DVM_DIR, "logs");

module.exports = {
  apps: [
    {
      name: "pidgeon-web",
      cwd: WEB_DIR,
      script: "src/index.js",
      interpreter: "node",
      node_args: "--enable-source-maps",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      time: true,
      watch: false,
      env: {
        NODE_ENV: "production",

        // Optional overrides (defaults exist in code):
        // API_PORT: "3001",
        // DATA_DIR: "data",
        CLIENT_DIST: CLIENT_DIST,
        //
        // CORS (optional):
        // ENABLE_CORS: "1",
        // CORS_ORIGIN: "https://yourdomain.tld",
      },
      out_file: path.join(WEB_LOG_DIR, "pm2.out.log"),
      error_file: path.join(WEB_LOG_DIR, "pm2.err.log"),
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
    {
      name: "pidgeon-dvm",
      cwd: DVM_DIR,
      script: "src/index.js",
      interpreter: "node",
      node_args: "--enable-source-maps",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      time: true,
      watch: false,
      env: {
        NODE_ENV: "production",

        // Optional overrides (defaults exist in code):
        // DATA_DIR: "data",
      },
      out_file: path.join(DVM_LOG_DIR, "pm2.out.log"),
      error_file: path.join(DVM_LOG_DIR, "pm2.err.log"),
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
  ],
};

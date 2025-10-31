import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import extractRouter from "./routes/extract.js";

dotenv.config();

const app = express();

/**
 * --- UNIVERSAL CORS (debug-friendly) ---
 * - Reflects the caller Origin (frontend, extension, local)
 * - Handles OPTIONS preflight for every path
 * - Sends proper headers even if route doesn't exist
 */
app.use((req, res, next) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin"); // so proxies don't cache CORS wrongly
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  // Some browsers/devices:
  res.setHeader("Access-Control-Allow-Credentials", "false");

  if (req.method === "OPTIONS") {
    // Important: end preflight here with success
    return res.status(204).end();
  }
  next();
});

// JSON body
app.use(express.json({ limit: "2mb" }));

// Optional static landing (if /public exists)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

// Health
app.get("/api/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), time: new Date().toISOString() });
});

// API
app.use("/api", extractRouter);

// 404 (still with CORS headers because of the top middleware)
app.use((req, res) => res.status(404).json({ error: "Not found" }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`✅ API running on port ${PORT}`));

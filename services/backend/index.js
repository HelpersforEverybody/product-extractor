import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import extractRouter from "./routes/extract.js";

dotenv.config();
const app = express();

/**
 * --- VERY PERMISSIVE CORS (for debugging) ---
 * Once your flow works, we’ll restrict to your frontend/extension origins.
 */
app.use((req, res, next) => {
  // Always set CORS headers
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  // Short-circuit preflight
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// You can still keep cors() (it adds some sane defaults)
app.use(cors());

app.use(express.json({ limit: "2mb" }));

// (Optional) serve a static landing page if /public exists
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

// Health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// API routes
app.use("/api", extractRouter);

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ API running on port ${PORT}`);
});

import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import extractRouter from "./routes/extract.js";

dotenv.config();
const app = express();

// CORS (reflect origin) + preflight
app.use((req, res, next) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// tiny request log
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.use(express.json({ limit: "2mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.status(200).type("application/json").send(JSON.stringify({
    ok: true, uptime: process.uptime(), time: new Date().toISOString()
  }));
});

app.use("/api", extractRouter);

// 404 (JSON)
app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.originalUrl });
});

// final error handler — guarantees JSON, never empty
app.use((err, _req, res, _next) => {
  console.error("UNCAUGHT ERROR:", err?.message || err);
  res.status(err?.status || 500).json({
    error: "Server error",
    detail: { message: err?.message || "unknown" }
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`✅ API running on port ${PORT}`));

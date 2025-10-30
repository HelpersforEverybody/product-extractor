import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import extractRouter from "./routes/extract.js";

dotenv.config();

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "2mb" }));

// health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// extraction (mock for now)
app.use("/api", extractRouter);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`API running on http://localhost:${PORT}`);
});

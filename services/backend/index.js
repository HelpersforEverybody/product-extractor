import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import extractRouter from "./routes/extract.js";

dotenv.config();

const app = express();

// =====================
// CORS CONFIG
// =====================
const allowedOrigins = [
  "https://product-extractor-frontend.onrender.com", // frontend on Render
  "http://localhost:5173",                           // local dev
];

// CORS middleware
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // allow server-to-server & curl
    if (
      allowedOrigins.includes(origin) ||
      origin.startsWith("chrome-extension://") // allow chrome extension
    ) {
      return callback(null, true);
    }
    console.log("❌ CORS block:", origin);
    return callback(new Error("CORS blocked: " + origin));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// Allow OPTIONS preflight for all routes
app.options("*", cors());

// =====================
// BODY PARSER
// =====================
app.use(express.json({ limit: "2mb" }));

// =====================
// STATIC (if root page exists)
// =====================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));

// =====================
// ROUTES
// =====================

// Health check
app.get("/api/health", (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// Extract route
app.use("/api", extractRouter);

// =====================
// START SERVER
// =====================
const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ API running on port ${PORT}`);
});

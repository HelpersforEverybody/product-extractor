import { Router } from "express";
import { chooseExtractor } from "../extractor/index.js"; // NOTE: your folder is 'extractor'
import { chromium } from "playwright";

const router = Router();

/**
 * POST /api/extract
 * body: { url: string, siteId?: "auto"|"macys", debug?: 0|1 }
 * - Uses your registered extractor (Macy's, etc.)
 * - If debug=1, runs a Playwright session to capture trace/screenshot and passes the page to the extractor.
 * - Returns your 8 headers in the exact popup order.
 */
router.post("/extract", async (req, res) => {
  const startedAt = Date.now();
  const { url, siteId = "auto", debug = 0 } = req.body || {};

  if (!url) return res.status(400).json({ error: "Missing url" });

  let browser = null;
  let context = null;
  let page = null;
  let traceUrl = null;
  let screenshotUrl = null;

  try {
    const extractor = chooseExtractor(siteId, url);
    if (!extractor) {
      return res.status(400).json({ error: "No extractor for this site" });
    }

    // --- Optional debug Playwright session ---
    if (debug) {
      console.log("⚠️ DEBUG MODE ENABLED:", url);

      browser = await chromium.launch({
        headless: process.env.PLAYWRIGHT_HEADLESS !== "false",
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
      });
      context = await browser.newContext();
      page = await context.newPage();

      // Log site console + failing requests
      page.on("console", (msg) => console.log("🟡 PAGE:", msg.text()));
      page.on("requestfailed", (req) => console.log("❌ REQ FAILED:", req.url()));

      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

      await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });

      // First screenshot (page loaded)
      await page.screenshot({ path: "/tmp/debug_page.png", fullPage: true });
      screenshotUrl = `${process.env.RENDER_EXTERNAL_URL || ""}/debug/debug_page.png`;
    }

    // --- Call your site extractor (page is optional; extractor can ignore if it does its own fetch) ---
    const raw = await extractor.extract({ url, page, debug });

    const tableObj = raw?.rawTables?.[0] || { headers: [], rows: [] };
    const HEADERS = [
      "sku",
      "upc",
      "url",
      "color",
      "size",
      "currentPrice",
      "regularPrice",
      "availability"
    ];
    const rows = tableObj.rows || [];

    // Finish trace if running
    if (debug && context) {
      await context.tracing.stop({ path: "/tmp/trace.zip" });
      traceUrl = `${process.env.RENDER_EXTERNAL_URL || ""}/debug/trace.zip`;
    }
    if (browser) await browser.close();

    return res.json({
      status: "done",
      siteId: extractor.id,
      headers: HEADERS,
      table: rows,
      durationMs: Date.now() - startedAt,
      debugFiles: debug ? { trace: traceUrl, screenshot: screenshotUrl } : null
    });
  } catch (e) {
    console.error("❌ EXTRACT ERROR:", e?.message || e);
    if (browser) try { await browser.close(); } catch {}

    return res.status(e?.statusCode || 500).json({
      error: "Server error",
      detail: { message: e?.message || "unknown" },
      debugFiles: debug ? { trace: traceUrl, screenshot: screenshotUrl } : null
    });
  }
});

export default router;

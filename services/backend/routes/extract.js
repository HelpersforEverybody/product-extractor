import { Router } from "express";
import { chooseExtractor } from "../extractors/index.js";
import fs from "fs";
import { chromium } from "playwright";

const router = Router();

/**
 * POST /api/extract
 * body: { url, siteId, debug }
 */
router.post("/extract", async (req, res) => {
  const startedAt = Date.now();
  const { url, siteId = "auto", debug = 0 } = req.body || {};

  if (!url) return res.status(400).json({ error: "Missing url" });

  let browser, context, page, traceUrl = null;

  try {
    // ✅ Browser & debug mode only if debug=1
    if (debug) {
      console.log("⚠️ DEBUG MODE ENABLED FOR:", url);

      browser = await chromium.launch({
        headless: process.env.PLAYWRIGHT_HEADLESS !== "false"
      });

      context = await browser.newContext();
      page = await context.newPage();

      // Log console messages from target site
      page.on("console", msg => console.log("🟡 PAGE LOG:", msg.text()));
      page.on("requestfailed", req => console.log("❌ Failed request:", req.url()));

      await context.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: true,
      });

      await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });

      // Screenshot before extraction
      await page.screenshot({ path: "/tmp/debug_page.png", fullPage: true });

      console.log("✅ Page loaded for debug");
    }

    // ✅ Real extractor call (your architecture — DO NOT TOUCH)
    const extractor = chooseExtractor(siteId, url);
    if (!extractor) throw new Error("No extractor for this site");

    const raw = await extractor.extract({ url, page }); 
    // we pass page so extractor CAN use it if coded to do so

    const tableObj = raw?.rawTables?.[0] || { headers: [], rows: [] };
    const HEADERS = [
      "sku","upc","url","color","size",
      "currentPrice","regularPrice","availability"
    ];
    const rows = tableObj.rows || [];

    // ✅ Stop trace, save file if debug
    if (debug && context) {
      console.log("📦 Saving trace...");
      await context.tracing.stop({ path: "/tmp/trace.zip" });

      traceUrl = `${process.env.RENDER_EXTERNAL_URL}/debug/trace.zip`;
      console.log("📎 Trace ready at:", traceUrl);
    }

    if (browser) await browser.close();

    return res.json({
      status: "done",
      siteId: extractor.id,
      headers: HEADERS,
      table: rows,
      durationMs: Date.now() - startedAt,
      debugFiles: debug ? {
        trace: traceUrl,
        screenshot: `${process.env.RENDER_EXTERNAL_URL}/debug/debug_page.png`
      } : null
    });

  } catch (e) {
    console.error("❌ EXTRACT ERROR:", e?.message);

    if (browser) await browser.close();

    return res.status(500).json({
      error: "Server error",
      detail: e?.message,
      debug: traceUrl
    });
  }
});

export default router;

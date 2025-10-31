import { Router } from "express";
import { chooseExtractor } from "../extractors/index.js"; // NOTE: singular folder 'extractor'
import { chromium } from "playwright";


const router = Router();

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

function buildProxy() {
  if (!process.env.PROXY_SERVER) return undefined;
  return {
    server: process.env.PROXY_SERVER,              // http://proxy-server.scraperapi.com:8001
    username: process.env.PROXY_USERNAME || undefined, // "scraperapi"
    password: process.env.PROXY_PASSWORD || undefined, // YOUR_API_KEY
  };
}

/**
 * POST /api/extract
 * body: { url, siteId = "auto", debug = 0 }
 * - Creates (optional) Playwright page with ScraperAPI proxy
 * - Calls your site extractor passing the page (extractor may use or ignore)
 * - When debug=1 saves /tmp/debug_page.png and /tmp/trace.zip exposed at /debug
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

    // ---- Optional Playwright session (we pass it to extractor) ----
    if (debug) {
      console.log("⚠️ DEBUG MODE ENABLED:", url);
      browser = await chromium.launch({
        headless: process.env.PLAYWRIGHT_HEADLESS !== "false",
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        proxy: buildProxy(),
      });
      context = await browser.newContext({
        userAgent: UA,
        locale: "en-US",
        timezoneId: "America/New_York",
        viewport: { width: 1366, height: 768 },
      });
      await context.setExtraHTTPHeaders({
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Upgrade-Insecure-Requests": "1",
      });
      page = await context.newPage();

      // Helpful logs
      page.on("console", (msg) => console.log("🟡 PAGE:", msg.text()));
      page.on("requestfailed", (req) =>
        console.log("❌ REQ FAILED:", req.url())
      );

      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
      await page.screenshot({ path: "/tmp/debug_page.png", fullPage: true });

      screenshotUrl = `${process.env.RENDER_EXTERNAL_URL || ""}/debug/debug_page.png`;
    }

    // ---- Call the site extractor (it receives the page and may use/ignore it) ----
    const raw = await extractor.extract({
      url,
      page,
      debug: !!debug,
      // Provide a helper factory so extractors can open their own page if 'page' is missing:
      newPage: async () => {
        if (!browser) {
          browser = await chromium.launch({
            headless: process.env.PLAYWRIGHT_HEADLESS !== "false",
            args: ["--no-sandbox", "--disable-setuid-sandbox"],
            proxy: buildProxy(),
          });
          context = await browser.newContext({
            userAgent: UA,
            locale: "en-US",
            timezoneId: "America/New_York",
            viewport: { width: 1366, height: 768 },
          });
          await context.setExtraHTTPHeaders({
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Upgrade-Insecure-Requests": "1",
          });
        }
        return (await (context || (await browser.newContext()))).newPage();
      },
    });

    const tableObj = raw?.rawTables?.[0] || { headers: [], rows: [] };

    // enforce the exact header order the popup expects
    const HEADERS = [
      "sku",
      "upc",
      "url",
      "color",
      "size",
      "currentPrice",
      "regularPrice",
      "availability",
    ];

    // finish trace if debug
    if (debug && context) {
      await context.tracing.stop({ path: "/tmp/trace.zip" });
      traceUrl = `${process.env.RENDER_EXTERNAL_URL || ""}/debug/trace.zip`;
    }
    if (browser) await browser.close();

    return res.json({
      status: "done",
      siteId: extractor.id,
      headers: HEADERS,
      table: tableObj.rows || [],
      durationMs: Date.now() - startedAt,
      debugFiles: debug ? { trace: traceUrl, screenshot: screenshotUrl } : null,
    });
  } catch (e) {
    console.error("❌ EXTRACT ERROR:", e?.message || e);
    try { if (browser) await browser.close(); } catch {}
    return res.status(500).json({
      error: "Server error",
      detail: { message: e?.message || "unknown" },
    });
  }
});

export default router;

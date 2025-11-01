// services/backend/extractors/macys.js
import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";
import { getDebugDir, toDebugUrl } from "../utils/debugPath.js";

const DEBUG_DIR = getDebugDir();

/* ------------------------- helpers ------------------------- */

async function ensureDebugDir() {
  await fs.mkdir(DEBUG_DIR, { recursive: true }).catch(() => {});
}

function stamp(prefix) {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

// Macy's PDP anchors that indicate the page is “ready-ish”
const PDP_SELECTORS = [
  '[data-auto="product-title"]',
  'h1[data-el="product-title"]',
  "h1.pdp-title",
  '[data-auto="pdp"]',
  'div[data-auto="product-page"]',
];

// gentle autoscroll to trigger lazy hydration
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const distance = 400;
      const limit = Math.max(document.body.scrollHeight, 2500);
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        total += distance;
        if (total >= limit) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
  });
}

// wait up to waitMs until either a PDP selector appears OR Product JSON-LD is present
async function waitPdpReady(page, waitMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    // selector path
    for (const sel of PDP_SELECTORS) {
      if (await page.$(sel)) return true;
    }
    // JSON-LD fallback
    const ldOk = await page
      .$$eval('script[type="application/ld+json"]', (nodes) => {
        const all = nodes.map((n) => n.textContent || "").join("\n");
        return /"@type"\s*:\s*"Product"/i.test(all);
      })
      .catch(() => false);
    if (ldOk) return true;

    await page.waitForTimeout(600);
  }
  return false;
}

/* ------------------------- extractor ------------------------- */

export default {
  id: "macys",
  match: { hostRegex: /(^|\.)macys\.com$/i },

  /**
   * extract({ url, debug })
   * Must return: { rawTables: [{ headers, rows }] }
   */
  async extract({ url, debug = 0 }) {
    await ensureDebugDir();

    // ------------------------------------------------------------------
    // 1. ScraperAPI API endpoint (render + premium residential)
    // ------------------------------------------------------------------
    const SCRAPERAPI_KEY = process.env.SCRAPERAPI_KEY;
    if (!SCRAPERAPI_KEY) {
      const e = new Error("Missing SCRAPERAPI_KEY in environment");
      e.statusCode = 500;
      throw e;
    }

    const apiUrl = new URL("http://api.scraperapi.com");
    apiUrl.searchParams.set("api_key", SCRAPERAPI_KEY);
    apiUrl.searchParams.set("url", url);
    apiUrl.searchParams.set("render", "true");          // full JS render
    apiUrl.searchParams.set("premium", "true");         // residential IPs
    apiUrl.searchParams.set("country_code", "us");
    apiUrl.searchParams.set("keep_headers", "true");
    apiUrl.searchParams.set("session_number", "macys1"); // sticky session
    apiUrl.searchParams.set("wait", "5000");            // extra wait for lazy JS

    // ------------------------------------------------------------------
    // 2. Playwright – NO proxy object, just load the pre-rendered page
    // ------------------------------------------------------------------
    const browser = await chromium.launch({
      headless: true,
      ignoreHTTPSErrors: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
    });

    let context;
    let page;
    let traceName;
    let shotName;
    let htmlName;

    try {
      context = await browser.newContext({
        userAgent:
          process.env.PW_UA ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport: { width: 1366, height: 768 },
        locale: "en-US",
        timezoneId: "America/New_York",
        ignoreHTTPSErrors: true,
        extraHTTPHeaders: { "accept-language": "en-US,en;q=0.9" },
      });

      // light stealth
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        // @ts-ignore
        window.chrome = { runtime: {} };
        Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
        Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      });

      // US geo cookies
      await context.addCookies([
        { name: "shippingCountry", value: "US", domain: ".macys.com", path: "/" },
        {
          name: "macys_onlineZipCode",
          value: process.env.MACYS_ZIP || "10001",
          domain: ".macys.com",
          path: "/",
        },
      ]);

      // skip heavy assets
      await context.route(/\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf)$/i, (r) => r.abort());

      if (String(process.env.PW_TRACE) === "1") {
        traceName = `${stamp("trace")}.zip`;
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      }

      page = await context.newPage();
      page.setDefaultNavigationTimeout(120000);

      // ------------------------------------------------------------------
      // 3. Load the ScraperAPI-rendered page
      // ------------------------------------------------------------------
      await page.goto(apiUrl.toString(), { waitUntil: "networkidle", timeout: 90000 });

      // ------------------------------------------------------------------
      // 4. Post-load actions (same as your original logic)
      // ------------------------------------------------------------------
      await autoScroll(page);

      const ready = await waitPdpReady(page, 60000);
      if (!ready) {
        throw new Error("PDP selectors / JSON-LD not found within 60s");
      }
      console.log("Macys: PDP ready");

      // ------------------------------------------------------------------
      // 5. TODO: Replace with your actual parsing logic
      // ------------------------------------------------------------------
      const headers = [
        "sku",
        "upc",
        "url",
        "color",
        "size",
        "currentPrice",
        "regularPrice",
        "availability",
      ];
      const rows = []; // <-- fill with real data here

      // ------------------------------------------------------------------
      // 6. Debug artifacts (if requested)
      // ------------------------------------------------------------------
      if (debug) {
        const okPng = `${stamp("ok")}.png`;
        const okHtml = `${stamp("ok")}.html`;
        await page.screenshot({ path: path.join(DEBUG_DIR, okPng), fullPage: true }).catch(() => {});
        const html = await page.content();
        await fs.writeFile(path.join(DEBUG_DIR, okHtml), html, "utf8").catch(() => {});
      }

      if (traceName) {
        await context.tracing.stop({ path: path.join(DEBUG_DIR, traceName) });
      }

      return {
        rawTables: [{ headers, rows }],
        debug: { trace: traceName ? toDebugUrl(traceName) : null },
      };
    } catch (err) {
      // ------------------------------------------------------------------
      // 7. Always capture debug on failure
      // ------------------------------------------------------------------
      if (context && page) {
        try {
          shotName = `${stamp("error")}.png`;
          htmlName = `${stamp("error")}.html`;
          await page.screenshot({ path: path.join(DEBUG_DIR, shotName), fullPage: true }).catch(() => {});
          const html = await page.content().catch(() => "");
          await fs.writeFile(path.join(DEBUG_DIR, htmlName), html || "", "utf8").catch(() => {});
        } catch {}
        try {
          if (String(process.env.PW_TRACE) === "1" && traceName) {
            await context.tracing.stop({ path: path.join(DEBUG_DIR, traceName) }).catch(() => {});
          }
        } catch {}
      }

      const e2 = new Error("Server error");
      e2.statusCode = 500;
      e2.detail = {
        message: err?.message || "unknown",
        screenshot: shotName ? toDebugUrl(shotName) : null,
        html: htmlName ? toDebugUrl(htmlName) : null,
        trace: traceName ? toDebugUrl(traceName) : null,
      };
      throw e2;
    } finally {
      try { await browser.close(); } catch {}
    }
  },
};

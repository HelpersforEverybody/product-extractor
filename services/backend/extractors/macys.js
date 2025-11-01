// services/backend/extractors/macys.js
import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";
import { getDebugDir, toDebugUrl } from "../utils/debugPath.js";

const DEBUG_DIR = getDebugDir();

async function ensureDebugDir() {
  await fs.mkdir(DEBUG_DIR, { recursive: true }).catch(() => {});
}

function stamp(prefix) {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

// Wait for JSON-LD or key PDP element
async function waitPdpReady(page, timeout = 90000) {
  try {
    await page.waitForSelector('script[type="application/ld+json"]', { timeout });
    return true;
  } catch {
    return false;
  }
}

// Auto-scroll to trigger lazy load
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const distance = 500;
      const limit = Math.max(document.body.scrollHeight, 3000);
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        total += distance;
        if (total >= limit) {
          clearInterval(timer);
          resolve();
        }
      }, 150);
    });
  });
}

export default {
  id: "macys",
  match: { hostRegex: /(^|\.)macys\.com$/i },

  async extract({ url, debug = 0 }) {
    await ensureDebugDir();

    // --------------------------------------------------------------
    // 1. ScraperAPI API endpoint (residential + render)
    // --------------------------------------------------------------
    const SCRAPERAPI_KEY = process.env.SCRAPERAPI_KEY;
    if (!SCRAPERAPI_KEY) throw new Error("SCRAPERAPI_KEY missing");

    const apiUrl = new URL("http://api.scraperapi.com");
    apiUrl.searchParams.set("api_key", SCRAPERAPI_KEY);
    apiUrl.searchParams.set("url", url);
    apiUrl.searchParams.set("render", "true");
    apiUrl.searchParams.set("premium", "true");
    apiUrl.searchParams.set("country_code", "us");
    apiUrl.searchParams.set("keep_headers", "true");
    apiUrl.searchParams.set("session_number", "macys1");
    apiUrl.searchParams.set("wait", "8000"); // 8s extra for JS

    // --------------------------------------------------------------
    // 2. Launch Playwright
    // --------------------------------------------------------------
    const browser = await chromium.launch({
      headless: true,
      ignoreHTTPSErrors: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
    });

    let context, page, traceName, shotName, htmlName;

    try {
      context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport: { width: 1366, height: 768 },
        locale: "en-US",
        timezoneId: "America/New_York",
        extraHTTPHeaders: { "accept-language": "en-US,en;q=0.9" },
      });

      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        window.chrome = { runtime: {} };
        Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
        Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      });

      await context.addCookies([
        { name: "shippingCountry", value: "US", domain: ".macys.com", path: "/" },
        { name: "macys_onlineZipCode", value: process.env.MACYS_ZIP || "10001", domain: ".macys.com", path: "/" },
      ]);

      await context.route(/\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|css)$/, r => r.abort());

      if (String(process.env.PW_TRACE) === "1") {
        traceName = `${stamp("trace")}.zip`;
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      }

      page = await context.newPage();
      page.setDefaultNavigationTimeout(120000);

      // --------------------------------------------------------------
      // 3. Load via ScraperAPI
      // --------------------------------------------------------------
      console.log("Loading via ScraperAPI...");
      await page.goto(apiUrl.toString(), { waitUntil: "networkidle", timeout: 120000 });

      await autoScroll(page);
      const ready = await waitPdpReady(page, 90000);
      if (!ready) throw new Error("JSON-LD not found – page not fully loaded");

      // --------------------------------------------------------------
      // 4. Extract JSON-LD (contains SKU, UPC, offers, variants)
      // --------------------------------------------------------------
      const jsonLd = await page.$$eval('script[type="application/ld+json"]', nodes =>
        nodes.map(n => {
          try { return JSON.parse(n.textContent); } catch { return null; }
        }).filter(Boolean)
      );

      const productData = jsonLd.find(d => d["@type"] === "Product") || {};
      const { sku, gtin13: upc, offers = {}, name, brand } = productData;

      // --------------------------------------------------------------
      // 5. Select first variant (size/color) to unlock price/availability
      // --------------------------------------------------------------
      let currentPrice = null, regularPrice = null, availability = "unknown";

      try {
        const sizeBtn = await page.locator('button[data-auto="size-swatch"]').first();
        if (await sizeBtn.isVisible()) {
          await sizeBtn.click();
          await page.waitForTimeout(1000);
        }

        const colorBtn = await page.locator('button[data-auto="color-swatch"]').first();
        if (await colorBtn.isVisible()) {
          await colorBtn.click();
          await page.waitForTimeout(1000);
        }

        // Re-read price after selection
        const priceText = await page.locator('[data-auto="price"] .price').first().textContent();
        const match = priceText.match(/\$?([\d,]+\.?\d*)/g);
        if (match) {
          currentPrice = match[0].replace(/[^0-9.]/g, '');
          regularPrice = match[1] ? match[1].replace(/[^0-9.]/g, '') : currentPrice;
        }

        availability = await page.locator('[data-auto="availability"]').textContent().catch(() => "In Stock");
      } catch (e) {
        console.log("Variant selection failed (normal for sold-out items):", e.message);
      }

      // --------------------------------------------------------------
      // 6. Extract selected color/size
      // --------------------------------------------------------------
      const selectedColor = await page.locator('[data-auto="selected-color"]').textContent().catch(() => "N/A");
      const selectedSize = await page.locator('[data-auto="selected-size"]').textContent().catch(() => "N/A");

      // --------------------------------------------------------------
      // 7. Build rows
      // --------------------------------------------------------------
      const headers = ["sku", "upc", "url", "color", "size", "currentPrice", "regularPrice", "availability"];
      const rows = [[
        sku || "N/A",
        upc || "N/A",
        url,
        selectedColor,
        selectedSize,
        currentPrice || "N/A",
        regularPrice || "N/A",
        availability
      ]];

      // --------------------------------------------------------------
      // 8. Debug output
      // --------------------------------------------------------------
      if (debug) {
        const okPng = `${stamp("ok")}.png`;
        const okHtml = `${stamp("ok")}.html`;
        await page.screenshot({ path: path.join(DEBUG_DIR, okPng), fullPage: true });
        await fs.writeFile(path.join(DEBUG_DIR, okHtml), await page.content(), "utf8");
      }

      if (traceName) {
        await context.tracing.stop({ path: path.join(DEBUG_DIR, traceName) });
      }

      return {
        rawTables: [{ headers, rows }],
        debug: { trace: traceName ? toDebugUrl(traceName) : null },
      };

    } catch (err) {
      // --------------------------------------------------------------
      // 9. Always save error debug
      // --------------------------------------------------------------
      if (context && page) {
        try {
          shotName = `${stamp("error")}.png`;
          htmlName = `${stamp("error")}.html`;
          await page.screenshot({ path: path.join(DEBUG_DIR, shotName), fullPage: true });
          await fs.writeFile(path.join(DEBUG_DIR, htmlName), await page.content(), "utf8");
        } catch {}
        if (traceName) await context.tracing.stop({ path: path.join(DEBUG_DIR, traceName) }).catch(() => {});
      }

      const e2 = new Error("Extraction failed");
      e2.statusCode = 500;
      e2.detail = {
        message: err.message,
        screenshot: shotName ? toDebugUrl(shotName) : null,
        html: htmlName ? toDebugUrl(htmlName) : null,
        trace: traceName ? toDebugUrl(traceName) : null,
      };
      throw e2;
    } finally {
      await browser.close().catch(() => {});
    }
  },
};

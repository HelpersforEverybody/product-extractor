// services/backend/extractors/macys.js
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const DEBUG_DIR = path.join(process.cwd(), "public", "debug");
async function ensureDebugDir() {
  try { await fs.mkdir(DEBUG_DIR, { recursive: true }); } catch {}
}
function stamp(prefix) {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

// Macy's product anchors we consider "page is ready-ish"
const PRODUCT_SELECTORS = [
  '[data-auto="product-title"]',
  'h1[data-el="product-title"]',
  "h1.pdp-title",
  '[data-auto="pdp"]',
  'div[data-auto="product-page"]',
];

async function waitForAny(page, selectors, timeoutMs) {
  const start = Date.now();
  for (;;) {
    for (const sel of selectors) {
      const ok = await page.$(sel);
      if (ok) return sel;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`product selector did not appear within ${timeoutMs}ms`);
    }
    await page.waitForTimeout(300);
  }
}

export default {
  id: "macys",
  match: { hostRegex: /(^|\.)macys\.com$/i },

  /**
   * extract({ url, debug })
   * Return shape must be { rawTables: [{ headers, rows }] }.
   */
  async extract({ url, debug = 0 }) {
    await ensureDebugDir();

    const browser = await chromium.launch({
      headless: true,
      ignoreHTTPSErrors: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });

    let context;
    let page;
    let traceName;            // /public/debug/<file>.zip
    let screenshotName;       // /public/debug/<file>.png
    let htmlName;             // /public/debug/<file>.html

    try {
      context = await browser.newContext({
        userAgent:
          process.env.PW_UA ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport: { width: 1366, height: 768 },
        ignoreHTTPSErrors: true,
      });

      // Optional Playwright trace
      if (String(process.env.PW_TRACE) === "1") {
        traceName = `${stamp("trace")}.zip`;
        await context.tracing.start({
          screenshots: true,
          snapshots: true,
          sources: true,
        });
      }

      page = await context.newPage();

      // Block heavy assets
      await page.route(/\.(?:png|jpe?g|gif|webp|svg|ico|woff2?|ttf)$/i, r => r.abort());

      // Optional proxy/geo check
      if (debug) {
        try {
          const ipPage = await context.newPage();
          await ipPage.goto("https://api.ipify.org?format=json", { waitUntil: "commit", timeout: 20000 });
          console.log("Proxy IP:", await ipPage.textContent("body"));
          await ipPage.close();
        } catch (e) {
          console.log("IP check failed (non-fatal):", e.message);
        }
      }

      // Navigate & wait
      page.setDefaultNavigationTimeout(120000);
      await page.goto(url, { waitUntil: "commit", timeout: 90000 });

      const gotSel = await waitForAny(page, PRODUCT_SELECTORS, 30000);
      console.log("Macys: product anchor detected:", gotSel);

      // -------------------------------
      // TODO: your real extraction here
      // -------------------------------
      const headers = ["sku","upc","url","color","size","currentPrice","regularPrice","availability"];
      const rows = []; // build from the page

      // Optionally capture artifacts on success if debug
      if (debug) {
        try {
          screenshotName = `${stamp("page")}.png`;
          htmlName = `${stamp("page")}.html`;
          await page.screenshot({ path: path.join(DEBUG_DIR, screenshotName), fullPage: true }).catch(() => {});
          const html = await page.content().catch(() => "");
          await fs.writeFile(path.join(DEBUG_DIR, htmlName), html || "", "utf8").catch(() => {});
        } catch {}
      }

      if (traceName) {
        await context.tracing.stop({ path: path.join(DEBUG_DIR, traceName) }).catch(() => {});
      }

      return {
        rawTables: [{ headers, rows }],
        debug: {
          screenshot: screenshotName ? `/debug/${screenshotName}` : null,
          html: htmlName ? `/debug/${htmlName}` : null,
          trace: traceName ? `/debug/${traceName}` : null,
        },
      };
    } catch (err) {
      // Always capture artifacts on failure
      if (context && page) {
        try {
          screenshotName = `${stamp("error")}.png`;
          htmlName = `${stamp("error")}.html`;
          await page.screenshot({ path: path.join(DEBUG_DIR, screenshotName), fullPage: true }).catch(() => {});
          const html = await page.content().catch(() => "");
          await fs.writeFile(path.join(DEBUG_DIR, htmlName), html || "", "utf8").catch(() => {});
        } catch {}
        try {
          if (String(process.env.PW_TRACE) === "1") {
            traceName = traceName || `${stamp("trace")}.zip`;
            await context.tracing.stop({ path: path.join(DEBUG_DIR, traceName) }).catch(() => {});
          }
        } catch {}
      }

      const e2 = new Error("macys: navigate/extract failed");
      e2.statusCode = 500;
      e2.detail = {
        message: err.message || "unknown",
        screenshot: screenshotName ? `/debug/${screenshotName}` : null,
        html: htmlName ? `/debug/${htmlName}` : null,
        trace: traceName ? `/debug/${traceName}` : null,
      };
      throw e2;
    } finally {
      try { await context?.close(); } catch {}
      try { await browser.close(); } catch {}
    }
  },
};

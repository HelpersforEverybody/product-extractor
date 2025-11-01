// services/backend/extractors/macys.js
import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";
import { getDebugDir, toDebugUrl } from "../utils/debugPath.js";

const DEBUG_DIR = path.join(process.cwd(), "public", "debug");
async function ensureDebugDir() {
  await fs.mkdir(DEBUG_DIR, { recursive: true }).catch(() => {});
}
function stamp(name) {
  const t = new Date().toISOString().replace(/[:.]/g, "-");
  return `${name}-${t}`;
}
const outDir = getDebugDir();
const ts = new Date().toISOString().replace(/[:]/g, "-");

const pngName = `page-${ts}.png`;
await page.screenshot({ path: path.join(outDir, pngName), fullPage: true });

const htmlName = `page-${ts}.html`;
await fs.writeFile(path.join(outDir, htmlName), await page.content());

// if tracing enabled:
const traceName = `trace-${ts}.zip`;
await context.tracing.stop({ path: path.join(outDir, traceName) });

result.debug = {
  screenshot: toDebugUrl(pngName),
  html: toDebugUrl(htmlName),
  trace: toDebugUrl(traceName),
};
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
    await page.waitForTimeout(300); // small poll
  }
}

export default {
  id: "macys",
  match: { hostRegex: /(^|\.)macys\.com$/i },

  /**
   * extract({ url, debug })
   * Return shape must still be { rawTables: [{ headers, rows }] } to match your router.
   */
  async extract({ url, debug = 0 }) {
    await ensureDebugDir();

    // ----- launch
    const browser = await chromium.launch({
      headless: true,                     // Render has no GUI
      ignoreHTTPSErrors: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox",
      ],
      // If you pass proxy via PLAYWRIGHT env, keep your existing code here
      // proxy: { server: process.env.PLAYWRIGHT_PROXY || undefined }
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
        ignoreHTTPSErrors: true,
      });

      // Start trace if requested
      if (String(process.env.PW_TRACE) === "1") {
        traceName = stamp("trace") + ".zip";
        await context.tracing.start({
          screenshots: true,
          snapshots: true,
          sources: true,
        });
      }

      page = await context.newPage();

      // Block heavy assets (faster / less tracking)
      await page.route(/\.(?:png|jpe?g|gif|webp|svg|ico|woff2?|ttf)$/i, (r) => r.abort());

      // Optional: confirm proxy/geo
      if (debug) {
        try {
          const ipPage = await context.newPage();
          await ipPage.goto("https://api.ipify.org?format=json", { waitUntil: "commit", timeout: 20000 });
          const ipJson = await ipPage.textContent("body");
          console.log("Proxy IP check:", ipJson);
          await ipPage.close();
        } catch (e) {
          console.log("IP check failed (non-fatal):", e.message);
        }
      }

      // ---- NEW wait strategy ----
      page.setDefaultNavigationTimeout(120000);
      await page.goto(url, { waitUntil: "commit", timeout: 90000 });

      // wait until we see any product anchor (30s)
      const gotSel = await waitForAny(page, PRODUCT_SELECTORS, 30000);
      console.log("Macys: product anchor detected:", gotSel);

      // -------------------------------
      // YOUR EXISTING DATA EXTRACTION
      // -------------------------------
      // Keep the logic you already have that builds:
      //   const headers = [...];
      //   const rows = [...];
      // Example placeholders:
      const headers = ["sku","upc","url","color","size","currentPrice","regularPrice","availability"];
      const rows = []; // fill from your current logic

      // Stop trace on success as well
      if (traceName) {
        await context.tracing.stop({ path: path.join(DEBUG_DIR, traceName) });
      }

      return {
        rawTables: [{ headers, rows }],
        debug: {
          trace: traceName ? `/debug/${traceName}` : null,
        },
      };
    } catch (err) {
      // ---- Failure path: always save screenshot + HTML + trace
      if (context && page) {
        try {
          shotName = stamp("page") + ".png";
          htmlName = stamp("page") + ".html";
          await page.screenshot({ path: path.join(DEBUG_DIR, shotName), fullPage: true }).catch(() => {});
          const html = await page.content().catch(() => "");
          await fs.writeFile(path.join(DEBUG_DIR, htmlName), html || "", "utf8").catch(() => {});
        } catch (_) {}
        try {
          if (String(process.env.PW_TRACE) === "1") {
            traceName = traceName || stamp("trace") + ".zip";
            await context.tracing.stop({ path: path.join(DEBUG_DIR, traceName) }).catch(() => {});
          }
        } catch (_) {}
      }

      // bubble the debug links up so the API can return them
      const detail = {
        message: err.message || "unknown",
        screenshot: shotName ? `/debug/${shotName}` : null,
        html: htmlName ? `/debug/${htmlName}` : null,
        trace: traceName ? `/debug/${traceName}` : null,
      };
      const e2 = new Error("macys: navigate/extract failed");
      e2.statusCode = 500;
      e2.detail = detail;
      throw e2;
    } finally {
      try { await browser.close(); } catch {}
    }
  },
};

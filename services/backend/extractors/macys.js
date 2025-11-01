// services/backend/extractors/macys.js
import { chromium } from "playwright";
import fs from "fs/promises";
import path from "path";
import { getDebugDir, toDebugUrl } from "../utils/debugPath.js";

const DEBUG_DIR = getDebugDir();

// ensure /public/debug exists
async function ensureDebugDir() {
  await fs.mkdir(DEBUG_DIR, { recursive: true }).catch(() => {});
}

// timestamped filename helper
function stamp(prefix) {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

// selectors that indicate a Macy's PDP is “ready-ish”
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
      const limit = Math.max(document.body.scrollHeight, 2000);
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

// wait up to waitMs until either a PDP selector appears OR a Product JSON-LD is present
async function waitPdpReady(page, waitMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    for (const sel of PDP_SELECTORS) {
      if (await page.$(sel)) return true;
    }
    // JSON-LD fallback
    const ldOk = await page
      .$$eval('script[type="application/ld+json"]', (nodes) => {
        const all = nodes.map((n) => n.textContent || "").join("\n");
        return /\"@type\"\s*:\s*\"Product\"/i.test(all);
      })
      .catch(() => false);
    if (ldOk) return true;

    await page.waitForTimeout(600);
  }
  return false;
}

export default {
  id: "macys",
  match: { hostRegex: /(^|\.)macys\.com$/i },

  /**
   * extract({ url, debug })
   * Must return: { rawTables: [{ headers, rows }] }
   */
  async extract({ url, debug = 0 }) {
    await ensureDebugDir();

    // ---------- launch (proxy picked from env if provided) ----------
    const browser = await chromium.launch({
      headless: true,
      ignoreHTTPSErrors: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
      proxy: process.env.PW_PROXY_SERVER
        ? {
            server: process.env.PW_PROXY_SERVER,
            username: process.env.PW_PROXY_USERNAME || undefined,
            password: process.env.PW_PROXY_PASSWORD || undefined,
          }
        : undefined,
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
        geolocation: { latitude: 40.7128, longitude: -74.0060 },
        permissions: ["geolocation"],
        ignoreHTTPSErrors: true,
        extraHTTPHeaders: { "accept-language": "en-US,en;q=0.9" },
      });

      // stealth-ish tweaks
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        // @ts-ignore
        window.chrome = { runtime: {} };
        Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
        Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      });

      // useful cookies for geo
      await context.addCookies([
        { name: "shippingCountry", value: "US", domain: ".macys.com", path: "/" },
        { name: "macys_onlineZipCode", value: process.env.MACYS_ZIP || "10001", domain: ".macys.com", path: "/" },
      ]);

      if (String(process.env.PW_TRACE) === "1") {
        traceName = `${stamp("trace")}.zip`;
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      }

      page = await context.newPage();
      page.setDefaultNavigationTimeout(120000);

      // optional: show proxy IP in logs
      if (debug) {
        try {
          const ipTab = await context.newPage();
          await ipTab.goto("https://api.ipify.org?format=json", {
            waitUntil: "commit",
            timeout: 20000,
          });
          console.log("Proxy IP:", await ipTab.textContent("body"));
          await ipTab.close();
        } catch (e) {
          console.log("IP check failed:", e.message);
        }
      }

      // hit home so consent/geo apply
      await page.goto("https://www.macys.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
      // dismiss common consent (best-effort)
      try {
        await page.click('button:has-text("Accept")', { timeout: 4000 });
      } catch {}
      try {
        await page.click('[data-auto="footer-accept"]', { timeout: 4000 });
      } catch {}

      // now navigate to the product page
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });

      // help hydration
      await autoScroll(page);

      // wait for readiness (selector or JSON-LD)
      const ready = await waitPdpReady(page, 60000);
      if (!ready) throw new Error("product selector did not appear within 60000ms");
      console.log("Macys: PDP looks ready");

      // -----------------------------
      // TODO: your existing extraction
      // -----------------------------
      // Keep the headers your popup expects:
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
      const rows = []; // <— fill with your current logic if you have it

      // stop trace on success
      if (traceName) {
        await context.tracing.stop({ path: path.join(DEBUG_DIR, traceName) });
      }

      return {
        rawTables: [{ headers, rows }],
        debug: { trace: traceName ? toDebugUrl(traceName) : null },
      };
    } catch (err) {
      // ---------- ALWAYS capture artifacts on failure ----------
      if (context && page) {
        try {
          shotName = `${stamp("error")}.png`;
          htmlName = `${stamp("error")}.html`;
          await page.screenshot({ path: path.join(DEBUG_DIR, shotName), fullPage: true }).catch(() => {});
          const html = await page.content().catch(() => "");
          await fs.writeFile(path.join(DEBUG_DIR, htmlName), html || "", "utf8").catch(() => {});
        } catch {}
        try {
          if (String(process.env.PW_TRACE) === "1" && !traceName) {
            traceName = `${stamp("trace")}.zip`;
            await context.tracing.stop({ path: path.join(DEBUG_DIR, traceName) }).catch(() => {});
          }
        } catch {}
      }

      const e2 = new Error("Server error");
      // pass rich details to router so frontend can show links
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

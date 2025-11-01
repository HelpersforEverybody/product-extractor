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

// Accept either PW_PROXY (full URL) OR PW_PROXY_SERVER + USERNAME/PASSWORD
function proxyFromEnv() {
  const p = process.env.PW_PROXY || "";
  if (p) {
    // Playwright accepts "http://user:pass@host:port"
    return { server: p };
  }
  if (process.env.PW_PROXY_SERVER) {
    return {
      server: process.env.PW_PROXY_SERVER,
      username: process.env.PW_PROXY_USERNAME || undefined,
      password: process.env.PW_PROXY_PASSWORD || undefined,
    };
  }
  return undefined;
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

    const proxy = proxyFromEnv();

    const browser = await chromium.launch({
      headless: true,
      ignoreHTTPSErrors: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
      ],
      proxy, // <— use ScraperAPI/your proxy
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

      // light stealth
      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        // @ts-ignore
        window.chrome = { runtime: {} };
        Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
        Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      });

      // US geo cookies (best-effort)
      await context.addCookies([
        { name: "shippingCountry", value: "US", domain: ".macys.com", path: "/" },
        {
          name: "macys_onlineZipCode",
          value: process.env.MACYS_ZIP || "10001",
          domain: ".macys.com",
          path: "/",
        },
      ]);

      // speed up: skip images/fonts (Macy’s is heavy)
      await context.route(/\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf)$/i, (r) => r.abort());

      if (String(process.env.PW_TRACE) === "1") {
        traceName = `${stamp("trace")}.zip`;
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      }

            page = await context.newPage();
      page.setDefaultNavigationTimeout(120000);

      // --- PROBE: can the proxy actually reach macys.com? ---
      try {
        const resp = await context.request.get("https://www.macys.com/", { timeout: 8000 });
        console.log("Probe macys.com status:", resp.status());
        // Treat 403/5xx as a proxy/egress block
        if (resp.status() === 403 || resp.status() >= 500) {
          const e = new Error(`proxy/egress: macys.com responded ${resp.status()}`);
          e.statusCode = 502;
          throw e;
        }
      } catch (e) {
        const err = new Error(`proxy/egress: cannot reach macys.com home (${e.message})`);
        err.statusCode = 502;
        throw err;
      }

      // 1) hit home so consent/geo apply; try to accept consent
      await page.goto("https://www.macys.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
      try { await page.click('button:has-text("Accept")', { timeout: 4000 }); } catch {}
      try { await page.click('[data-auto="footer-accept"]', { timeout: 4000 }); } catch {}

      // 2) navigate to product
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });


      // Optional: verify proxy IP in logs
     // Optional: verify proxy IP in logs using request API (non-blocking)
if (debug) {
  try {
    const resp = await context.request.get("https://api.ipify.org?format=json", { timeout: 3000 });
    console.log("Proxy IP:", await resp.text());
  } catch (e) {
    console.log("IP check skipped:", e.message);
  }
}


      // 1) hit home so consent/geo apply; try to accept consent
      try {
  await page.goto("https://www.macys.com/", { waitUntil: "domcontentloaded", timeout: 15000 });
} catch {
  const err = new Error("proxy/egress: cannot reach macys.com home within 15s");
  err.statusCode = 502;
  throw err;
}
      try { await page.click('button:has-text("Accept")', { timeout: 4000 }); } catch {}
      try { await page.click('[data-auto="footer-accept"]', { timeout: 4000 }); } catch {}

      // 2) navigate to product
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });

      await autoScroll(page);

      const ready = await waitPdpReady(page, 60000);
      if (!ready) throw new Error("product selector did not appear within 60000ms");
      console.log("Macys: PDP looks ready");

      // ------------------------------------
      // TODO: replace with your real parsing
      // ------------------------------------
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
      const rows = []; // fill from your current logic

      // optional: save artifacts on success when debug flag is set
      if (debug) {
        const okPng = `${stamp("ok")}.png`;
        const okHtml = `${stamp("ok")}.html`;
        await page.screenshot({ path: path.join(DEBUG_DIR, okPng), fullPage: true }).catch(() => {});
        const html = await page.content().catch(() => "");
        await fs.writeFile(path.join(DEBUG_DIR, okHtml), html || "", "utf8").catch(() => {});
      }

      if (traceName) {
        await context.tracing.stop({ path: path.join(DEBUG_DIR, traceName) });
      }

      return {
        rawTables: [{ headers, rows }],
        debug: { trace: traceName ? toDebugUrl(traceName) : null },
      };
    } catch (err) {
      // ALWAYS capture artifacts on failure
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
            // if started, ensure we stop and flush the file
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

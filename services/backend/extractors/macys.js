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

// FULL STEALTH
async function setupStealth(context) {
  await context.addInitScript(() => {
    // Kill webdriver
    delete navigator.__proto__.webdriver;
    Object.defineProperty(navigator, "webdriver", { get: () => false });

    // Fake chrome
    window.chrome = { runtime: {}, app: {}, csi: () => {}, loadTimes: () => {} };

    // Fake plugins & languages
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });

    // Block bot detection
    const block = ["webdriver", "selenium", "playwright", "puppeteer", "automation"];
    block.forEach(prop => delete window[prop]);
  });
}

// Accept cookie banner
async function acceptCookieConsent(page) {
  try {
    const btn = page.locator('button:has-text("Confirm My Choices"), #onetrust-accept-btn-handler, button[title*="Accept"]');
    if (await btn.isVisible({ timeout: 10000 })) {
      await btn.click();
      await page.waitForTimeout(2000);
      console.log("Cookie banner accepted");
    }
  } catch (e) {
    console.log("No cookie banner");
  }
}

// Get __INITIAL_STATE__
async function getInitialState(page) {
  return page.evaluate(() => {
    return new Promise(resolve => {
      const handler = (e) => {
        if (e.data.type === 'MACYS_INITIAL_STATE') {
          window.removeEventListener('message', handler);
          try { resolve(JSON.parse(e.data.data)); } catch { resolve(null); }
        }
      };
      window.addEventListener('message', handler);

      try {
        const data = JSON.stringify(window.__INITIAL_STATE__);
        window.postMessage({ type: 'MACYS_INITIAL_STATE', data }, '*');
      } catch {}

      setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve(null);
      }, 15000);
    });
  });
}

export default {
  id: "macys",
  match: { hostRegex: /(^|\.)macys\.com$/i },

  async extract({ url, debug = 0 }) {
    await ensureDebugDir();

    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-blink-features=AutomationControlled"],
    });

    let context, page, traceName, shotName, htmlName;

    try {
      context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        viewport: { width: 1366, height: 768 },
        locale: "en-US",
        timezoneId: "America/New_York",
        javaScriptEnabled: true,
        bypassCSP: true,
        extraHTTPHeaders: {
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          "DNT": "1",
          "Connection": "keep-alive",
          "Upgrade-Insecure-Requests": "1",
        },
      });

      await setupStealth(context);

      // Critical cookies
      await context.addCookies([
        { name: "shippingCountry", value: "US", domain: ".macys.com", path: "/" },
        { name: "macys_onlineZipCode", value: "10001", domain: ".macys.com", path: "/" },
        { name: "optimizelyEndUserId", value: "oeu" + Date.now(), domain: ".macys.com", path: "/" },
      ]);

      await context.route("**/*.{png,jpg,jpeg,gif,svg,css,woff,woff2,ttf}", r => r.abort());

      if (process.env.PW_TRACE === "1") {
        traceName = `${stamp("trace")}.zip`;
        await context.tracing.start({ screenshots: true, snapshots: true });
      }

      page = await context.newPage();

      // === DIRECT LOAD (NO PROXY) ===
      console.log("Loading directly:", url);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

      // Accept cookies
      await acceptCookieConsent(page);

      // Wait for product
      await page.waitForSelector('#productMktData, [data-auto="product-title"], h1', { timeout: 60000 });

      // Extract
      const initialState = await getInitialState(page);
      const sizeMap = {};

      if (initialState) {
        const upcs = initialState.pageData?.product?.product?.relationships?.upcs || {};
        Object.values(upcs).forEach(u => {
          const size = u.attributes?.find(a => a.name === 'SIZE')?.value;
          if (size && u.identifier?.upcNumber) {
            sizeMap[u.identifier.upcNumber.toString()] = size;
          }
        });
      }

      let offers = [];
      try {
        const json = await page.locator('#productMktData').textContent();
        offers = JSON.parse(json).offers || [];
      } catch (e) {
        console.warn("No JSON-LD");
      }

      const rows = offers.map(o => {
        const upc = (o.SKU || '').replace('USA', '');
        let size = 'N/A';
        if (o.itemOffered?.attributes) {
          const s = o.itemOffered.attributes.find(a => a.name?.toUpperCase() === 'SIZE');
          if (s?.value) size = s.value;
        }
        if (size === 'N/A' && sizeMap[upc]) size = sizeMap[upc];

        return [
          o.SKU || 'N/A',
          upc,
          url,
          o.itemOffered?.color || 'N/A',
          size,
          o.price?.toString() || 'N/A',
          o.regularPrice || 'N/A',
          (o.availability || '').split('/').pop() || 'N/A'
        ];
      });

      if (rows.length === 0) rows.push(['N/A', 'N/A', url, 'N/A', 'N/A', 'N/A', 'N/A', 'N/A']);

      const headers = ["sku", "upc", "url", "color", "size", "currentPrice", "regularPrice", "availability"];

      if (debug) {
        const png = `${stamp("ok")}.png`;
        const html = `${stamp("ok")}.html`;
        await page.screenshot({ path: path.join(DEBUG_DIR, png), fullPage: true });
        await fs.writeFile(path.join(DEBUG_DIR, html), await page.content());
      }

      if (traceName) await context.tracing.stop({ path: path.join(DEBUG_DIR, traceName) });

      return { rawTables: [{ headers, rows }] };

    } catch (err) {
      if (page) {
        shotName = `${stamp("error")}.png`;
        htmlName = `${stamp("error")}.html`;
        await page.screenshot({ path: path.join(DEBUG_DIR, shotName), fullPage: true }).catch(() => {});
        await fs.writeFile(path.join(DEBUG_DIR, htmlName), await page.content()).catch(() => {});
        if (traceName) await context.tracing.stop({ path: path.join(DEBUG_DIR, traceName) }).catch(() => {});
      }

      const e = new Error("Extraction failed");
      e.statusCode = 500;
      e.detail = {
        message: err.message,
        screenshot: shotName ? toDebugUrl(shotName) : null,
        html: htmlName ? toDebugUrl(htmlName) : null,
        trace: traceName ? toDebugUrl(traceName) : null,
      };
      throw e;
    } finally {
      await browser.close().catch(() => {});
    }
  },
};

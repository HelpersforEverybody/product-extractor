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

// FULL STEALTH + HEADER SPOOF
async function setupStealth(context) {
  await context.addInitScript(() => {
    // Remove webdriver
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    delete navigator.__proto__.webdriver;

    // Spoof chrome
    window.chrome = {
      runtime: {},
      loadTimes: () => {},
      csi: () => {},
    };

    // Spoof plugins
    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
    });

    // Spoof languages
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"],
    });

    // Spoof screen
    Object.defineProperty(screen, "devicePixelRatio", { get: () => 1 });

    // Block known bot detectors
    const blocked = [
      "navigator.webdriver",
      "window.outerWidth",
      "window.outerHeight",
      "navigator.plugins",
      "navigator.languages",
    ];
    blocked.forEach(prop => {
      try { delete window[prop]; } catch {}
    });
  });
}

// Auto-accept cookie consent
async function acceptCookieConsent(page) {
  try {
    const frame = page.frames().find(f => f.url().includes("onetrust") || f.name().includes("consent"));
    if (!frame) return false;

    const btn = frame.locator('button:has-text("Confirm My Choices"), #onetrust-accept-btn-handler, button[title="Accept"]');
    if (await btn.isVisible({ timeout: 8000 })) {
      await btn.click();
      await page.waitForTimeout(2000);
      console.log("Cookie consent accepted");
      return true;
    }
  } catch {}
  return false;
}

// Wait for __INITIAL_STATE__
async function waitForInitialState(page) {
  return await page.evaluate(() => {
    return new Promise(resolve => {
      const handler = (e) => {
        if (e.data.type === 'MACYS_INITIAL_STATE') {
          window.removeEventListener('message', handler);
          try { resolve(JSON.parse(e.data.data)); }
          catch { resolve(null); }
        }
      };
      window.addEventListener('message', handler);

      // Trigger inject
      (function() {
        try {
          const data = JSON.stringify(window.__INITIAL_STATE__);
          window.postMessage({ type: 'MACYS_INITIAL_STATE', data }, '*');
        } catch {}
      })();

      setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve(null);
      }, 20000);
    });
  });
}

export default {
  id: "macys",
  match: { hostRegex: /(^|\.)macys\.com$/i },

  async extract({ url, debug = 0 }) {
    await ensureDebugDir();

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
    apiUrl.searchParams.set("wait", "20000"); // 20s render

    const browser = await chromium.launch({
      headless: true,
      ignoreHTTPSErrors: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-web-security"],
    });

    let context, page, traceName, shotName, htmlName;

    try {
      context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        viewport: { width: 1366, height: 768 },
        locale: "en-US",
        timezoneId: "America/New_York",
        javaScriptEnabled: true,
        extraHTTPHeaders: {
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          "DNT": "1",
          "Connection": "keep-alive",
          "Upgrade-Insecure-Requests": "1",
        },
      });

      // FULL STEALTH
      await setupStealth(context);

      await context.addCookies([
        { name: "shippingCountry", value: "US", domain: ".macys.com", path: "/" },
        { name: "macys_onlineZipCode", value: "10001", domain: ".macys.com", path: "/" },
      ]);

      await context.route("**/*.{png,jpg,jpeg,gif,svg,css,woff,woff2}", route => route.abort());

      if (process.env.PW_TRACE === "1") {
        traceName = `${stamp("trace")}.zip`;
        await context.tracing.start({ screenshots: true, snapshots: true });
      }

      page = await context.newPage();
      page.setDefaultNavigationTimeout(180000);

      // === LOAD PAGE ===
      await page.goto(apiUrl.toString(), { waitUntil: "domcontentloaded", timeout: 120000 });
      await page.waitForTimeout(3000);

      // === ACCEPT COOKIES ===
      await acceptCookieConsent(page);

      // === AUTO SCROLL ===
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2000);

      // === WAIT FOR CONTENT ===
      const selectors = [
        '#productMktData',
        '[data-auto="product-title"]',
        'h1.pdp-title',
        '.product-title',
        'h1[data-el="product-title"]'
      ];

      let loaded = false;
      for (const sel of selectors) {
        try {
          await page.waitForSelector(sel, { timeout: 10000 });
          console.log(`PDP loaded via: ${sel}`);
          loaded = true;
          break;
        } catch {}
      }

      if (!loaded) throw new Error("PDP content not found – possible bot detection");

      // === EXTRACT DATA ===
      const initialState = await waitForInitialState(page);
      const sizeMap = {};

      if (initialState) {
        const upcs = initialState?.pageData?.product?.product?.relationships?.upcs || {};
        Object.values(upcs).forEach(u => {
          const size = u.attributes?.find(a => a.name === 'SIZE')?.value;
          if (size && u.identifier?.upcNumber) {
            sizeMap[u.identifier.upcNumber.toString()] = size;
          }
        });
      }

      let offers = [];
      try {
        const jsonText = await page.locator('#productMktData').textContent();
        const data = JSON.parse(jsonText);
        offers = data.offers || [];
      } catch (e) {
        console.warn("No #productMktData – using fallback DOM parse");
      }

      const rows = offers.map(o => {
        const upc = (o.SKU || '').replace('USA', '');
        let size = 'N/A';
        if (o.itemOffered?.attributes) {
          const attr = o.itemOffered.attributes.find(a => a.name?.toUpperCase() === 'SIZE');
          if (attr?.value) size = attr.value;
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

      if (rows.length === 0) {
        // Fallback: extract from DOM
        const title = await page.locator('[data-auto="product-title"], h1').first().textContent().catch(() => '');
        rows.push(['N/A', 'N/A', url, 'N/A', 'N/A', 'N/A', 'N/A', 'N/A']);
      }

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

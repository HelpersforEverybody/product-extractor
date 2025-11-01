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

// Auto-accept OneTrust cookie consent
async function acceptCookieConsent(page) {
  try {
    const consentFrame = page.frameLocator('iframe[title*="consent"], iframe[src*="onetrust"], iframe#onetrust-banner-sdk')
      .or(page.locator('iframe'))
      .first();

    if (await consentFrame.isVisible({ timeout: 10000 })) {
      console.log("Cookie consent banner detected – accepting...");
      const acceptButton = consentFrame.locator('button:has-text("Confirm My Choices"), button:has-text("Accept All"), #onetrust-accept-btn-handler, button#onetrust-pc-btn-handler');
      await acceptButton.click({ timeout: 10000 });
      await page.waitForTimeout(2000);
      console.log("Cookie consent accepted");
      return true;
    }
  } catch (err) {
    console.log("No cookie consent banner found (already accepted or not present)");
  }
  return false;
}

// Wait for __INITIAL_STATE__ via postMessage (like your inject.js)
async function waitForInitialState(page, timeout = 30000) {
  return await page.evaluate(async (timeout) => {
    return new Promise((resolve) => {
      const handler = (event) => {
        if (event.source !== window) return;
        if (event.data.type === 'MACYS_INITIAL_STATE') {
          window.removeEventListener('message', handler);
          try {
            resolve(JSON.parse(event.data.data));
          } catch {
            resolve(null);
          }
        }
      };
      window.addEventListener('message', handler);

      // Inject your inject.js logic
      (function () {
        try {
          const safeData = JSON.stringify(window.__INITIAL_STATE__);
          window.postMessage({
            type: 'MACYS_INITIAL_STATE',
            data: safeData
          }, '*');
        } catch (err) {
          console.error('inject.js failed:', err);
        }
      })();

      setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve(null);
      }, timeout);
    });
  }, timeout);
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
    apiUrl.searchParams.set("wait", "15000");

    const browser = await chromium.launch({
      headless: true,
      ignoreHTTPSErrors: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    let context, page, traceName, shotName, htmlName;

    try {
      context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport: { width: 1366, height: 768 },
        locale: "en-US",
        timezoneId: "America/New_York",
      });

      await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        window.chrome = { runtime: {} };
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
      page.setDefaultNavigationTimeout(180000);

      // === 1. Load page via ScraperAPI ===
      console.log("Loading via ScraperAPI...");
      await page.goto(apiUrl.toString(), { waitUntil: "networkidle", timeout: 120000 });

      // === 2. Auto-accept cookie consent ===
      await acceptCookieConsent(page);

      // === 3. Wait for product content ===
      console.log("Waiting for product data...");
      await page.waitForSelector('#productMktData, [data-auto="product-title"], h1.pdp-title', { timeout: 60000 });

      // === 4. Replicate your extension logic ===
      const initialState = await waitForInitialState(page, 30000);
      const sizeMap = {};

      if (initialState) {
        const upcs = initialState?.pageData?.product?.product?.relationships?.upcs || {};
        Object.values(upcs).forEach(upcObj => {
          const sizeAttr = upcObj.attributes.find(a => a.name === 'SIZE');
          if (sizeAttr) {
            sizeMap[upcObj.identifier.upcNumber.toString()] = sizeAttr.value;
          }
        });
        console.log("Size map built from __INITIAL_STATE__", Object.keys(sizeMap).length, "entries");
      } else {
        console.warn("No __INITIAL_STATE__ found");
      }

      // Parse #productMktData (JSON-LD)
      let offers = [];
      try {
        const jsonText = await page.locator('#productMktData').textContent();
        const productData = JSON.parse(jsonText);
        offers = productData.offers || [];
        console.log("Offers loaded from JSON-LD:", offers.length);
      } catch (err) {
        console.warn("Failed to parse #productMktData:", err.message);
      }

      // === 5. Merge offers + size map ===
      const extractedData = offers.map(offer => {
        let size = 'N/A';
        const upc = (offer.SKU || '').replace('USA', '');

        // Try offer attributes first
        if (offer.itemOffered?.attributes) {
          const sizeAttr = offer.itemOffered.attributes.find(a =>
            a?.name?.toUpperCase() === 'SIZE'
          );
          if (sizeAttr?.value) size = sizeAttr.value.trim();
        }

        // Fallback to sizeMap
        if (size === 'N/A' && sizeMap[upc]) {
          size = sizeMap[upc];
        }

        return {
          sku: offer.SKU || 'N/A',
          upc,
          url,
          color: offer.itemOffered?.color || 'N/A',
          size,
          currentPrice: offer.price ? offer.price.toString() : 'N/A',
          regularPrice: offer.regularPrice || 'N/A',
          availability: (offer.availability || '').split('/').pop() || 'N/A'
        };
      });

      console.log("Final extracted rows:", extractedData.length);

      // === 6. Output ===
      const headers = ["sku", "upc", "url", "color", "size", "currentPrice", "regularPrice", "availability"];
      const rows = extractedData.length > 0
        ? extractedData.map(d => [d.sku, d.upc, d.url, d.color, d.size, d.currentPrice, d.regularPrice, d.availability])
        : [["N/A", "N/A", url, "N/A", "N/A", "N/A", "N/A", "N/A"]];

      // === 7. Debug artifacts ===
      if (debug) {
        const okPng = `${stamp("ok")}.png`;
        const okHtml = `${stamp("ok")}.html`;
        await page.screenshot({ path: path.join(DEBUG_DIR, okPng), fullPage: true });
        await fs.writeFile(path.join(DEBUG_DIR, okHtml), await page.content(), "utf8");
        console.log("Debug saved: screenshot + HTML");
      }

      if (traceName) {
        await context.tracing.stop({ path: path.join(DEBUG_DIR, traceName) });
      }

      return {
        rawTables: [{ headers, rows }],
        debug: { trace: traceName ? toDebugUrl(traceName) : null },
        _debug: { initialState: !!initialState, offersCount: offers.length, sizeMapCount: Object.keys(sizeMap).length }
      };

    } catch (err) {
      // === 8. Always capture error debug ===
      if (context && page) {
        shotName = `${stamp("error")}.png`;
        htmlName = `${stamp("error")}.html`;
        await page.screenshot({ path: path.join(DEBUG_DIR, shotName), fullPage: true }).catch(() => {});
        await fs.writeFile(path.join(DEBUG_DIR, htmlName), await page.content(), "utf8").catch(() => {});
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

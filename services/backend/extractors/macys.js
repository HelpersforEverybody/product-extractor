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

async function acceptCookieConsent(page) {
  try {
    console.log("Waiting for OneTrust banner...");
    const frame = page.frames().find(f => f.url().includes("onetrust"));
    if (!frame) return false;

    const button = frame.locator('button:has-text("Confirm My Choices"), #onetrust-accept-btn-handler');
    if (await button.isVisible({ timeout: 15000 })) {
      await button.click();
      await page.waitForTimeout(3000);
      console.log("Cookie consent accepted");
      return true;
    }
  } catch (e) {
    console.log("No banner or already accepted");
  }
  return false;
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
    apiUrl.searchParams.set("wait", "45000");
    apiUrl.searchParams.set("session_number", "macys1");

    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    let context, page, traceName, shotName, htmlName;

    try {
      context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        viewport: { width: 1366, height: 768 },
        locale: "en-US",
      });

      await context.addCookies([
        { name: "shippingCountry", value: "US", domain: ".macys.com", path: "/" },
        { name: "macys_onlineZipCode", value: "10001", domain: ".macys.com", path: "/" },
      ]);

      await context.route("**/*.{png,jpg,jpeg,css,woff2}", r => r.abort());

      if (process.env.PW_TRACE === "1") {
        traceName = `${stamp("trace")}.zip`;
        await context.tracing.start({ screenshots: true, snapshots: true });
      }

      page = await context.newPage();
      page.setDefaultNavigationTimeout(180000);

      console.log("Loading via ScraperAPI...");
      await page.goto(apiUrl.toString(), { waitUntil: "networkidle", timeout: 180000 });

      // === AUTO-CLICK COOKIE BANNER ===
      await acceptCookieConsent(page);

      // === WAIT FOR __INITIAL_STATE__ ===
      console.log("Waiting for __INITIAL_STATE__...");
      await page.waitForFunction(
        () => window.__INITIAL_STATE__ && window.__INITIAL_STATE__.pageData?.product?.product,
        { timeout: 90000 }
      );
      console.log("Found __INITIAL_STATE__");

      const state = await page.evaluate(() => window.__INITIAL_STATE__);
      const product = state.pageData?.product?.product;
      if (!product) throw new Error("No product data");

      const upcs = product.relationships?.upcs || {};
      const offers = product.relationships?.offers || {};
      const sizeMap = {};

      Object.values(upcs).forEach(u => {
        const size = u.attributes?.find(a => a.name === 'SIZE')?.value;
        if (size && u.identifier?.upcNumber) {
          sizeMap[u.identifier.upcNumber.toString()] = size;
        }
      });

      const rows = Object.values(offers).map(offer => {
        const sku = offer.identifier?.sku || 'N/A';
        const upc = sku.replace('USA', '');
        let size = 'N/A';
        let color = 'N/A';

        if (offer.attributes) {
          const sizeAttr = offer.attributes.find(a => a.name?.toUpperCase() === 'SIZE');
          const colorAttr = offer.attributes.find(a => a.name?.toUpperCase() === 'COLOR');
          if (sizeAttr?.value) size = sizeAttr.value;
          if (colorAttr?.value) color = colorAttr.value;
        }

        if (size === 'N/A' && sizeMap[upc]) size = sizeMap[upc];

        return [
          sku,
          upc,
          url,
          color,
          size,
          offer.price?.toString() || 'N/A',
          offer.regularPrice || 'N/A',
          (offer.availability || '').split('/').pop() || 'N/A'
        ];
      });

      const headers = ["sku", "upc", "url", "color", "size", "currentPrice", "regularPrice", "availability"];

      if (debug) {
        const png = `${stamp("ok")}.png`;
        await page.screenshot({ path: path.join(DEBUG_DIR, png), fullPage: true });
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

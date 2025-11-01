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
    const btn = page.locator('button:has-text("Confirm My Choices"), #onetrust-accept-btn-handler');
    if (await btn.isVisible({ timeout: 10000 })) {
      await btn.click();
      await page.waitForTimeout(2000);
    }
  } catch {}
}

async function waitForInitialState(page) {
  console.log("Waiting for __INITIAL_STATE__...");
  await page.waitForFunction(() => window.__INITIAL_STATE__ && window.__INITIAL_STATE__.pageData?.product, { timeout: 60000 });
  console.log("Found __INITIAL_STATE__");

  return await page.evaluate(() => {
    const state = window.__INITIAL_STATE__;
    const product = state.pageData?.product?.product;
    if (!product) return null;

    const upcs = product.relationships?.upcs || {};
    const offers = product.relationships?.offers || {};
    const sizeMap = {};

    // Build UPC → Size
    Object.values(upcs).forEach(u => {
      const size = u.attributes?.find(a => a.name === 'SIZE')?.value;
      if (size && u.identifier?.upcNumber) {
        sizeMap[u.identifier.upcNumber.toString()] = size;
      }
    });

    // Build offers
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

      return {
        sku,
        upc,
        url: window.location.href,
        color,
        size,
        currentPrice: offer.price?.toString() || 'N/A',
        regularPrice: offer.regularPrice || 'N/A',
        availability: offer.availability?.split('/').pop() || 'N/A'
      };
    });

    return rows.length > 0 ? rows : [{ sku: 'N/A', upc: 'N/A', url: window.location.href, color: 'N/A', size: 'N/A', currentPrice: 'N/A', regularPrice: 'N/A', availability: 'N/A' }];
  });
}

export default {
  id: "macys",
  match: { hostRegex: /(^|\.)macys\.com$/i },

  async extract({ url, debug = 0 }) {
    await ensureDebugDir();

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
        timezoneId: "America/New_York",
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
      page.setDefaultNavigationTimeout(90000);

      console.log("Loading:", url);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

      await acceptCookieConsent(page);

      const data = await waitForInitialState(page);

      const headers = ["sku", "upc", "url", "color", "size", "currentPrice", "regularPrice", "availability"];
      const rows = data.map(d => [d.sku, d.upc, d.url, d.color, d.size, d.currentPrice, d.regularPrice, d.availability]);

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

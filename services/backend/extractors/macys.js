import axios from "axios";
import * as cheerio from "cheerio";
import { chromium } from "playwright";

/**
 * Macy's extractor that mirrors your extension:
 * - Primary: JSON-LD offers (id=productMktData / any ld+json)
 * - SIZE mapping from window.__INITIAL_STATE__ (relationships.upcs[].attributes[name=SIZE])
 * - UPC = offer.SKU with "USA" removed (same as your code)
 * - availability = last segment of the URL ("InStock"/"OutOfStock")
 * - regularPrice: try to read from JSON-LD, else blank (do NOT hardcode)
 * - Returns 8 columns exactly like your popup expects
 */
export default {
  id: "macys",
  match: { hostRegex: /(^|\.)macys\.com$/i },

  async extract({ url }) {
    // 1) Try static HTML first (cheap)
    try {
      const html = await fetchHTML(url);
      const rows = await buildRowsFromHtml(html, url);
      if (rows.length) return rowsResponse(rows);
    } catch (_) {
      // ignore and fall back to Playwright
    }

    // 2) Fallback: render with Playwright to access window.__INITIAL_STATE__ reliably
    const { html, initialState } = await renderAndGrab(url);
    const rows = await buildRowsFromHtml(html, url, initialState);
    return rowsResponse(rows);
  }
};

// ---------- helpers ----------
function rowsResponse(rows) {
  return {
    siteId: "macys",
    rawTables: [{
      headers: ["sku","upc","url","color","size","currentPrice","regularPrice","availability"],
      rows
    }],
    meta: { count: rows.length }
  };
}

async function fetchHTML(url) {
  const resp = await axios.get(url, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache"
    },
    timeout: 25000,
    validateStatus: () => true
  });
  if (resp.status < 200 || resp.status >= 300) {
    const err = new Error(`HTTP ${resp.status} while fetching Macy's page`);
    err.statusCode = resp.status;
    throw err;
  }
  return resp.data;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function renderAndGrab(url) {
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage({ userAgent: UA, locale: "en-US" });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
   // wait for Macy's initial state to load
await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});

// Macy's loads UPC/size in __INITIAL_STATE__ asynchronously
try {
  await page.waitForFunction(
    () => window.__INITIAL_STATE__ &&
          window.__INITIAL_STATE__.pageData?.product?.product?.relationships?.upcs?.length > 0,
    { timeout: 6000 }
  );
} catch {}

// small buffer delay like extension
await page.waitForTimeout(800);

    const result = await page.evaluate(() => {
      const state = (window).__INITIAL_STATE__ || null;
      const html = document.documentElement.outerHTML;
      return { html, state };
    });
    return { html: result.html, initialState: result.state };
  } finally {
    await browser.close();
  }
}

function parseOffersFromJsonLd(html) {
  const $ = cheerio.load(html || "");
  const blocks = [];
  // Prefer specific id (your extension) if present
  const special = $("#productMktData").html();
  if (special) {
    try { blocks.push(JSON.parse(special.trim())); } catch {}
  }
  // Also take all ld+json as fallback
  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).html() || "";
    try { blocks.push(JSON.parse(txt.trim())); } catch {}
  });

  // Flatten, pick Product with offers
  const all = blocks.flatMap(x => Array.isArray(x) ? x : [x]).filter(Boolean);
  const offers = [];
  let regularPriceHint = ""; // if JSON-LD exposes a reference/regular price

  for (const item of all) {
    const type = String(item?.['@type'] || item?.type || "").toLowerCase();
    if (!type.includes("product")) continue;

    const rawOffers = Array.isArray(item.offers) ? item.offers : (item.offers ? [item.offers] : []);
    for (const off of rawOffers) {
      const sku = off?.sku || off?.skuId || off?.itemOffered?.sku || off?.mpn || "";
      const color = off?.itemOffered?.color || "";
      const price =
        off?.price ??
        off?.priceSpecification?.price ??
        "";
      // best-effort reference price
      const rp =
        off?.priceSpecification?.referencePrice ??
        off?.priceSpecification?.priceCurrencyBeforeDiscount ??
        off?.priceSpecification?.priceBeforeDiscount ??
        "";
      if (rp) regularPriceHint = rp;
      const availability = String(off?.availability || "").split("/").pop() || "";

      offers.push({ sku, color, price: toMoney(price), availability, regularPriceHint });
    }
  }
  return offers;
}

function getSizeMapFromInitialState(state) {
  // You said your extension reads:
  // initialState.pageData.product.product.relationships.upcs[].attributes (name === 'SIZE') → value, key by identifier.upcNumber
  const map = {};
  try {
    const upcs =
      state?.pageData?.product?.product?.relationships?.upcs ||
      state?.product?.relationships?.upcs ||
      [];
    for (const u of upcs) {
      const upc = u?.identifier?.upcNumber || u?.identifier?.upc || u?.upc || "";
      const attrs = u?.attributes || [];
      const sizeAttr = attrs.find(a => (a?.name || "").toUpperCase() === "SIZE");
      const size = sizeAttr?.value || "";
      if (upc) map[upc.replace(/\D+/g, "")] = size; // numeric string key
    }
  } catch {}
  return map;
}

async function buildRowsFromHtml(html, url, initialState = null) {
  const offers = parseOffersFromJsonLd(html);
  let sizeMap = {};
  if (!initialState) {
    // try to extract __INITIAL_STATE__ via regex if not passed in
    const m = html?.match(/__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*;?\s*<\/script>/i);
    if (m) {
      try { initialState = JSON.parse(m[1]); } catch {}
    }
  }
  if (initialState) sizeMap = getSizeMapFromInitialState(initialState);

  const rows = [];
  for (const off of offers) {
    const skuRaw = String(off.sku || "").trim();
    const upc = skuRaw.replace(/USA/gi, "").replace(/\D+/g, ""); // your extension cleans UPC removing "USA"
    const color = off.color || "";
    // SIZE priority: offer.itemOffered.attributes[name=SIZE] first — JSON-LD rarely has it, so fallback to sizeMap
    const size = sizeMap[upc] || ""; // same fallback as your code
    const currentPrice = off.price || "";
    const regularPrice = toMoney(off.regularPriceHint || ""); // leave blank if unknown
    const availability = off.availability || ""; // already last segment in parse

    rows.push([
      skuRaw || "",         // sku
      upc || "",            // upc (cleaned)
      url,                  // url
      color || "",          // color
      size || "",           // size
      currentPrice || "",   // currentPrice
      regularPrice || "",   // regularPrice
      availability || ""    // availability
    ]);
  }
  return rows;
}

function toMoney(x) {
  if (x == null) return "";
  const s = String(x).trim();
  if (!s) return "";
  // If it already looks like $12.34 keep it, else prefix $
  if (/^\$/.test(s)) return s;
  return `$${s}`;
}

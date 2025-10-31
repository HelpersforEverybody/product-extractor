import axios from "axios";
import * as cheerio from "cheerio";
import { chromium } from "playwright";

export default {
  id: "macys",
  match: { hostRegex: /(^|\.)macys\.com$/i },

  async extract({ url, fields = ["sku","price","color","size"] }) {
    // 1) Try static HTML fetch first
    try {
      const html = await fetchHTML(url);
      const data = pickRicher(parseInitialState(html), parseJsonLd(html));
      const { headers, rows } = buildRows(data);
      if (rows.length) {
        return {
          siteId: "macys",
          rawTables: [{ headers, rows }],
          meta: { title: data.title || "", price: data.price || "", currency: data.currency || "USD", url }
        };
      }
    } catch (e) {
      // if 403 etc., we’ll fall back
      if (!isHttp403(e)) throw e;
    }

    // 2) Fallback: render with Playwright (real Chromium)
    const html2 = await renderWithPlaywright(url);
    const data2 = pickRicher(parseInitialState(html2), parseJsonLd(html2));
    const { headers, rows } = buildRows(data2);

    return {
      siteId: "macys",
      rawTables: [{ headers, rows }],
      meta: { title: data2.title || "", price: data2.price || "", currency: data2.currency || "USD", url }
    };
  }
};

// ---------- helpers ----------

async function fetchHTML(url) {
  const resp = await axios.get(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache"
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

function isHttp403(e) {
  const s = e?.statusCode || e?.status || 0;
  return String(s) === "403";
}

async function renderWithPlaywright(url) {
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const page = await browser.newPage({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "en-US"
  });
  try {
    await page.goto(url, { waitUntil: "load", timeout: 40000 });
    // try to wait until product JSON is present (tunable)
    await page.waitForTimeout(1500);
    const html = await page.content();
    return html;
  } finally {
    await browser.close();
  }
}

function parseJsonLd(html) {
  const $ = cheerio.load(html);
  const blocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).html() || "";
    try { blocks.push(JSON.parse(txt.trim())); } catch {}
  });

  let title = "", price = "", currency = "USD", variants = [];
  for (const b of (Array.isArray(blocks) ? blocks : [blocks])) {
    const arr = Array.isArray(b) ? b : [b];
    for (const item of arr) {
      const type = String(item?.['@type'] || item?.type || "").toLowerCase();
      if (!type.includes("product")) continue;
      title = item.name || title;
      const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
      if (offers) {
        price = offers.price || price || offers?.priceSpecification?.price || "";
        currency = offers.priceCurrency || offers.priceCurrencyCode || currency;
      }
      const sku = item.sku || item.mpn || "";
      if (sku || item.color || item.size) {
        variants.push({ sku, color: item.color || "", size: item.size || "", price: price || "" });
      }
    }
  }
  return { title, price, currency, variants };
}

function parseInitialState(html) {
  // strict match or scan blocks
  let m = html.match(/__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*;?\s*<\/script>/i);
  if (!m) {
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(x => x[1] || "");
    for (const s of scripts) {
      if (s.includes("__INITIAL_STATE__")) {
        const json = extractBalancedObject(s, s.indexOf("__INITIAL_STATE__"));
        if (json) { m = [null, json]; break; }
      }
    }
  }
  if (!m) return {};
  let obj = {};
  try { obj = JSON.parse(m[1]); } catch {}

  let title = "", price = "", currency = "USD", variants = [];
  try {
    const p = obj?.product || obj?.pdp || obj?.entities?.product || {};
    title = p.name || p.title || title;
    price = p.price?.sale ?? p.price?.min ?? p.offerPrice ?? p.price ?? price;
    currency = p.currency || currency;

    const skus = p.skus || p.variants || p.skuList || [];
    variants = (Array.isArray(skus) ? skus : []).map(s => ({
      sku: s.sku || s.id || s.upc || "",
      color: s.color || s.colorName || s.variantColor || "",
      size: s.size || s.sizeName || s.variantSize || "",
      price: s.price?.sale ?? s.price ?? price
    }));
  } catch {}
  return { title, price, currency, variants };
}

function extractBalancedObject(scriptText, startIdx) {
  const braceStart = scriptText.indexOf("{", startIdx);
  if (braceStart < 0) return null;
  let depth = 0;
  for (let i = braceStart; i < scriptText.length; i++) {
    const ch = scriptText[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return scriptText.slice(braceStart, i + 1);
    }
  }
  return null;
}

function pickRicher(a, b) {
  const ac = (a?.variants || []).length;
  const bc = (b?.variants || []).length;
  return ac >= bc ? a : b;
}

function buildRows(data) {
  const headers = ["Color","Size","SKU","Price"];
  const rows = (data?.variants || []).map(v => ([
    v.color || "",
    v.size || "",
    v.sku || "",
    (v.price ?? data.price ?? "").toString().trim()
  ])).filter(r => r.some(x => String(x).trim() !== ""));
  if (!rows.length) rows.push(["", "", "", (data.price ?? "").toString().trim()]);
  return { headers, rows };
}

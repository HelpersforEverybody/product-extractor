import axios from "axios";
import * as cheerio from "cheerio";
import { chromium } from "playwright";

/**
 * Macy's extractor:
 * 1) Try static HTML (cheap).
 * 2) If no variants or 4xx/empty -> Playwright and read window.__INITIAL_STATE__.
 * 3) Fallback to JSON-LD if needed.
 */
export default {
  id: "macys",
  match: { hostRegex: /(^|\.)macys\.com$/i },

  async extract({ url, fields = ["sku","price","color","size"] }) {
    // --- 1) Static HTML fetch ---
    try {
      const html = await fetchHTML(url);
      const staticData = preferRicher(parseInitialStateFromHTML(html), parseJsonLd(html));
      const { headers, rows } = buildRows(staticData);
      if (rows.length) {
        return ok(staticData, headers, rows, url);
      }
    } catch (_) {
      // ignore and go to Playwright
    }

    // --- 2) Playwright (browser render) ---
    const rendered = await renderAndGrab(url);
    const pwData = preferRicher(
      parseInitialStateObject(rendered.initialState),
      parseJsonLd(rendered.html)
    );
    const pwBuilt = buildRows(pwData);
    if (pwBuilt.rows.length) {
      return ok(pwData, pwBuilt.headers, pwBuilt.rows, url);
    }

    // --- 3) Last-ditch: try to read variant elements from DOM ---
    const domGuessed = parseFromDOM(rendered.html);
    const guessedBuilt = buildRows(domGuessed);
    return ok(domGuessed, guessedBuilt.headers, guessedBuilt.rows, url);
  }
};

// ---------- Helpers ----------
function ok(data, headers, rows, url) {
  return {
    siteId: "macys",
    rawTables: [{ headers, rows }],
    meta: {
      title: data.title || "",
      price: data.price || "",
      currency: data.currency || "USD",
      url
    }
  };
}

async function fetchHTML(url) {
  const resp = await axios.get(url, {
    headers: {
      "User-Agent": ua(),
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

function ua() {
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
}

// ===== JSON-LD from HTML =====
function parseJsonLd(html) {
  const $ = cheerio.load(html || "");
  const blocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).html() || "";
    try { blocks.push(JSON.parse(txt.trim())); } catch {}
  });

  let title = "", price = "", currency = "USD", variants = [];
  const all = blocks.flatMap(x => Array.isArray(x) ? x : [x]);
  for (const item of all) {
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
  return { title, price, currency, variants };
}

// ===== __INITIAL_STATE__ from HTML (regex) =====
function parseInitialStateFromHTML(html) {
  let m = html?.match(/__INITIAL_STATE__\s*=\s*({[\s\S]*?})\s*;?\s*<\/script>/i);
  if (!m) return {};
  try {
    const obj = JSON.parse(m[1]);
    return parseInitialStateObject(obj);
  } catch { return {}; }
}

// ===== Parse product object from initial state (object) =====
function parseInitialStateObject(obj) {
  if (!obj) return {};
  let title = "", price = "", currency = "USD", variants = [];

  try {
    // try typical locations
    const p =
      obj?.product ||
      obj?.pdp ||
      obj?.entities?.product ||
      obj?.entities?.products ||
      obj?.page?.product ||
      {};

    title = p.name || p.title || obj?.page?.title || title;

    price =
      p.price?.sale ??
      p.price?.min ??
      p.offerPrice ??
      p.price ??
      price;

    currency = p.currency || currency;

    // try SKU/variants arrays in various shapes
    const skus =
      p.skus ||
      p.variants ||
      p.skuList ||
      p.items ||
      obj?.entities?.skus ||
      [];

    variants = (Array.isArray(skus) ? skus : Object.values(skus)).map(s => ({
      sku: s.sku || s.id || s.upc || s.partNumber || "",
      color: s.color || s.colorName || s.variantColor || s.attributeColor || "",
      size: s.size || s.sizeName || s.variantSize || s.attributeSize || "",
      price: s.price?.sale ?? s.price ?? price
    }));
  } catch {}

  return { title, price, currency, variants };
}

// ===== Playwright: render + read window.__INITIAL_STATE__ directly =====
async function renderAndGrab(url) {
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage({ userAgent: ua(), locale: "en-US" });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    // give client scripts a moment to populate window state
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(800);

    const result = await page.evaluate(() => {
      const state = (window).__INITIAL_STATE__ || (window).initialState || null;
      // capture JSON-LD quickly too
      const ld = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
        .map(s => s.textContent)
        .filter(Boolean);
      return { state, ldCount: ld.length, html: document.documentElement.outerHTML };
    });

    return { initialState: result.state, html: result.html };
  } finally {
    await browser.close();
  }
}

// ===== very soft DOM guess (if everything else fails) =====
function parseFromDOM(html) {
  const $ = cheerio.load(html || "");
  let title = $("h1, [data-el='product-title']").first().text().trim();
  let price = $("[data-el='price'], .price, [itemprop='price']").first().text().trim();
  const rows = [];
  // try variant tables
  $("[data-el='size'], [data-el='color']").each((_i, el) => {
    const t = $(el).text().trim();
    if (t) rows.push(["", "", "", t]);
  });
  return { title, price, currency: "USD", variants: rows.map(r => ({ color: r[0], size: r[1], sku: r[2], price: r[3] })) };
}

// ===== Build rows =====
function buildRows(data) {
  const headers = ["SKU", "PRICE", "COLOR", "SIZE"];
  const rows = (data?.variants || []).map(v => ([
    v.sku || "",
    toPrice(v.price ?? data.price ?? ""),
    v.color || "",
    v.size || ""
  ])).filter(r => r.some(x => String(x).trim() !== ""));

  if (!rows.length) {
    const one = toPrice(data?.price ?? "");
    if (one) rows.push(["", one, "", ""]);
  }
  return { headers, rows };
}

function toPrice(x) {
  if (x == null) return "";
  const s = String(x).trim();
  if (!s) return "";
  if (/^\$/.test(s)) return s;
  return s ? `$${s}` : "";
}

function preferRicher(a, b) {
  const ac = (a?.variants || []).length;
  const bc = (b?.variants || []).length;
  if (ac && bc) return ac >= bc ? a : b;
  return ac ? a : (bc ? b : (a || b || {}));
}

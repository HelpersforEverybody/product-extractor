import axios from "axios";
import * as cheerio from "cheerio";

/**
 * Macy's server extractor (HTML fetch, no headless)
 * It tries, in order:
 * 1) JSON-LD blocks (application/ld+json)
 * 2) window.__INITIAL_STATE__ (regex from inline <script>)
 * Then it builds a raw table: headers + rows.
 */
export default {
  id: "macys",
  match: { hostRegex: /(^|\.)macys\.com$/i },

  async extract({ url, fields = ["sku","price","color","size"] }) {
    const html = await fetchHTML(url);

    const fromJsonLd = parseJsonLd(html);
    const fromState  = parseInitialState(html);

    // Prefer state if it has variants; otherwise fall back to JSON-LD
    const data = pickRicher(fromState, fromJsonLd);

    const { headers, rows } = buildRows(data);

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
};

// ---------- helpers ----------
async function fetchHTML(url) {
  const resp = await axios.get(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "Accept-Language": "en-US,en;q=0.9"
    },
    timeout: 20000
  });
  return resp.data;
}

function parseJsonLd(html) {
  const $ = cheerio.load(html);
  const blocks = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).html() || "";
    try {
      const j = JSON.parse(txt.trim());
      blocks.push(j);
    } catch {}
  });

  // Try to find Product schema with offers/variants
  let title = "", price = "", currency = "", variants = [];
  for (const b of blocks) {
    const arr = Array.isArray(b) ? b : [b];
    for (const item of arr) {
      const type = item['@type'] || item.type;
      if (!type) continue;
      if (String(type).toLowerCase().includes('product')) {
        title = item.name || title;
        const offers = Array.isArray(item.offers) ? item.offers[0] : item.offers;
        if (offers) {
          price = offers.price || price || (offers.priceSpecification && offers.priceSpecification.price) || "";
          currency = offers.priceCurrency || offers.priceCurrencyCode || "USD";
        }
        // Sometimes color/size exist in additionalProperty or variant part numbers
        if (item.color || item.size) {
          variants.push({
            sku: item.sku || item.mpn || "",
            color: item.color || "",
            size: item.size || "",
            price: price
          });
        }
      }
    }
  }
  return { title, price, currency, variants };
}

function parseInitialState(html) {
  // Look for window.__INITIAL_STATE__ = {...};
  const m = html.match(/__INITIAL_STATE__\s*=\s*({[\s\S]*?});\s*<\/script>/i);
  if (!m) return {};
  let obj = {};
  try {
    // Macy’s often has JSON with unescaped </script> ending; the regex above stops before tag close.
    obj = JSON.parse(m[1]);
  } catch {
    // Try a looser parse if needed
    try {
      const cleaned = m[1].replace(/,\s*undefined/g, "");
      obj = JSON.parse(cleaned);
    } catch {}
  }
  // Best-effort dive into product/variants; adjust keys if structure differs
  let title = "", price = "", currency = "USD", variants = [];
  try {
    const p = obj?.product || obj?.pdp || obj?.entities?.product || {};
    title = p.name || p.title || title;
    price = p.price?.sale || p.price?.min || p.offerPrice || p.price || price;
    currency = p.currency || currency;

    // variants may live under SKUs matrix / attributes arrays
    const skus = p.skus || p.variants || p.skuList || [];
    variants = skus.map(s => ({
      sku: s.sku || s.id || s.upc || "",
      color: s.color || s.colorName || s.variantColor || "",
      size: s.size || s.sizeName || s.variantSize || "",
      price: s.price?.sale ?? s.price ?? price
    }));
  } catch {}
  return { title, price, currency, variants };
}

function pickRicher(a, b) {
  const ac = (a?.variants || []).length;
  const bc = (b?.variants || []).length;
  if (ac >= bc) return a;
  return b;
}

function buildRows(data) {
  const headers = ["SKU","Price","Color","Size"];
  const rows = (data?.variants || []).map(v => ([
    v.sku || "",
    String(v.price ?? data.price ?? "").trim(),
    v.color || "",
    v.size || ""
  ])).filter(r => r.some(x => String(x).trim() !== ""));
  // If no variants, still return one row from meta
  if (!rows.length) {
    rows.push([
      "", String(data.price ?? "").trim(), "", ""
    ]);
  }
  return { headers, rows };
}

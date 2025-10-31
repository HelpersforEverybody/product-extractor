import { chromium } from "playwright";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

function buildProxy() {
  if (!process.env.PROXY_SERVER) return undefined;
  return {
    server: process.env.PROXY_SERVER,
    username: process.env.PROXY_USERNAME || undefined,
    password: process.env.PROXY_PASSWORD || undefined,
  };
}

async function ensurePage(ctx) {
  // Use injected page if provided, else create a new one via helper/newPage
  if (ctx?.page) return { page: ctx.page, owned: false };

  if (ctx?.newPage) {
    const p = await ctx.newPage();
    return { page: p, owned: true };
  }

  // Last resort: launch our own browser context (rarely used if route passes page/newPage)
  const browser = await chromium.launch({
    headless: process.env.PLAYWRIGHT_HEADLESS !== "false",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    proxy: buildProxy(),
  });

  const context = await browser.newContext({
    userAgent: UA,
    locale: "en-US",
    timezoneId: "America/New_York",
    viewport: { width: 1366, height: 768 },
  });
  await context.setExtraHTTPHeaders({
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Upgrade-Insecure-Requests": "1",
  });
  const page = await context.newPage();
  return { page, owned: true, browser, context };
}

// Helpers
function stripNonDigits(x = "") {
  return String(x).replace(/\D+/g, "");
}
function availabilityFromUrl(u = "") {
  // matches your extension's logic (last segment after '/')
  try {
    const seg = new URL(u).pathname.split("/").filter(Boolean);
    return seg[seg.length - 1] || "";
  } catch {
    return "";
  }
}

async function extractFromInitialState(page) {
  return await page.evaluate(() => {
    const state = window.__INITIAL_STATE__ || window.__NUXT__?.state;
    if (!state?.pageData?.product?.product) return null;

    const prod = state.pageData.product.product;
    const relUpcs = prod?.relationships?.upcs || [];
    const attrs = prod?.attributes || {};
    const color = attrs?.color || attrs?.COLOR || null;

    // try price from state (fall back to nulls)
    const pricing = prod?.pricing || {};
    const currentPrice = pricing?.price?.current || null;
    const regularPrice = pricing?.price?.regular || null;

    // some pages store URLs in product URLs list; else use location
    const pageUrl = location.href;

    const rows = relUpcs.map((u) => {
      const upc = u?.attributes?.upc || u?.upc || null;
      const size =
        u?.attributes?.size || u?.size || u?.attributes?.SIZE || null;
      const sku = u?.id || u?.attributes?.sku || null;

      return {
        sku,
        upc,
        url: pageUrl,
        color: color || null,
        size: size || null,
        currentPrice,
        regularPrice,
        availability: "", // set later from URL
      };
    });

    return rows;
  });
}

async function extractFromJsonLd(page) {
  return await page.evaluate(() => {
    function parseScripts() {
      const scripts = Array.from(
        document.querySelectorAll('script[type="application/ld+json"]')
      );
      const products = [];
      for (const s of scripts) {
        try {
          const obj = JSON.parse(s.textContent || "{}");
          if (!obj) continue;
          const arr = Array.isArray(obj) ? obj : [obj];
          for (const item of arr) {
            if (
              item["@type"] === "Product" ||
              (Array.isArray(item["@type"]) && item["@type"].includes("Product"))
            ) {
              products.push(item);
            }
          }
        } catch {}
      }
      return products;
    }

    const prods = parseScripts();
    if (!prods.length) return null;

    const pageUrl = location.href;
    const rows = [];

    for (const p of prods) {
      const color = p.color || (p?.additionalProperty?.find?.(x => x.name === "color")?.value) || null;
      const offers = Array.isArray(p.offers) ? p.offers : (p.offers ? [p.offers] : []);
      for (const ofr of offers) {
        const sku = ofr.sku || p.sku || null;
        const upc = ofr.gtin13 || ofr.gtin12 || ofr.gtin || p.gtin13 || p.gtin || null;
        const size =
          ofr.size ||
          (p?.additionalProperty?.find?.(x => x.name?.toLowerCase() === "size")?.value) ||
          null;
        const currentPrice =
          ofr.price || ofr.priceSpecification?.price || p?.offers?.price || null;
        const regularPrice =
          ofr.priceSpecification?.referencePrice ||
          p?.offers?.highPrice ||
          null;

        rows.push({
          sku,
          upc,
          url: pageUrl,
          color: color || null,
          size: size || null,
          currentPrice,
          regularPrice,
          availability: "", // set later from URL
        });
      }
    }
    return rows.length ? rows : null;
  });
}

async function normalizeAndFill(rows = []) {
  return rows
    .filter(r => r && (r.sku || r.upc))
    .map(r => {
      const upc = stripNonDigits(r.upc || "");
      const availability = availabilityFromUrl(r.url || "");
      return {
        sku: r.sku || "",
        upc,
        url: r.url || "",
        color: r.color || "",
        size: r.size || "",
        currentPrice: r.currentPrice ?? "",
        regularPrice: r.regularPrice ?? "",
        availability,
      };
    });
}

export default {
  id: "macys",
  match: {
    hostRegex: /(^|\.)macys\.com$/i,
  },

  /**
   * extract({ url, page?, newPage?, debug? })
   * - If a page is provided we reuse it.
   * - Else we open a new one (with ScraperAPI proxy) to bypass WAF.
   */
  async extract({ url, page: injectedPage, newPage, debug }) {
    let owned = false;
    let browser, context;
    const { page, owned: ownedFlag, browser: b, context: c } =
      await ensurePage({ page: injectedPage, newPage });
    owned = ownedFlag;
    browser = b;
    context = c;

    try {
      if (!injectedPage) {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

      }

      // Wait for Macy's React state (upcs) to populate
      try {
        await page.waitForFunction(
          () =>
            window.__INITIAL_STATE__ &&
            window.__INITIAL_STATE__.pageData?.product?.product?.relationships?.upcs?.length > 0,
          { timeout: 9000 }
        );
      } catch {}

      // Slight buffer for hydration
      await page.waitForTimeout(700).catch(() => {});

      let rows = (await extractFromInitialState(page)) || null;

      if (!rows || !rows.length) {
        // fallback to JSON-LD
        rows = (await extractFromJsonLd(page)) || [];
      }

      // Normalize and fill availability
      const finalRows = await normalizeAndFill(rows);

      // Return in your rawTables format
      return {
        rawTables: [
          {
            headers: [
              "sku",
              "upc",
              "url",
              "color",
              "size",
              "currentPrice",
              "regularPrice",
              "availability",
            ],
            rows: finalRows,
          },
        ],
      };
    } finally {
      // close only if we created the page here
      try {
        if (owned) {
          const ctx = page.context();
          const br = ctx?.browser?.();
          await ctx?.close?.();
          await br?.close?.();
        }
      } catch {}
    }
  },
};

import { Router } from "express";
import { chooseExtractor } from "../extractors/index.js";

const router = Router();

/**
 * POST /api/extract
 * { url: string, siteId?: "auto" | "macys" }
 * Returns: { headers, table } with 8 columns your popup expects.
 */
router.post("/extract", async (req, res) => {
  const startedAt = Date.now();
  try {
    const { url, siteId = "auto" } = req.body || {};
    if (!url) return res.status(400).json({ error: "Missing url" });

    const extractor = chooseExtractor(siteId, url);
    if (!extractor) return res.status(400).json({ error: "No extractor for this site" });

    const raw = await extractor.extract({ url });
    const tableObj = raw?.rawTables?.[0] || { headers: [], rows: [] };

    // enforce header order to match your popup (safety)
    const HEADERS = ["sku","upc","url","color","size","currentPrice","regularPrice","availability"];
    const rows = tableObj.rows || [];

    return res.json({
      status: "done",
      siteId: extractor.id,
      headers: HEADERS,
      table: rows,
      durationMs: Date.now() - startedAt
    });
  } catch (e) {
    console.error("EXTRACT ERROR:", e?.message || e);
    res.status(e?.statusCode || 500).json({
      error: "Server error",
      detail: { message: e?.message || "unknown" }
    });
  }
});

export default router;

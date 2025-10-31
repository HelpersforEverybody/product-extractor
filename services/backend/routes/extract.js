// services/backend/routes/extract.js
import { Router } from "express";
import { chooseExtractor } from "../extractors/index.js";

const router = Router();

router.post("/extract", async (req, res) => {
  const startedAt = Date.now();
  try {
    const { url, siteId = "auto", debug = 0 } = req.body || {};
    if (!url) return res.status(400).json({ error: "Missing url" });

    const extractor = chooseExtractor(siteId, url);
    if (!extractor) return res.status(400).json({ error: "No extractor for this site" });

    const raw = await extractor.extract({ url, debug });
    const tableObj = raw?.rawTables?.[0] || { headers: [], rows: [] };

    const HEADERS = ["sku","upc","url","color","size","currentPrice","regularPrice","availability"];
    const rows = tableObj.rows || [];

    return res.json({
      status: "done",
      siteId: extractor.id,
      headers: HEADERS,
      table: rows,
      durationMs: Date.now() - startedAt,
      debug: {
        screenshot: raw?.debug?.screenshot || null,
        html: raw?.debug?.html || null,
        trace: raw?.debug?.trace || null,
      },
    });
  } catch (e) {
    const payload = {
      error: "Server error",
      detail: {
        message: e?.detail?.message || e?.message || "unknown",
        screenshot: e?.detail?.screenshot || null,
        html: e?.detail?.html || null,
        trace: e?.detail?.trace || null,
      },
      durationMs: Date.now() - startedAt,
    };
    res.status(e?.statusCode || 500).json(payload);
  }
});

export default router;

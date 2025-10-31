import { Router } from "express";
import { mapToCanonical } from "../mapping/map.js";
import { chooseExtractor } from "../extractors/index.js";

const router = Router();

router.post("/extract", async (req, res) => {
  const startedAt = Date.now();
  try {
    const { url, siteId = "auto", fields = ["sku","price","color","size"] } = req.body || {};
    if (!url) return res.status(400).json({ error: "Missing url" });

    const extractor = chooseExtractor(siteId, url);
    if (!extractor) {
      return res.status(400).json({ error: "No extractor for this site", detail: { siteId, url } });
    }

    const raw = await extractor.extract({ url, fields });
    const first = raw?.rawTables?.[0] || { headers: [], rows: [] };
    const mapped = mapToCanonical(first, fields);

    return res.json({
      status: "done",
      durationMs: Date.now() - startedAt,
      siteId: extractor.id,
      requestedFields: fields,
      headers: mapped.headers,
      table: mapped.table,
      confidence: mapped.confidence,
      debug: { inputHeaders: first.headers, rowsIn: first.rows.length }
    });
  } catch (e) {
    console.error("EXTRACT ERROR:", e?.message || e, e?.stack || "");
    const status = e?.statusCode || e?.status || 500;
    return res.status(status).json({
      error: "Server error",
      detail: {
        message: e?.message || "unknown",
        code: e?.code || null,
        name: e?.name || null
      }
    });
  }
});

export default router;

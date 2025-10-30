import { Router } from "express";
import { mapToCanonical } from "../mapping/map.js";
import { chooseExtractor } from "../extractors/index.js";

const router = Router();

router.post("/extract", async (req, res) => {
  try {
    const { url, siteId = "auto", fields = ["sku","price","color","size"] } = req.body || {};
    if (!url) return res.status(400).json({ error: "Missing url" });

    const extractor = chooseExtractor(siteId, url);
    if (!extractor) return res.status(400).json({ error: "No extractor for this site" });

    // Run site extractor (HTML fetch + parse)
    const raw = await extractor.extract({ url, fields });

    // Map first raw table to canonical fields
    const first = raw.rawTables?.[0] || { headers: [], rows: [] };
    const mapped = mapToCanonical(first, fields);

    return res.json({
      status: "done",
      siteId: extractor.id,
      requestedFields: fields,
      headers: mapped.headers,
      table: mapped.table,
      confidence: mapped.confidence,
      debug: { inputHeaders: first.headers, rowsIn: first.rows.length }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error", detail: e.message });
  }
});

export default router;

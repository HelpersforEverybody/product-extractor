import { Router } from "express";
import { mapToCanonical } from "../mapping/map.js";

const router = Router();

/**
 * POST /api/extract
 * body: { url: string, siteId?: "auto" | "macys" | "...", fields?: ["sku","price","color","size"] }
 * For now returns a MOCKED table so your extension/website can integrate immediately.
 */
router.post("/extract", async (req, res) => {
  try {
    const { url, siteId = "auto", fields = ["sku","price","color","size"] } = req.body || {};
    if (!url) return res.status(400).json({ error: "Missing url" });

    // TODO: later -> run Playwright and the correct extractor module
    // MOCK raw table that looks like a typical site output:
    const rawTable = {
      headers: ["Color", "Size", "SKU", "Price"],
      rows: [
        ["Red", "M", "SKU123", "$19.99"],
        ["Blue", "L", "SKU124", "$21.99"]
      ]
    };

    const mapped = mapToCanonical(rawTable, fields);

    return res.json({
      status: "done",
      siteId,
      requestedFields: fields,
      table: mapped.table,            // [[sku,price,color,size], ...] in requested order
      headers: mapped.headers,        // headers in the same order as table columns
      confidence: mapped.confidence,  // rough confidence score 0..1
      debug: { inputHeaders: rawTable.headers }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;

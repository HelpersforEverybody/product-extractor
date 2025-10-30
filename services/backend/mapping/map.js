// Very simple mapping stub that aligns raw headers to canonical fields
// Canonical fields: sku, price, color, size
const SYNONYMS = {
  sku: ["sku", "product code", "style", "item id", "asin", "upc"],
  price: ["price", "mrp", "offer price", "sale price", "amount"],
  color: ["color", "colour", "shade"],
  size: ["size", "sizes", "dimension"]
};

function headerToField(h) {
  const norm = String(h || "").toLowerCase().trim();
  for (const [field, list] of Object.entries(SYNONYMS)) {
    if (norm === field) return field;
    if (list.some(s => norm.includes(s))) return field;
  }
  // simple heuristics
  if (/\$|₹|€/.test(norm)) return "price";
  return null;
}

export function mapToCanonical(rawTable, requested = ["sku","price","color","size"]) {
  const headers = rawTable.headers || [];
  const rows = rawTable.rows || [];
  const headerFields = headers.map(headerToField);

  // Build column index per requested field
  const colIndex = {};
  for (const f of requested) {
    const idx = headerFields.findIndex(x => x === f);
    colIndex[f] = idx; // -1 if not found
  }

  // Build output table in requested order
  const out = rows.map(r => {
    return requested.map(f => {
      const i = colIndex[f];
      return i >= 0 ? r[i] : "";
    });
  });

  // naive confidence score
  const hits = Object.values(colIndex).filter(i => i >= 0).length;
  const confidence = hits / requested.length;

  return {
    headers: requested,
    table: out,
    confidence
  };
}

// TEMP: call backend directly to avoid proxy edge-cases
export const API_BASE = "https://product-extractor-backend.onrender.com";

export async function extractViaServer({ url, siteId = "auto", fields }) {
  const resp = await fetch(`${API_BASE}/api/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, siteId, fields })
  });
  const text = await resp.text();               // <-- robust parse
  if (!resp.ok) throw new Error(`API ${resp.status}: ${text}`);
  try { return JSON.parse(text); } catch {
    throw new Error(`API ${resp.status}: empty/invalid JSON`);
  }
}

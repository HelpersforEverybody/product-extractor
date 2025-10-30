// Put your Render API base here:
export const API_BASE = "https://product-extractor.onrender.com";

export async function extractViaServer({ url, siteId = "auto", fields }) {
  const resp = await fetch(`${API_BASE}/api/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, siteId, fields })
  });
  if (!resp.ok) throw new Error(`API ${resp.status}`);
  return resp.json();
}

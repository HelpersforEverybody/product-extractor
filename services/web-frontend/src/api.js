// Instead of the absolute backend URL, use a relative path
export const API_BASE = ""; // same origin (frontend)
export async function extractViaServer({ url, siteId = "auto", fields }) {
  const resp = await fetch(`/api/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, siteId, fields })
  });
  if (!resp.ok) throw new Error(`API ${resp.status}`);
  return resp.json();
}

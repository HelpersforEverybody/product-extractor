import React, { useMemo, useState } from "react";
import { extractViaServer } from "./api.js";
import Papa from "papaparse";

const ALL_FIELDS = ["sku", "price", "color", "size"];

export default function App() {
  const [siteId, setSiteId] = useState("auto");
  const [url, setUrl] = useState("");
  const [fields, setFields] = useState(ALL_FIELDS);
  const [status, setStatus] = useState("");
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);

  const toggleField = (f) => {
    setFields((prev) => prev.includes(f) ? prev.filter(x => x !== f) : [...prev, f]);
  };

  const canSubmit = useMemo(() => url.trim().length > 8 && fields.length > 0, [url, fields]);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;

    setStatus("Contacting server...");
    setRows([]);
    try {
      const json = await extractViaServer({ url, siteId, fields });
      setHeaders(json.headers || fields);
      setRows(json.table || []);
      setStatus(`Done (confidence ${Math.round((json.confidence ?? 0) * 100)}%)`);
    } catch (err) {
      console.error(err);
      setStatus(`Error: ${err.message}`);
    }
  };

  const downloadCSV = () => {
    const csv = Papa.unparse({ fields: headers, data: rows });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "extracted.csv";
    a.click();
  };

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", margin: 24, maxWidth: 900 }}>
      <h1>Product Extractor</h1>
      <p style={{ color: "#666" }}>Paste a product URL, pick fields, and extract via server.</p>

      <form onSubmit={onSubmit} style={{ display: "grid", gap: 12, marginBottom: 16 }}>
        <label>
          Target website
          <select value={siteId} onChange={(e) => setSiteId(e.target.value)} style={{ marginLeft: 8 }}>
            <option value="auto">Auto-detect</option>
            <option value="macys">Macy's</option>
            {/* add more as you add extractors */}
          </select>
        </label>

        <label>
          Product URL
          <input
            type="url"
            placeholder="https://..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            style={{ width: "100%", padding: 8 }}
            required
          />
        </label>

        <fieldset style={{ border: "1px solid #ddd", padding: 8 }}>
          <legend>Fields</legend>
          {ALL_FIELDS.map((f) => (
            <label key={f} style={{ marginRight: 12 }}>
              <input type="checkbox" checked={fields.includes(f)} onChange={() => toggleField(f)} /> {f}
            </label>
          ))}
        </fieldset>

        <button type="submit" disabled={!canSubmit} style={{ padding: "8px 12px" }}>
          Extract via Server
        </button>
        <div style={{ fontSize: 12, color: "#666" }}>{status}</div>
      </form>

      {rows.length > 0 && (
        <>
          <div style={{ marginBottom: 8 }}>
            <button onClick={downloadCSV}>Download CSV</button>
          </div>
          <div style={{ overflowX: "auto", border: "1px solid #eee" }}>
            <table cellPadding="8">
              <thead>
                <tr>
                  {headers.map((h) => <th key={h}>{String(h).toUpperCase()}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    {r.map((c, j) => <td key={`${i}-${j}`}>{c ?? ""}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

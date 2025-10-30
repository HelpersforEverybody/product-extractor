// Function to save data to chrome.storage.local
function saveData(data) {
  chrome.storage.local.set({ lastExtractedData: data });
}

// Function to load data from chrome.storage.local
function loadData(callback) {
  chrome.storage.local.get(['lastExtractedData'], (result) => {
    callback(result.lastExtractedData || []);
  });
}
const SERVER_URL = "https://product-extractor.onrender.com";
document.getElementById('currentServer').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const tab = tabs[0];
    const body = {
      url: tab.url,
      siteId: "auto", // or "macys"
      fields: ["sku","price","color","size"]
    };
    try {
      const resp = await fetch(`${SERVER_URL}/api/extract`, {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify(body)
      });
      const json = await resp.json();
      const table = json.table || [];
      const headers = json.headers || ['sku','price','color','size'];

      // Render into your existing table
      const thead = document.querySelector('#dataTable thead tr');
      const tbody = document.querySelector('#dataTable tbody');
      thead.innerHTML = '';
      headers.forEach(h => {
        const th = document.createElement('th');
        th.textContent = h.toUpperCase();
        thead.appendChild(th);
      });
      tbody.innerHTML = '';
      table.forEach(row => {
        const tr = document.createElement('tr');
        row.forEach(val => {
          const td = document.createElement('td');
          td.textContent = val ?? 'N/A';
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });

      // Save so your existing restore logic works
      const mapped = table.map(r => ({
        sku: r[headers.indexOf('sku')] || 'N/A',
        upc: '', url: tab.url,
        color: r[headers.indexOf('color')] || 'N/A',
        size: r[headers.indexOf('size')] || 'N/A',
        currentPrice: r[headers.indexOf('price')] || 'N/A',
        regularPrice: '', availability: ''
      }));
      chrome.storage.local.set({ lastExtractedData: mapped });

    } catch (e) {
      alert('Server extraction failed');
      console.error(e);
    }
  });
});

document.addEventListener('DOMContentLoaded', () => {
  // Restore last data when popup opens
  const tbody = document.querySelector('#dataTable tbody');
  loadData((data) => {
    if (data.length > 0) {
      tbody.innerHTML = ''; // Clear existing content
      data.forEach(item => {
        const tr = document.createElement('tr');
        ['sku', 'upc', 'url', 'color', 'size', 'currentPrice', 'regularPrice', 'availability'].forEach(key => {
          const td = document.createElement('td');
          td.textContent = item[key] || 'N/A';
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    }
  });
});

// Extract current page
document.getElementById('current').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (tab.url.includes('macys.com')) {
      chrome.runtime.sendMessage({ action: 'extractCurrent', tabId: tab.id });
    } else {
      alert('Please open a Macy\'s product page.');
    }
  });
});

// Start multi-URL extraction
document.getElementById('start').addEventListener('click', () => {
  const urls = document.getElementById('urls').value.split('\n').filter(u => u.trim());
  if (urls.length === 0) {
    alert('Please enter at least one URL.');
    return;
  }
  const tbody = document.querySelector('#dataTable tbody');
  tbody.innerHTML = ''; // Clear table before starting multi-URL extraction
  chrome.runtime.sendMessage({ action: 'startExtraction', urls });
});

// Handle extraction results
chrome.runtime.onMessage.addListener((msg) => {
  const tbody = document.querySelector('#dataTable tbody');
  if (msg.action === 'appendData') {
    // Append new data progressively without clearing
    msg.data.forEach(item => {
      const tr = document.createElement('tr');
      ['sku', 'upc', 'url', 'color', 'size', 'currentPrice', 'regularPrice', 'availability'].forEach(key => {
        const td = document.createElement('td');
        td.textContent = item[key] || 'N/A';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    // Update and save lastData with the new data
    saveData([...msg.data]);
  } else if (msg.action === 'extractionComplete' || msg.action === 'currentExtractionComplete') {
    // For current page or multi-URL completion, update the table with new data
    tbody.innerHTML = ''; // Clear existing content
    msg.data.forEach(item => {
      const tr = document.createElement('tr');
      ['sku', 'upc', 'url', 'color', 'size', 'currentPrice', 'regularPrice', 'availability'].forEach(key => {
        const td = document.createElement('td');
        td.textContent = item[key] || 'N/A';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    // Update and save lastData with the new data
    saveData([...msg.data]);
  }
});

// Copy table to clipboard as TSV
function getTableDataForClipboard() {
  const rows = Array.from(document.querySelectorAll('#dataTable tr'));
  return rows.map(row => {
    const cells = Array.from(row.querySelectorAll('th, td')).map(cell => {
      const text = cell.textContent.trim(); // Ensure no leading/trailing spaces
      // Special handling for UPC to force text format in Excel
      if (row.querySelector('th')?.textContent === 'UPC' && !isNaN(text)) {
        return `'${text}`; // Prepend single quote for text formatting
      }
      // Quote only if text contains a comma, otherwise use plain text
      return text.includes(',') ? `"${text.replace(/"/g, '""')}"` : text;
    });
    return cells.join('\t'); // Use tab as delimiter for clipboard
  }).join('\r\n');
}

// Download table as CSV
function getTableDataForDownload() {
  const rows = Array.from(document.querySelectorAll('#dataTable tr'));
  return rows.map(row => {
    const cells = Array.from(row.querySelectorAll('th, td')).map(cell => {
      const text = cell.textContent.trim(); // Ensure no leading/trailing spaces
      // Special handling for UPC to force text format in Excel
      if (row.querySelector('th')?.textContent === 'UPC' && !isNaN(text)) {
        return `'${text}`; // Prepend single quote for text formatting
      }
      // Quote only if text contains a comma, otherwise use plain text
      return text.includes(',') ? `"${text.replace(/"/g, '""')}"` : text;
    });
    return cells.join(','); // Use comma as delimiter for download
  }).join('\r\n');
}

document.getElementById('copy').addEventListener('click', () => {
  const csv = getTableDataForClipboard();
  if (csv.includes('SKU')) { // Ensure there's data
    navigator.clipboard.writeText(csv).then(() => alert('Copied to clipboard!'));
  } else {
    alert('No data to copy.');
  }
});

// Download table as CSV
document.getElementById('download').addEventListener('click', () => {
  const csv = getTableDataForDownload();
  if (csv.includes('SKU')) { // Ensure there's data
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'macys_data.csv';
    a.click();
    URL.revokeObjectURL(url);
  } else {
    alert('No data to download.');
  }

});


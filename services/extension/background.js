chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Extract from current page
  if (request.action === 'extractCurrent') {
    chrome.scripting.executeScript({
      target: { tabId: request.tabId },
      files: ['content.js']
    }).then(() => {
      chrome.tabs.sendMessage(request.tabId, { action: 'extract' }, (response) => {
        if (response && response.data) {
          chrome.runtime.sendMessage({ action: 'currentExtractionComplete', data: response.data });
        } else {
          chrome.runtime.sendMessage({ action: 'currentExtractionComplete', data: [] });
          alert('No data extracted from the current page.');
        }
      });
    }).catch(err => {
      console.error('Script injection error:', err);
      chrome.runtime.sendMessage({ action: 'currentExtractionComplete', data: [] });
      alert('Error extracting data.');
    });
  }

  // Extract from multiple URLs
  if (request.action === 'startExtraction') {
    const urls = request.urls;
    let results = [];
    let index = 0;

    function processNext() {
      if (index >= urls.length) {
        chrome.runtime.sendMessage({ action: 'extractionComplete', data: results });
        return;
      }

      chrome.tabs.create({ url: urls[index], active: false }, (tab) => {
        const listener = (tabId, info) => {
          if (info.status === 'complete' && tabId === tab.id) {
            chrome.tabs.onUpdated.removeListener(listener);
            chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content.js']
            }).then(() => {
              chrome.tabs.sendMessage(tab.id, { action: 'extract' }, (response) => {
                if (response && response.data) {
                  results = results.concat(response.data);
                  // Send progressive update
                  chrome.runtime.sendMessage({ action: 'appendData', data: response.data });
                }
                chrome.tabs.remove(tab.id);
                index++;
                processNext();
              });
            }).catch(err => {
              console.error('Script injection error:', err);
              index++;
              processNext();
            });
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
    }

    processNext();
  }
});
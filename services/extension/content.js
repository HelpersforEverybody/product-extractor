function getInitialStateFromPage() {
  return new Promise(resolve => {
    function handleMessage(event) {
      if (event.source !== window) return;
      if (event.data.type === 'MACYS_INITIAL_STATE') {
        window.removeEventListener('message', handleMessage);
        try {
          const parsed = JSON.parse(event.data.data);
          resolve(parsed);
        } catch (e) {
          console.error('Failed to parse __INITIAL_STATE__ from inject.js:', e);
          resolve(null);
        }
      }
    }
    window.addEventListener('message', handleMessage);

    // Inject page script
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('inject.js');
    (document.head || document.documentElement).appendChild(s);
    s.onload = () => s.remove();
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'extract') {
    let offers = [];
    let regularPrice = '138.00';
    let sizeMap = {};
    let productUrl = window.location.href; // Capture the current page URL

    // Step 1: Try JSON-LD for offers
    const jsonLdScript = document.querySelector('#productMktData');
    if (jsonLdScript) {
      try {
        const productData = JSON.parse(jsonLdScript.textContent);
        offers = productData.offers || [];
      } catch (err) {
        console.warn('JSON-LD parse failed:', err);
      }
    }

    // Step 2: Get Macy's __INITIAL_STATE__ for size mapping
    getInitialStateFromPage().then(initialState => {
      if (initialState) {
        const upcs = initialState?.pageData?.product?.product?.relationships?.upcs || {};
        Object.values(upcs).forEach(upcObj => {
          const sizeAttr = upcObj.attributes.find(a => a.name === 'SIZE');
          if (sizeAttr) {
            sizeMap[upcObj.identifier.upcNumber.toString()] = sizeAttr.value;
          }
        });
        console.log('✅ sizeMap built:', sizeMap);
      } else {
        console.warn('⚠ No __INITIAL_STATE__ received');
      }

      // Step 3: Merge sizes with offers
      const extractedData = offers.map(offer => {
        let size = 'N/A';
        const upc = (offer.SKU || '').replace('USA', '');

        // Check offer attributes first
        if (offer.itemOffered?.attributes) {
          const sizeAttr = offer.itemOffered.attributes.find(a =>
            a?.name?.toUpperCase() === 'SIZE'
          );
          if (sizeAttr?.value) size = sizeAttr.value.trim();
        }

        // Fallback to sizeMap from __INITIAL_STATE__
        if (size === 'N/A' && sizeMap[upc]) {
          size = sizeMap[upc];
        }

        return {
          sku: offer.SKU || 'N/A',
          upc,
          url: productUrl,
          color: offer.itemOffered?.color || 'N/A',
          size,
          currentPrice: offer.price ? offer.price.toString() : 'N/A',
          regularPrice: regularPrice,
          availability: (offer.availability || '').split('/').pop() || 'N/A'
        };
      });

      console.log('📦 Final Extracted Data:', extractedData);
      sendResponse({ data: extractedData });
    });

    return true; // keep sendResponse alive for async
  }
});
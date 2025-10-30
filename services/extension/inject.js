(function () {
  try {
    const safeData = JSON.stringify(window.__INITIAL_STATE__);
    window.postMessage({
      type: 'MACYS_INITIAL_STATE',
      data: safeData
    }, '*');
  } catch (err) {
    console.error('inject.js failed to serialize __INITIAL_STATE__:', err);
  }
})();

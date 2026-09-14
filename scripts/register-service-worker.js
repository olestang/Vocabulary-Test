if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    const swUrl = new URL('../sw.js', import.meta.url);
    navigator.serviceWorker.register(swUrl).catch(() => {
      // Offline caching is helpful but not required for the active page to function.
    });
  });
}

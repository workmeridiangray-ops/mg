/* Analytics: Google Tag Manager, Google Analytics and Microsoft Clarity.
   Loaded after the page so it never slows down the first paint. */
(function () {
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  window.gtag('consent', 'default', {
    analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied'
  });
  window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
  window.gtag('js', new Date());
  window.gtag('config', 'G-033585W608');

  function addScript(src) {
    var s = document.createElement('script'); s.async = true; s.src = src; document.head.appendChild(s);
  }
  addScript('https://www.googletagmanager.com/gtm.js?id=GTM-P2J33CRL');
  addScript('https://www.googletagmanager.com/gtag/js?id=G-033585W608');
  (function (c, l, a, r, i, t, y) {
    c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
    t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
    y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
  })(window, document, 'clarity', 'script', 'z72sclowke');
})();

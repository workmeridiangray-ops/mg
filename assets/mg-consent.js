/* Cookie consent: Google Tag Manager, Google Analytics and Microsoft Clarity
   load only after the visitor clicks "Accept analytics". */
(function () {
  var K = 'mgConsent', loaded = false;
  function get() { try { return localStorage.getItem(K); } catch (e) { return null; } }
  function set(v) { try { localStorage.setItem(K, v); } catch (e) {} }
  function addScript(src) { var s = document.createElement('script'); s.async = true; s.src = src; document.head.appendChild(s); }
  function loadAnalytics() {
    if (loaded) return; loaded = true;
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
    window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
    window.gtag('js', new Date()); window.gtag('config', 'G-033585W608');
    addScript('https://www.googletagmanager.com/gtm.js?id=GTM-P2J33CRL');
    addScript('https://www.googletagmanager.com/gtag/js?id=G-033585W608');
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, 'clarity', 'script', 'z72sclowke');
  }
  function clearCookies() {
    var host = location.hostname, parts = host.split('.'), roots = [host, '.' + host];
    if (parts.length > 2) roots.push('.' + parts.slice(-2).join('.'));
    document.cookie.split(';').forEach(function (c) {
      var n = c.split('=')[0].trim();
      if (/^(_ga|_gid|_gat|_gcl|_clck|_clsk|CLID|ANONCHK|MR|MUID|SM|SRM_B)/.test(n)) {
        roots.forEach(function (d) { document.cookie = n + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=' + d; });
        document.cookie = n + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
      }
    });
  }
  function init() {
    var b = document.getElementById('mg-cookie');
    var yes = document.getElementById('mg-cookie-ok'), no = document.getElementById('mg-cookie-no');
    var v = get();
    if (v === 'yes') loadAnalytics();
    if (b && !v) b.style.display = 'block';
    if (yes) yes.addEventListener('click', function () { set('yes'); if (b) b.style.display = 'none'; loadAnalytics(); });
    if (no) no.addEventListener('click', function () {
      var was = get() === 'yes'; set('no'); if (b) b.style.display = 'none';
      clearCookies(); if (was || loaded) location.reload();
    });
    document.addEventListener('click', function (e) {
      var t = e.target.closest && e.target.closest('[data-cookie-settings]');
      if (t && b) { e.preventDefault(); b.style.display = 'block'; }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();

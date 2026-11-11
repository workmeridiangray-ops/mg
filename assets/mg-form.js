/* Enquiry form helper: sends JSON to the backend, adds a honeypot field and,
   when MG_TURNSTILE_SITEKEY is set, a Cloudflare Turnstile check. */
(function () {
  var KEY = window.MG_TURNSTILE_SITEKEY || '';
  var wid = null, loading = false;

  function setup() {
    var f = document.getElementById('enq');
    if (!f || f.querySelector('[name="hp_company"]')) return;
    var hp = document.createElement('div');
    hp.setAttribute('aria-hidden', 'true');
    hp.style.cssText = 'position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden';
    hp.innerHTML = '<label>Company<input type="text" name="hp_company" tabindex="-1" autocomplete="off"></label>';
    f.appendChild(hp);
    if (KEY) {
      var box = document.createElement('div');
      box.id = 'mg-ts';
      box.style.cssText = 'margin:12px 0';
      var btn = f.querySelector('[type="submit"]');
      if (btn && btn.parentNode) btn.parentNode.insertBefore(box, btn); else f.appendChild(box);
      var open = document.getElementById('brief-open');
      if (open) open.addEventListener('click', renderTs);
    }
  }

  function renderTs() {
    if (wid !== null || loading) return;
    loading = true;
    var s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = function () {
      try { wid = window.turnstile.render('#mg-ts', { sitekey: KEY }); } catch (e) { loading = false; }
    };
    document.head.appendChild(s);
  }

  window.mgSend = function (url, f) {
    var d = new FormData(f);
    var token = d.get('cf-turnstile-response') || '';
    if (KEY && !token) return Promise.reject(new Error('verification pending'));
    var p = {
      name: d.get('name'), business_name: d.get('business'), industry: d.get('industry'),
      email: d.get('email'), main_problem: d.get('problem') || '', current_process: d.get('today'),
      phone: d.get('phone') || '', website: d.get('website') || '',
      preferred_contact: d.get('preferred') || '', planned_investment: d.get('investment') || '',
      hp_company: d.get('hp_company') || '', turnstile_token: token
    };
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) })
      .then(function (r) {
        if (window.turnstile && wid !== null) { try { window.turnstile.reset(wid); } catch (e) {} }
        return r;
      });
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup); else setup();
})();

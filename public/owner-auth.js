// Shared owner-PIN handling for same-origin /api calls.
// Sends the PIN from sessionStorage('ownerPin') as x-owner-pin; if the server answers "Owner PIN required",
// asks for the PIN once (even if several calls fail together), verifies it, stores it and retries.
(function () {
  var realFetch = window.fetch.bind(window);
  var pending = null;

  function isApi(input) {
    try {
      var u = new URL(typeof input === 'string' ? input : input.url, location.href);
      return u.origin === location.origin && u.pathname.indexOf('/api/') === 0;
    } catch (e) { return false; }
  }
  function withPin(init, pin) {
    init = Object.assign({}, init || {});
    var h = new Headers(init.headers || {});
    h.set('x-owner-pin', pin);
    init.headers = h;
    return init;
  }
  function ask(msg) {
    if (window.uiPrompt) return window.uiPrompt(msg, '', { title: 'Security PIN', type: 'password', okText: 'Unlock' });
    return Promise.resolve(window.prompt(msg));
  }
  async function askPin() {
    var msg = 'Owner/Admin Security PIN daalein:';
    for (;;) {
      var pin = await ask(msg);
      if (!pin) return null;
      var j = await realFetch('/api/verify-pin', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: pin })
      }).then(function (r) { return r.json(); }).catch(function () { return {}; });
      if (j.valid) { sessionStorage.setItem('ownerPin', pin); return pin; }
      if (j.error) { window.alert(j.error); return null; }
      msg = 'Galat PIN! Dobara daalein:';
    }
  }

  window.fetch = async function (input, init) {
    if (!isApi(input)) return realFetch(input, init);
    var pin = sessionStorage.getItem('ownerPin');
    var res = await realFetch(input, pin ? withPin(init, pin) : init);
    if (res.status !== 401) return res;
    var body = await res.clone().json().catch(function () { return null; });
    if (!body || body.error !== 'Owner PIN required') return res;
    sessionStorage.removeItem('ownerPin');
    pending = pending || askPin().finally(function () { pending = null; });
    var np = await pending;
    return np ? realFetch(input, withPin(init, np)) : res;
  };
})();

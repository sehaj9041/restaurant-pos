// If the staff login expired (API answers 401 {login:true}), send the browser to /login and come back here afterwards.
(function () {
  var realFetch = window.fetch.bind(window);
  var going = false;
  window.fetch = function (input, init) {
    // Old WebViews (some Android TVs) default to credentials:'omit', so the login cookie is never sent and every API call gets 401.
    // Same-origin cookies are always wanted here, so make that the default.
    if (typeof input === 'string' && !(init && init.credentials)) init = Object.assign({}, init, { credentials: 'same-origin' });
    return realFetch(input, init).then(function (res) {
      if (res.status === 401 && !going) {
        res.clone().json().then(function (b) {
          if (b && b.login && !going) { going = true; location.href = (/^\/index\.html(\/|$)/i.test(location.pathname) ? '/index.html/login' : '/login') + '?next=' + encodeURIComponent(location.pathname + location.search); }
        }).catch(function () {});
      }
      return res;
    });
  };
})();

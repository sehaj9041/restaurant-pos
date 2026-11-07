// If the staff login expired (API answers 401 {login:true}), send the browser to /login and come back here afterwards.
(function () {
  var realFetch = window.fetch.bind(window);
  var going = false;
  window.fetch = function (input, init) {
    return realFetch(input, init).then(function (res) {
      if (res.status === 401 && !going) {
        res.clone().json().then(function (b) {
          if (b && b.login && !going) { going = true; location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); }
        }).catch(function () {});
      }
      return res;
    });
  };
})();

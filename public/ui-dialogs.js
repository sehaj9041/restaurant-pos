/* Professional replacements for the browser's native alert / confirm / prompt.
   alert()      -> overridden globally (non-blocking, drop-in)
   uiConfirm()  -> await uiConfirm(msg, {title, okText, cancelText, danger})  => true/false
   uiPrompt()   -> await uiPrompt(msg, defaultValue, {title, type, okText})   => string | null */
(function () {
  if (window.__uiDialogs) return;
  window.__uiDialogs = true;

  var css = document.createElement('style');
  css.textContent = [
    '.ud-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(15,23,42,.55);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);animation:ud-fade .15s ease-out;font-family:inherit}',
    '.ud-box{width:100%;max-width:400px;background:#fff;color:#1f2937;border-radius:18px;box-shadow:0 25px 60px rgba(0,0,0,.35);padding:24px 24px 20px;animation:ud-pop .18s ease-out;max-height:90vh;overflow:auto}',
    '.ud-icon{width:48px;height:48px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:24px;margin:0 auto 12px}',
    '.ud-info{background:#fff7ed;color:#ea580c}.ud-success{background:#ecfdf5;color:#059669}.ud-error{background:#fef2f2;color:#dc2626}.ud-warn{background:#fffbeb;color:#d97706}',
    '.ud-title{font-size:17px;font-weight:800;text-align:center;margin:0 0 6px;color:#111827}',
    '.ud-msg{font-size:14px;line-height:1.5;text-align:center;color:#4b5563;white-space:pre-line;word-break:break-word;margin:0}',
    '.ud-input{display:block;width:100%;box-sizing:border-box;margin-top:14px;padding:10px 12px;font-size:15px;border:1.5px solid #d1d5db;border-radius:10px;outline:none;background:#fff;color:#111827;font-family:inherit}',
    '.ud-input:focus{border-color:#ea580c;box-shadow:0 0 0 3px rgba(234,88,12,.18)}',
    '.ud-actions{display:flex;gap:10px;margin-top:20px}',
    '.ud-btn{flex:1;padding:11px 14px;font-size:14px;font-weight:700;border-radius:10px;border:1.5px solid transparent;cursor:pointer;font-family:inherit;transition:filter .12s,transform .05s}',
    '.ud-btn:active{transform:scale(.97)}.ud-btn:hover{filter:brightness(.95)}',
    '.ud-ok{background:#ea580c;color:#fff}.ud-ok.ud-danger{background:#dc2626}',
    '.ud-cancel{background:#fff;color:#374151;border-color:#d1d5db}',
    '.ud-btn:focus-visible{outline:3px solid rgba(234,88,12,.4);outline-offset:2px}',
    '@keyframes ud-fade{from{opacity:0}to{opacity:1}}',
    '@keyframes ud-pop{from{opacity:0;transform:scale(.94) translateY(8px)}to{opacity:1;transform:none}}'
  ].join('');
  document.head.appendChild(css);

  var queue = [], busy = false;

  function kindOf(msg, def) {
    var m = String(msg);
    if (/^\s*(✅|✔)|success|saved|sent|received|ho gaya|done/i.test(m)) return 'success';
    if (/^\s*(❌|⚠)|error|fail|galat|invalid|valid |nahi|not |could not|zaroori|max limit|pehle|please/i.test(m)) return /^\s*⚠|pehle|please|zaroori|max limit/i.test(m) ? 'warn' : 'error';
    return def;
  }
  var ICONS = { info: 'ℹ', success: '✓', error: '✕', warn: '!' };

  function show(opts) {
    return new Promise(function (resolve) {
      queue.push({ o: opts, resolve: resolve });
      next();
    });
  }

  function next() {
    if (busy || !queue.length) return;
    busy = true;
    var job = queue.shift(), o = job.o;
    var prevFocus = document.activeElement;

    var ov = document.createElement('div'); ov.className = 'ud-overlay';
    var box = document.createElement('div'); box.className = 'ud-box';
    box.setAttribute('role', o.mode === 'alert' ? 'alertdialog' : 'dialog'); box.setAttribute('aria-modal', 'true');

    var ic = document.createElement('div'); ic.className = 'ud-icon ud-' + o.kind; ic.textContent = ICONS[o.kind]; box.appendChild(ic);
    var t = document.createElement('h3'); t.className = 'ud-title'; t.textContent = o.title; box.appendChild(t);
    var p = document.createElement('p'); p.className = 'ud-msg'; p.textContent = o.message; box.appendChild(p);

    var input = null;
    if (o.mode === 'prompt') {
      input = document.createElement('input'); input.className = 'ud-input'; input.type = o.type || 'text';
      input.value = o.value || ''; input.autocomplete = 'off';
      if (o.placeholder) input.placeholder = o.placeholder;
      box.appendChild(input);
    }

    var act = document.createElement('div'); act.className = 'ud-actions';
    var cancel = null;
    if (o.mode !== 'alert') {
      cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'ud-btn ud-cancel'; cancel.textContent = o.cancelText || 'Cancel';
      act.appendChild(cancel);
    }
    var ok = document.createElement('button'); ok.type = 'button'; ok.className = 'ud-btn ud-ok' + (o.danger ? ' ud-danger' : ''); ok.textContent = o.okText || 'OK';
    act.appendChild(ok); box.appendChild(act);
    ov.appendChild(box); document.body.appendChild(ov);

    function close(result) {
      document.removeEventListener('keydown', onKey, true);
      ov.remove(); busy = false;
      try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (e) {}
      job.resolve(result); next();
    }
    var okResult = function () { return o.mode === 'prompt' ? input.value : true; };
    var cancelResult = o.mode === 'prompt' ? null : (o.mode === 'alert' ? undefined : false);
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(cancelResult); }
      else if (e.key === 'Enter' && (!cancel || document.activeElement !== cancel)) { e.preventDefault(); e.stopPropagation(); close(okResult()); }
      else if (e.key === 'Tab') { // keep focus inside dialog
        var f = [input, cancel, ok].filter(Boolean), i = f.indexOf(document.activeElement);
        e.preventDefault(); f[(i + (e.shiftKey ? f.length - 1 : 1)) % f.length].focus();
      }
    }
    document.addEventListener('keydown', onKey, true);
    ok.onclick = function () { close(okResult()); };
    if (cancel) cancel.onclick = function () { close(cancelResult); };
    if (o.mode !== 'alert') ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(cancelResult); });
    setTimeout(function () { (input || ok).focus(); if (input) input.select(); }, 20);
  }

  window.uiAlert = function (msg, opts) {
    opts = opts || {};
    var kind = opts.kind || kindOf(msg, 'info');
    return show({ mode: 'alert', message: String(msg == null ? '' : msg), kind: kind, title: opts.title || ({ success: 'Success', error: 'Error', warn: 'Attention', info: 'Notice' })[kind], okText: opts.okText });
  };
  window.uiConfirm = function (msg, opts) {
    opts = opts || {};
    var danger = opts.danger != null ? opts.danger : /delete|reject|reset|hata|clear|remove|cancel|wapas nahi/i.test(msg);
    return show({ mode: 'confirm', message: String(msg), kind: danger ? 'warn' : 'info', danger: danger, title: opts.title || (danger ? 'Are you sure?' : 'Please confirm'), okText: opts.okText || (danger ? 'Yes, proceed' : 'Confirm'), cancelText: opts.cancelText });
  };
  window.uiPrompt = function (msg, value, opts) {
    opts = opts || {};
    return show({ mode: 'prompt', message: String(msg), value: value, kind: 'info', title: opts.title || 'Input required', type: opts.type, placeholder: opts.placeholder, okText: opts.okText || 'Submit', cancelText: opts.cancelText });
  };
  window.alert = function (msg) { window.uiAlert(msg); };
})();

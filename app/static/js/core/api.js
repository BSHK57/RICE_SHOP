/*
 * core/api.js - tiny fetch wrapper for the JSON API (docs/DESIGN.md section 5, envelope in section 2).
 *
 * Responsibilities
 *   - adds the X-CSRF-Token header to every request (token from window.APP.csrf)
 *   - unwraps the {ok, data} envelope and resolves with `data`
 *   - rejects with an Error that has {message, code, status}
 *   - shows an error toast (App.ui.toast) unless opts.silent is true
 *   - 401 -> location.reload() (the login page is shown by the server)
 *   - skips null / '' / undefined query params
 *
 * Usage
 *   const list  = await App.api.get('/api/customers', {q: 'ra', include_inactive: 0});
 *   const sale  = await App.api.post('/api/sales/retail', {payment_mode: 'cash', items: [...]});
 *   await App.api.put('/api/customers/3', {phone: '99999'});
 *   await App.api.del('/api/credits/payments/9');
 *   await App.api.post('/api/customers', body, {silent: true});   // handle the error yourself
 *   try { ... } catch (e) { if (e.code === 'duplicate') ... e.status === 409 ... }
 *   App.api.download('/api/reports/sales.csv', {from: '2026-11-01', to: '2026-11-05'});
 */
(function () {
  'use strict';
  var App = (window.App = window.App || {});

  function buildUrl(url, params) {
    if (!params) return url;
    var qs = [];
    Object.keys(params).forEach(function (k) {
      var v = params[k];
      if (v === null || v === undefined || v === '') return;
      qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    if (!qs.length) return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + qs.join('&');
  }

  function csrf() {
    return (window.APP && window.APP.csrf) || App.csrf || '';
  }

  function makeError(message, code, status) {
    var err = new Error(message);
    err.code = code || 'error';
    err.status = status || 0;
    return err;
  }

  function fail(err, opts) {
    if (!(opts && opts.silent) && App.ui && App.ui.toast) App.ui.toast(err.message, 'error');
    return Promise.reject(err);
  }

  function request(method, url, body, opts) {
    opts = opts || {};
    var headers = { 'Accept': 'application/json', 'X-CSRF-Token': csrf() };
    var init = { method: method, headers: headers, credentials: 'same-origin' };
    if (body !== undefined && body !== null && method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(url, init).then(
      function (res) {
        if (res.status === 401) {
          // Session expired / not logged in: the server will serve the login page.
          window.location.reload();
          return new Promise(function () {}); // never settle; the page is reloading
        }
        return res.text().then(function (text) {
          var json = null;
          try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
          if (json && json.ok === true) return json.data;
          var msg = (json && json.error) || (res.ok ? 'Unexpected response from the server.' : 'Request failed (' + res.status + ').');
          return fail(makeError(msg, json && json.code, res.status), opts);
        });
      },
      function () {
        return fail(makeError('Could not reach the server. Check your connection and try again.', 'network', 0), opts);
      }
    );
  }

  function download(url, params, opts) {
    opts = opts || {};
    var full = buildUrl(url, params);
    return fetch(full, { credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf() } }).then(
      function (res) {
        if (res.status === 401) { window.location.reload(); return new Promise(function () {}); }
        if (!res.ok) {
          return res.text().then(function (t) {
            var msg = 'Download failed (' + res.status + ').';
            try { var j = JSON.parse(t); if (j && j.error) msg = j.error; } catch (e) { /* not json */ }
            return fail(makeError(msg, 'download', res.status), opts);
          });
        }
        var cd = res.headers.get('Content-Disposition') || '';
        var m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
        var name = m ? decodeURIComponent(m[1]) : (full.split('?')[0].split('/').pop() || 'download');
        return res.blob().then(function (blob) {
          var a = document.createElement('a');
          var objUrl = URL.createObjectURL(blob);
          a.href = objUrl;
          a.download = name;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () { URL.revokeObjectURL(objUrl); }, 2000);
          return name;
        });
      },
      function () {
        return fail(makeError('Could not reach the server. Check your connection and try again.', 'network', 0), opts);
      }
    );
  }

  App.api = {
    get: function (url, params, opts) { return request('GET', buildUrl(url, params), null, opts); },
    post: function (url, body, opts) { return request('POST', url, body === undefined ? {} : body, opts); },
    put: function (url, body, opts) { return request('PUT', url, body === undefined ? {} : body, opts); },
    del: function (url, opts) { return request('DELETE', url, null, opts); },
    download: download,
    buildUrl: buildUrl,
  };
})();

/*
 * core/app.js - application shell: current user, permission check, tab registry and tab switching.
 * Loaded after api.js / ui.js / components.js and BEFORE core/bell.js and the tab modules (tabs/<id>.js).
 *
 * Contract (docs/DESIGN.md section 6.2)
 *   App.user, App.csrf, App.tabs           from window.APP (set by templates/index.html)
 *   App.can('retail:edit') -> bool
 *
 *   // in static/js/tabs/<id>.js
 *   App.registerTab('inventory', {
 *     init(root) { ... build static DOM / listeners once ... },   // first time the tab is opened
 *     show(root) { ... (re)load data ... },                       // every time the tab is opened
 *   });
 *
 *   App.showTab('credits')      // switch tab (no URL/hash change); last tab is remembered in sessionStorage
 *   App.reload('credits')       // re-run show() if the tab was already initialised (e.g. after a sale elsewhere)
 *   App.refreshBell()           // no-op here; core/bell.js replaces it when the user has orders:view
 *   App.currentTab()            // id of the visible tab
 *
 * Markup it drives: [data-tab-btn="<id>"] buttons (sidebar + bottom nav), [data-tab-panel="<id>"] sections,
 * #page-title, #logout-btn, and <span data-icon="name"> placeholders (turned into SVGs on start).
 */
(function () {
  'use strict';
  var App = (window.App = window.App || {});
  var boot = window.APP || {};
  var h = App.ui.h;

  App.user = boot.user || { username: '', display_name: '', role: null, permissions: [] };
  App.csrf = boot.csrf || '';
  App.tabs = boot.tabs || [];

  var permSet = {};
  (App.user.permissions || []).forEach(function (p) { permSet[p] = true; });
  App.can = function (perm) { return !!permSet[perm]; };

  var STORE_KEY = 'riceShop.lastTab';
  var defs = {};        // id -> {init, show}
  var state = {};       // id -> {inited:boolean}
  var current = null;

  function panelOf(id) { return document.querySelector('[data-tab-panel="' + id + '"]'); }
  function tabInfo(id) { return App.tabs.filter(function (t) { return t.id === id; })[0] || null; }

  App.registerTab = function (id, def) {
    defs[id] = def || {};
    // a late registration (script loaded after startup) for the visible tab: bring it to life
    if (current === id && !(state[id] && state[id].inited)) activate(id);
  };

  function clearTabError(panel) {
    var old = panel.querySelector(':scope > [data-tab-error]');
    if (old) old.remove();
  }

  function showTabError(panel, title, detail) {
    clearTabError(panel);
    panel.insertBefore(h('div', { 'data-tab-error': '1', class: 'rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800', role: 'alert' },
      h('p', { class: 'font-semibold' }, title),
      h('p', { class: 'mt-1 text-red-700' }, detail),
      App.ui.btn('Reload page', { kind: 'secondary', small: true, class: 'mt-3', onClick: function () { window.location.reload(); } })), panel.firstChild);
  }

  function activate(id) {
    var panel = panelOf(id);
    if (!panel) return;
    var def = defs[id];
    if (!def) {
      showTabError(panel, 'This section could not be loaded',
        'Its script did not start. Reload the page; if it keeps happening, please tell the shop admin.');
      return;
    }
    clearTabError(panel);
    var st = state[id] || (state[id] = { inited: false });
    try {
      if (!st.inited) {
        if (def.init) def.init(panel);
        st.inited = true;
      }
      if (def.show) def.show(panel);
    } catch (err) {
      if (window.console) console.error('Tab "' + id + '" failed:', err);
      showTabError(panel, 'Something went wrong in this section', (err && err.message) || String(err));
    }
  }

  function defaultTab() {
    var ids = App.tabs.map(function (t) { return t.id; });
    if (ids.indexOf('dashboard') >= 0) return 'dashboard';
    return ids[0] || null;
  }

  App.showTab = function (id) {
    if (!tabInfo(id)) id = defaultTab();
    if (!id) return;
    current = id;
    document.querySelectorAll('[data-tab-panel]').forEach(function (p) {
      var on = p.getAttribute('data-tab-panel') === id;
      p.classList.toggle('hidden', !on);
      p.classList.remove('tab-panel');
      if (on) { void p.offsetWidth; p.classList.add('tab-panel'); }
    });
    document.querySelectorAll('[data-tab-btn]').forEach(function (b) {
      var on = b.getAttribute('data-tab-btn') === id;
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      if (on && b.closest('#bottom-nav') && b.scrollIntoView) {
        try { b.scrollIntoView({ block: 'nearest', inline: 'center' }); } catch (e) { /* old browsers */ }
      }
    });
    var info = tabInfo(id);
    var title = document.getElementById('page-title');
    if (title && info) title.textContent = info.label;
    if (info) document.title = info.label + ' · Rice Shop Manager';
    try { sessionStorage.setItem(STORE_KEY, id); } catch (e) { /* storage unavailable */ }
    window.scrollTo(0, 0);
    activate(id);
  };

  App.reload = function (id) {
    var st = state[id];
    var def = defs[id];
    var panel = panelOf(id);
    if (!st || !st.inited || !def || !def.show || !panel) return;
    try { def.show(panel); } catch (err) { if (window.console) console.error(err); }
  };

  App.currentTab = function () { return current; };

  // Replaced by core/bell.js when the user has orders:view.
  App.refreshBell = App.refreshBell || function () {};

  function start() {
    App.hydrateIcons(document);
    document.querySelectorAll('[data-tab-btn]').forEach(function (b) {
      b.addEventListener('click', function () { App.showTab(b.getAttribute('data-tab-btn')); });
    });
    var logout = document.getElementById('logout-btn');
    if (logout) {
      logout.addEventListener('click', function () {
        logout.disabled = true;
        App.api.post('/api/auth/logout', {}, { silent: true }).then(
          function () { window.location.reload(); },
          function () { window.location.reload(); });
      });
    }
    var first = null;
    try { first = sessionStorage.getItem(STORE_KEY); } catch (e) { first = null; }
    App.showTab(first && tabInfo(first) ? first : defaultTab());
    if (!App.tabs.length) {
      var main = document.getElementById('main');
      if (main) main.appendChild(App.ui.empty('Your account has no sections yet. Ask the admin to give you access.', 'lock'));
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();

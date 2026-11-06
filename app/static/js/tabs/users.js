/*
 * tabs/users.js - admin screen: list built-in + custom users, create user, edit permissions,
 * activate/deactivate, reset password.
 * API: GET /api/users, GET /api/users/catalog, POST /api/users, PUT /api/users/<id>, POST /api/users/<id>/password
 * (docs/DESIGN.md 5.1). Built-in users are read-only. Permission implications (edit -> view) mirror
 * app/auth/permissions.py IMPLIES; the server normalises again, so this is only for a clear UI.
 */
(function () {
  'use strict';
  var App = window.App;
  var ui = App.ui;
  var h = ui.h;

  // Mirror of app/auth/permissions.py IMPLIES (holding the key on the left grants the one on the right).
  var IMPLIES = {
    'retail:edit': 'retail:view', 'wholesale:edit': 'wholesale:view', 'inventory:edit': 'inventory:view',
    'customers:edit': 'customers:view', 'orders:edit': 'orders:view', 'credits:edit': 'credits:view',
    'credits:delete': 'credits:edit', 'credits:wholesale': 'credits:view', 'sales:void': 'retail:view',
  };
  var PRESET_LABEL = { admin: 'Admin', super: 'Super user', staff: 'Staff' };
  var ROLE_LABEL = { admin: 'Admin', super: 'Super user', staff: 'Staff' };

  var listEl;
  var users = [];
  var catalog = null;
  var loaded = false;
  var seq = 0;

  // ------------------------------------------------------------------ permission picker
  function permissionPicker(initial) {
    var boxes = {};
    var checked = {};
    (initial || []).forEach(function (k) { checked[k] = true; });

    function implied(k) {   // all keys granted by k, transitively
      var out = [], cur = IMPLIES[k];
      while (cur) { out.push(cur); cur = IMPLIES[cur]; }
      return out;
    }
    function sync() { Object.keys(boxes).forEach(function (k) { boxes[k].checked = !!checked[k]; }); }
    function onToggle(k) {
      if (boxes[k].checked) {
        checked[k] = true;
        implied(k).forEach(function (p) { checked[p] = true; });
      } else {
        delete checked[k];
        // anything that depends on k must go too
        var changed = true;
        while (changed) {
          changed = false;
          Object.keys(checked).forEach(function (p) {
            if (implied(p).indexOf(k) >= 0) { delete checked[p]; changed = true; }
          });
        }
      }
      sync();
    }
    var groups = [];
    var byGroup = {};
    catalog.permissions.forEach(function (p) {
      if (!byGroup[p.group]) { byGroup[p.group] = []; groups.push(p.group); }
      byGroup[p.group].push(p);
    });
    var el = h('div', { class: 'grid gap-3 sm:grid-cols-2' }, groups.map(function (g) {
      return h('fieldset', { class: 'rounded-lg border border-stone-200 p-3' },
        h('legend', { class: 'px-1 text-xs font-semibold uppercase tracking-wide text-stone-500' }, g),
        h('div', { class: 'space-y-1.5' }, byGroup[g].map(function (p) {
          var cb = h('input', { type: 'checkbox', class: 'mt-0.5 h-4 w-4 shrink-0 rounded border-stone-300 text-primary-600 focus:ring-primary-500', on: { change: function () { onToggle(p.key); } } });
          boxes[p.key] = cb;
          return h('label', { class: 'flex cursor-pointer items-start gap-2 text-sm text-stone-700' }, cb, h('span', null, p.label));
        })));
    }));
    sync();
    return {
      el: el,
      get: function () { return Object.keys(checked); },
      set: function (keys) {
        checked = {};
        (keys || []).forEach(function (k) { checked[k] = true; implied(k).forEach(function (p) { checked[p] = true; }); });
        sync();
      },
    };
  }

  function passwordInput(label, hint) {
    var inp = ui.input({ type: 'password', autocomplete: 'new-password', minlength: 6, class: 'pr-11' });
    var tog = h('button', {
      type: 'button', 'aria-label': 'Show password', 'aria-pressed': 'false',
      class: 'absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-stone-400 hover:text-stone-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
      on: { click: function () {
        var show = inp.type === 'password';
        inp.type = show ? 'text' : 'password';
        tog.setAttribute('aria-pressed', show ? 'true' : 'false');
        tog.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        tog.replaceChildren(App.icon(show ? 'eyeoff' : 'eye', 'h-5 w-5'));
      } },
    }, App.icon('eye', 'h-5 w-5'));
    var wrap = h('div', { class: 'relative' }, inp, tog);
    return { input: inp, field: ui.field({ label: label, input: wrap, hint: hint, required: true }) };
  }

  function formModal(o) {
    var formId = ui.uid('user-form');
    var errBox = h('p', { class: 'hidden rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700', role: 'alert' });
    var form = h('form', { id: formId, novalidate: true, class: 'space-y-4' }, o.content, errBox);
    var save = ui.btn(o.submitText || 'Save', { kind: 'primary', type: 'submit', icon: 'check' });
    save.setAttribute('form', formId);
    var m = ui.modal({ title: o.title, size: o.size || 'md', body: form, footer: [ui.btn('Cancel', { onClick: function () { m.close(); } }), save] });
    function showErr(msg) { errBox.textContent = msg; errBox.classList.remove('hidden'); errBox.scrollIntoView({ block: 'nearest' }); }
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      errBox.classList.add('hidden');
      var p;
      try { p = o.onSubmit(); } catch (err) { showErr(err.message); return; }
      if (!p) return;
      save.setBusy(true);
      p.then(function () { m.close(); load(); }).catch(function (err) { save.setBusy(false); showErr(err.message); });
    });
    return m;
  }

  // ------------------------------------------------------------------ dialogs
  function openNew() {
    var username = ui.input({ type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: 40, placeholder: 'e.g. ravi' });
    var display = ui.input({ type: 'text', maxlength: 80, placeholder: 'e.g. Ravi (counter)' });
    var pw = passwordInput('Password', 'At least 6 characters. Tell the person in private.');
    var picker = permissionPicker([]);
    var presetBtns = Object.keys(catalog.presets).filter(function (k) { return PRESET_LABEL[k]; }).map(function (k) {
      return ui.btn(PRESET_LABEL[k], { small: true, onClick: function () { picker.set(catalog.presets[k]); } });
    });
    var presetNote = h('p', { class: 'text-xs text-stone-500' }, 'Start from a preset, then tick or untick individual permissions. Ticking an “edit” permission also ticks its “view”.');
    formModal({
      title: 'New user', size: 'lg', submitText: 'Create user',
      content: h('div', { class: 'space-y-4' },
        h('div', { class: 'grid gap-4 sm:grid-cols-2' },
          ui.field({ label: 'Username', input: username, required: true, hint: 'Used to sign in. Must be unique.' }),
          ui.field({ label: 'Display name', input: display, required: true })),
        pw.field,
        h('div', { class: 'space-y-2' },
          h('p', { class: 'text-sm font-medium text-stone-700' }, 'Permissions'),
          h('div', { class: 'flex flex-wrap items-center gap-2' }, presetBtns, ui.btn('Clear', { small: true, kind: 'ghost', onClick: function () { picker.set([]); } })),
          presetNote, picker.el)),
      onSubmit: function () {
        var u = username.value.trim();
        var d = display.value.trim();
        if (!u) throw new Error('Username is required.');
        if (!d) throw new Error('Display name is required.');
        if (pw.input.value.length < 6) throw new Error('Password must be at least 6 characters.');
        var perms = picker.get();
        if (!perms.length) throw new Error('Pick at least one permission (or use a preset).');
        return App.api.post('/api/users', { username: u, display_name: d, password: pw.input.value, permissions: perms }, { silent: true })
          .then(function () { ui.toast('User “' + u + '” created'); });
      },
    });
  }

  function openEdit(u) {
    var display = ui.input({ type: 'text', value: u.display_name, maxlength: 80 });
    var picker = permissionPicker(u.permissions);
    var presetBtns = Object.keys(catalog.presets).filter(function (k) { return PRESET_LABEL[k]; }).map(function (k) {
      return ui.btn(PRESET_LABEL[k], { small: true, onClick: function () { picker.set(catalog.presets[k]); } });
    });
    formModal({
      title: 'Edit ' + u.username, size: 'lg', submitText: 'Save changes',
      content: h('div', { class: 'space-y-4' },
        ui.field({ label: 'Display name', input: display, required: true }),
        h('div', { class: 'space-y-2' },
          h('p', { class: 'text-sm font-medium text-stone-700' }, 'Permissions'),
          h('div', { class: 'flex flex-wrap items-center gap-2' }, h('span', { class: 'text-xs text-stone-500' }, 'Replace with preset:'), presetBtns),
          picker.el),
        h('p', { class: 'text-xs text-stone-500' }, 'Changes apply the next time this person loads the page.')),
      onSubmit: function () {
        var d = display.value.trim();
        if (!d) throw new Error('Display name is required.');
        var perms = picker.get();
        if (!perms.length) throw new Error('Pick at least one permission, or deactivate the user instead.');
        return App.api.put('/api/users/' + u.id, { display_name: d, permissions: perms }, { silent: true })
          .then(function () { ui.toast('Permissions saved'); });
      },
    });
  }

  function openPassword(u) {
    var pw = passwordInput('New password', 'At least 6 characters.');
    var again = passwordInput('Repeat new password');
    formModal({
      title: 'Reset password — ' + u.username, size: 'sm', submitText: 'Set password',
      content: h('div', { class: 'space-y-4' }, pw.field, again.field),
      onSubmit: function () {
        if (pw.input.value.length < 6) throw new Error('Password must be at least 6 characters.');
        if (pw.input.value !== again.input.value) throw new Error('The two passwords do not match.');
        return App.api.post('/api/users/' + u.id + '/password', { password: pw.input.value }, { silent: true })
          .then(function () { ui.toast('Password changed for ' + u.username); });
      },
    });
  }

  function toggleActive(u) {
    var activate = !u.is_active;
    ui.confirm({
      title: activate ? 'Re-activate ' + u.username + '?' : 'Deactivate ' + u.username + '?',
      message: activate ? 'They will be able to sign in again.' : 'They will be signed out and cannot sign in until you re-activate them. Their sales and history are kept.',
      confirmText: activate ? 'Activate' : 'Deactivate', danger: !activate,
    }).then(function (yes) {
      if (!yes) return;
      App.api.put('/api/users/' + u.id, { is_active: activate }).then(function () {
        ui.toast(activate ? u.username + ' re-activated' : u.username + ' deactivated');
        load();
      }).catch(function () { /* toast shown by api */ });
    });
  }

  // ------------------------------------------------------------------ list
  function permissionChips(u) {
    var perms = u.permissions || [];
    var all = catalog.permissions;
    var held = {};
    perms.forEach(function (k) { held[k] = true; });
    var count = all.filter(function (p) { return held[p.key]; }).length;
    if (count === all.length) return [ui.badge('Everything', 'green')];
    var groups = [], seen = {};
    all.forEach(function (p) {
      if (!held[p.key]) return;
      if (!seen[p.group]) { seen[p.group] = { group: p.group, edit: false, labels: [] }; groups.push(seen[p.group]); }
      seen[p.group].labels.push(p.label);
      if (/:(edit|delete|manage|void)$/.test(p.key)) seen[p.group].edit = true;
    });
    var chips = groups.map(function (g) {
      var b = ui.badge(g.group + (g.edit ? '' : ' (view)'), g.edit ? 'blue' : 'gray');
      b.title = g.labels.join('\n');
      return b;
    });
    return chips.length ? chips : [h('span', { class: 'text-xs text-stone-400' }, 'No access')];
  }

  function userActions(u) {
    if (u.source === 'builtin') return h('span', { class: 'block text-right text-xs text-stone-400' }, 'Fixed in the app');
    var self = u.username === App.user.username;
    return h('div', { class: 'flex flex-wrap justify-end gap-1.5' },
      ui.btn('Permissions', { small: true, icon: 'shield', onClick: function () { openEdit(u); } }),
      ui.btn('Password', { small: true, icon: 'key', onClick: function () { openPassword(u); } }),
      ui.btn(u.is_active === false ? 'Activate' : 'Deactivate', { small: true, kind: u.is_active === false ? 'secondary' : 'ghost', disabled: self && u.is_active !== false, title: self ? 'You cannot deactivate yourself' : undefined, onClick: function () { toggleActive(u); } }));
  }

  function renderList() {
    listEl.innerHTML = '';
    if (!loaded) { listEl.appendChild(ui.spinner()); return; }
    listEl.appendChild(ui.table({
      rows: users, empty: 'No users found.', emptyIcon: 'users',
      rowClass: function (u) { return u.is_active === false ? 'opacity-60' : ''; },
      columns: [
        { key: 'display_name', label: 'User', render: function (u) {
          return h('div', null,
            h('div', { class: 'font-medium text-stone-900' }, u.display_name, u.username === App.user.username ? h('span', { class: 'ml-2 text-xs font-normal text-stone-400' }, '(you)') : null),
            h('div', { class: 'text-xs text-stone-500' }, u.username),
            h('div', { class: 'mt-2 md:hidden' }, userActions(u)));
        } },
        { key: 'role', label: 'Role', render: function (u) {
          return h('div', { class: 'flex flex-wrap gap-1' },
            ui.badge(u.source === 'builtin' ? (ROLE_LABEL[u.role] || 'Built-in') : 'Custom', u.source === 'builtin' ? 'amber' : 'blue'),
            u.source === 'builtin' ? ui.badge('Built-in', 'gray') : null);
        } },
        { key: 'permissions', label: 'Access', class: 'hidden md:table-cell', render: function (u) { return h('div', { class: 'flex max-w-md flex-wrap gap-1' }, permissionChips(u)); } },
        { key: 'is_active', label: 'Status', render: function (u) { return ui.badge(u.is_active === false ? 'Inactive' : 'Active', u.is_active === false ? 'gray' : 'green'); } },
        { key: '_actions', label: '', class: 'hidden md:table-cell', render: function (u) { return userActions(u); } },
      ],
    }));
  }

  function load() {
    var mine = ++seq;
    var reqs = [App.api.get('/api/users', null, { silent: true })];
    if (!catalog) reqs.push(App.api.get('/api/users/catalog', null, { silent: true }));
    return Promise.all(reqs).then(function (res) {
      if (mine !== seq) return;
      users = res[0] || [];
      if (res[1]) catalog = res[1];
      loaded = true;
      renderList();
    }).catch(function (e) {
      if (mine !== seq) return;
      loaded = true;
      listEl.innerHTML = '';
      listEl.appendChild(h('div', { class: 'rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800', role: 'alert' },
        h('p', { class: 'font-semibold' }, 'Users could not be loaded.'), h('p', { class: 'mt-1' }, e.message),
        ui.btn('Try again', { small: true, class: 'mt-3', onClick: function () { loaded = false; renderList(); load(); } })));
    });
  }

  App.registerTab('users', {
    init: function (root) {
      listEl = root.querySelector('[data-role=list]');
      root.querySelector('[data-role=add]').addEventListener('click', function () {
        if (!catalog) { ui.toast('Still loading, try again in a moment.', 'info'); return; }
        openNew();
      });
    },
    show: function () {
      if (!loaded) renderList();
      load();
    },
  });
})();

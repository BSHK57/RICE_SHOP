/*
 * tabs/customers.js - customer book: searchable list, add/edit modal, detail modal (contact, credit, purchases).
 * API: GET/POST /api/customers, GET/PUT /api/customers/<id> (docs/DESIGN.md 5.2).
 * Purchase amounts are shown exactly as the API returns them (masked server-side); nothing is derived here.
 * Add/edit controls only appear for users with customers:edit.
 */
(function () {
  'use strict';
  var App = window.App;
  var ui = App.ui;
  var h = ui.h;
  var fmt = App.fmt;

  var rootEl, listEl, searchEl, countEl, inactiveEl;
  var customers = [];
  var loaded = false;
  var seq = 0;
  var canEdit = false;

  function matches(c, q) {
    if (!q) return true;
    var hay = ((c.name || '') + ' ' + (c.phone || '') + ' ' + (c.place || '')).toLowerCase();
    return q.toLowerCase().split(/\s+/).every(function (t) { return hay.indexOf(t) >= 0; });
  }

  function telHref(phone) { return 'tel:' + String(phone).replace(/[^0-9+]/g, ''); }

  // ------------------------------------------------------------------ list
  function renderList() {
    listEl.innerHTML = '';
    if (!loaded) { listEl.appendChild(ui.spinner()); return; }
    var q = searchEl.value.trim();
    var rows = customers.filter(function (c) { return matches(c, q); });
    countEl.textContent = rows.length + (rows.length === 1 ? ' customer' : ' customers');
    var hasBalance = customers.some(function (c) { return c.credit_balance !== undefined && c.credit_balance !== null; });
    var cols = [
      { key: 'name', label: 'Name', render: function (c) {
        return h('div', { class: c.is_active === false ? 'opacity-60' : '' },
          h('span', { class: 'font-medium text-stone-900' }, c.name), ' ',
          c.is_active === false ? ui.badge('Inactive', 'gray') : null,
          c.phone ? h('div', { class: 'text-xs text-stone-500 sm:hidden' }, c.phone) : null);
      } },
      { key: 'phone', label: 'Phone', class: 'hidden sm:table-cell', render: function (c) {
        return c.phone ? h('a', { href: telHref(c.phone), class: 'text-stone-700 hover:text-primary-700 hover:underline', on: { click: function (e) { e.stopPropagation(); } } }, c.phone) : h('span', { class: 'text-stone-300' }, '—');
      } },
      { key: 'place', label: 'Place', class: 'hidden md:table-cell', render: function (c) { return c.place || h('span', { class: 'text-stone-300' }, '—'); } },
    ];
    if (hasBalance) {
      cols.push({ key: 'credit_balance', label: 'Credit due', align: 'right', render: function (c) {
        return c.credit_balance > 0 ? h('span', { class: 'font-medium text-amber-700' }, fmt.money(c.credit_balance)) : h('span', { class: 'text-stone-300' }, '—');
      } });
    }
    cols.push({ key: '_go', label: '', class: 'w-8 text-stone-300', render: function () { return App.icon('chevron', 'h-4 w-4 -rotate-90'); } });
    listEl.appendChild(ui.table({
      columns: cols, rows: rows, onRowClick: openDetail,
      empty: q ? 'No customer matches “' + q + '”.' : (canEdit ? 'No customers yet. Add your first customer to get started.' : 'No customers yet.'),
      emptyIcon: 'users',
    }));
  }

  function load() {
    var mine = ++seq;
    var inc = canEdit && inactiveEl.checked ? 1 : 0;
    return App.api.get('/api/customers', { include_inactive: inc }, { silent: true }).then(function (list) {
      if (mine !== seq) return;
      customers = list || [];
      loaded = true;
      renderList();
    }).catch(function (e) {
      if (mine !== seq) return;
      loaded = true;
      listEl.innerHTML = '';
      listEl.appendChild(h('div', { class: 'rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800', role: 'alert' },
        h('p', { class: 'font-semibold' }, 'Customers could not be loaded.'), h('p', { class: 'mt-1' }, e.message),
        ui.btn('Try again', { small: true, class: 'mt-3', onClick: function () { loaded = false; renderList(); load(); } })));
    });
  }

  // ------------------------------------------------------------------ add / edit
  function openForm(existing, onSaved) {
    var nameIn = ui.input({ type: 'text', value: existing ? existing.name : '', maxlength: 100, placeholder: 'e.g. Ramesh or “Ramesh Tea Stall”', required: true });
    var phoneIn = ui.input({ type: 'tel', value: existing && existing.phone ? existing.phone : '', maxlength: 30, placeholder: 'Optional' });
    var placeIn = ui.input({ type: 'text', value: existing && existing.place ? existing.place : '', maxlength: 100, placeholder: 'Village / street (optional)' });
    var notesIn = ui.textarea({ rows: 3, maxlength: 500, placeholder: 'Anything worth remembering (optional)' });
    notesIn.value = existing && existing.notes ? existing.notes : '';
    var activeIn = h('input', { type: 'checkbox', class: 'h-4 w-4 rounded border-stone-300 text-primary-600 focus:ring-primary-500', checked: existing ? existing.is_active !== false : true });

    var nameField = ui.field({ label: 'Name / nickname', input: nameIn, required: true, hint: 'Must be unique. Names are not case-sensitive.' });
    var formId = ui.uid('cust-form');
    var form = h('form', { id: formId, novalidate: true, class: 'space-y-4' },
      nameField,
      h('div', { class: 'grid gap-4 sm:grid-cols-2' }, ui.field({ label: 'Phone', input: phoneIn }), ui.field({ label: 'Place', input: placeIn })),
      ui.field({ label: 'Notes', input: notesIn }),
      existing ? h('label', { class: 'flex items-center gap-2 text-sm text-stone-700' }, activeIn, 'Active customer (untick to hide from pickers)') : null);

    var save = ui.btn(existing ? 'Save changes' : 'Add customer', { kind: 'primary', type: 'submit', icon: 'check' });
    save.setAttribute('form', formId);
    var m = ui.modal({
      title: existing ? 'Edit customer' : 'New customer', size: 'md', body: form,
      footer: [ui.btn('Cancel', { onClick: function () { m.close(); } }), save],
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = nameIn.value.trim();
      nameField.setError('');
      if (!name) { nameField.setError('Please enter a name.'); nameIn.focus(); return; }
      var body = { name: name, phone: phoneIn.value.trim() || null, place: placeIn.value.trim() || null, notes: notesIn.value.trim() || null };
      if (existing) body.is_active = activeIn.checked;
      save.setBusy(true);
      var req = existing ? App.api.put('/api/customers/' + existing.id, body, { silent: true }) : App.api.post('/api/customers', body, { silent: true });
      req.then(function (c) {
        ui.toast(existing ? 'Customer updated' : 'Customer “' + c.name + '” added');
        m.close();
        if (onSaved) onSaved(c);
      }).catch(function (err) {
        save.setBusy(false);
        if (err.status === 409 || err.code === 'duplicate') { nameField.setError(err.message); nameIn.focus(); }
        else ui.toast(err.message, 'error');
      });
    });
  }

  // ------------------------------------------------------------------ detail
  function infoRow(iconName, label, value) {
    return h('div', { class: 'flex items-start gap-3' },
      h('span', { class: 'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-stone-100 text-stone-500' }, App.icon(iconName, 'h-4 w-4')),
      h('div', { class: 'min-w-0' }, h('p', { class: 'text-xs text-stone-500' }, label), h('div', { class: 'break-words text-sm text-stone-900' }, value)));
  }

  function purchasesTable(purchases) {
    var rows = purchases || [];
    return ui.table({
      rows: rows, empty: 'No purchases recorded for this customer yet.', emptyIcon: 'shopping',
      columns: [
        { key: 'sale_date', label: 'Date', render: function (s) { return h('span', { class: 'whitespace-nowrap' }, fmt.date(s.sale_date)); } },
        { key: 'channel', label: 'Type', class: 'hidden sm:table-cell', render: function (s) { return ui.badge(s.channel === 'wholesale' ? 'Wholesale' : 'Retail', s.channel === 'wholesale' ? 'blue' : 'gray'); } },
        { key: 'items', label: 'Items', render: function (s) {
          return h('div', { class: s.status === 'void' ? 'text-stone-400 line-through' : '' },
            (s.items || []).map(function (it) {
              return h('div', null, h('span', { class: 'font-medium' }, it.rice_type), ' · ' + (it.quantity_label || fmt.qty(it)));
            }));
        } },
        { key: 'payment_mode', label: 'Paid by', render: function (s) {
          return s.status === 'void' ? ui.badge('Void', 'red') : ui.badge((s.payment_mode || '').toUpperCase(), { cash: 'green', upi: 'blue', credit: 'amber' }[s.payment_mode] || 'gray');
        } },
        { key: 'total_amount', label: 'Total', align: 'right', render: function (s) { return h('span', { class: s.status === 'void' ? 'text-stone-400 line-through' : 'font-medium' }, fmt.money(s.total_amount)); } },
      ],
    });
  }

  function openDetail(summary) {
    var body = h('div', null, ui.spinner());
    var m = ui.modal({ title: summary.name, size: 'xl', body: body, backdropClose: true });
    function refresh() {
      return App.api.get('/api/customers/' + summary.id, null, { silent: true }).then(function (d) {
        var c = d.customer;
        m.setTitle(c.name);
        body.innerHTML = '';
        m.footer.innerHTML = '';
        m.footer.classList.add('hidden');
        body.appendChild(h('div', { class: 'space-y-6' },
          h('div', { class: 'grid gap-4 sm:grid-cols-3' },
            infoRow('phone', 'Phone', c.phone ? h('a', { href: telHref(c.phone), class: 'text-primary-700 hover:underline' }, c.phone) : h('span', { class: 'text-stone-400' }, 'Not given')),
            infoRow('home', 'Place', c.place || h('span', { class: 'text-stone-400' }, 'Not given')),
            infoRow('calendar', 'Customer since', c.created_at ? fmt.date(c.created_at) : '—')),
          c.notes ? h('div', { class: 'rounded-lg bg-accent-50 px-4 py-3 text-sm text-accent-900' }, h('span', { class: 'font-medium' }, 'Notes: '), c.notes) : null,
          c.is_active === false ? ui.badge('Inactive customer', 'gray') : null,
          d.credit ? h('div', null,
            h('h3', { class: 'mb-2 text-sm font-semibold uppercase tracking-wide text-stone-500' }, 'Credit'),
            h('div', { class: 'grid grid-cols-3 gap-3' },
              App.components.stat({ label: 'Total credit', value: fmt.money(d.credit.total_credit) }),
              App.components.stat({ label: 'Paid', value: fmt.money(d.credit.total_paid), tone: 'green' }),
              App.components.stat({ label: 'Balance due', value: fmt.money(d.credit.balance), tone: d.credit.balance > 0 ? 'amber' : 'default' }))) : null,
          h('div', null,
            h('h3', { class: 'mb-2 text-sm font-semibold uppercase tracking-wide text-stone-500' }, 'Purchase history'),
            purchasesTable(d.purchases),
            (d.purchases || []).length >= 50 ? h('p', { class: 'mt-2 text-xs text-stone-400' }, 'Showing the latest 50 purchases.') : null)));
        if (canEdit) {
          m.footer.classList.remove('hidden');
          m.footer.appendChild(ui.btn('Edit customer', { icon: 'edit', onClick: function () {
            openForm(c, function () { refresh(); load(); });
          } }));
        }
      }).catch(function (e) {
        body.innerHTML = '';
        body.appendChild(h('div', { class: 'rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800', role: 'alert' }, e.message));
      });
    }
    refresh();
  }

  // ------------------------------------------------------------------ tab
  App.registerTab('customers', {
    init: function (root) {
      rootEl = root;
      listEl = root.querySelector('[data-role=list]');
      searchEl = root.querySelector('[data-role=search]');
      countEl = root.querySelector('[data-role=count]');
      inactiveEl = root.querySelector('[data-role=inactive]');
      canEdit = App.can('customers:edit');
      var addBtn = root.querySelector('[data-role=add]');
      if (canEdit) {
        addBtn.classList.remove('hidden'); addBtn.classList.add('inline-flex');
        var wrap = root.querySelector('[data-role=inactive-wrap]');
        wrap.classList.remove('hidden'); wrap.classList.add('inline-flex');
        addBtn.addEventListener('click', function () { openForm(null, function () { load(); }); });
        inactiveEl.addEventListener('change', function () { loaded = false; renderList(); load(); });
      }
      searchEl.addEventListener('input', renderList);
    },
    show: function () {
      if (!loaded) renderList();
      load();
    },
  });
})();

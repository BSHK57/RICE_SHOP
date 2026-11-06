/*
 * tabs/inventory.js - stock table + dialogs (add rice type, receive stock, adjust, open bag, edit prices, history).
 * API: /api/inventory/rice-types[/<name>[/receive|adjust|open-bag]], /api/inventory/movements (docs/DESIGN.md 5.3).
 * Quantities travel as integer grams; the forms use kg and convert with App.fmt.kgToGrams (string maths).
 * Edit controls render only when App.can('inventory:edit'). The purchase-cost column renders only when the API sent
 * that field (it is omitted for users without original:view / inventory:edit).
 */
(function () {
  'use strict';
  var App = window.App;
  var ui = App.ui;
  var h = ui.h;
  var fmt = App.fmt;

  var listEl, inactiveEl;
  var items = [];
  var loaded = false;
  var seq = 0;
  var canEdit = false;

  var KIND_LABEL = { create: 'Created', receive: 'Stock received', adjust: 'Adjusted', open_bag: 'Bag opened', sale: 'Sold', sale_void: 'Sale cancelled' };
  var HELP_LOOSE = 'Loose rice that adds up to a full bag is sold as a bag; when loose rice runs out, a bag is opened automatically.';

  function encName(n) { return encodeURIComponent(n); }
  function isLow(r) { return r.low_stock_bags > 0 && r.bags_qty <= r.low_stock_bags; }
  function signed(n, unit) { return (n > 0 ? '+' : (n < 0 ? '−' : '')) + Math.abs(n) + unit; }
  function signedKg(g) { return g === 0 ? '0 g' : (g > 0 ? '+' : '−') + fmt.kg(Math.abs(g)); }

  // ---- form input readers: throw Error(message) on invalid input, return null when blank and optional ----
  function readMoney(el, label, required) {
    var v = el.value.trim();
    if (v === '') { if (required) throw new Error(label + ' is required.'); return null; }
    var n = Number(v);
    if (!isFinite(n) || n < 0) throw new Error(label + ' must be a number (0 or more).');
    return n;
  }
  function readKg(el, label, required) {
    var v = el.value.trim();
    if (v === '') { if (required) throw new Error(label + ' is required.'); return null; }
    var g = fmt.kgToGrams(v);
    if (!isFinite(g) || g < 0) throw new Error(label + ' must be a number of kg (0 or more).');
    return g;
  }
  function readInt(el, label, opts) {
    opts = opts || {};
    var v = el.value.trim();
    if (v === '') { if (opts.required) throw new Error(label + ' is required.'); return opts.blank === undefined ? null : opts.blank; }
    var n = Number(v);
    if (!Number.isInteger(n) || (!opts.signed && n < 0)) throw new Error(label + ' must be a whole number' + (opts.signed ? '.' : ' (0 or more).'));
    return n;
  }
  function numIn(attrs) { return ui.input(Object.assign({ type: 'number', step: 'any', min: 0, inputmode: 'decimal' }, attrs || {})); }
  function intIn(attrs) { return ui.input(Object.assign({ type: 'number', step: 1, min: 0, inputmode: 'numeric' }, attrs || {})); }

  function formModal(o) {
    var formId = ui.uid('inv-form');
    var errBox = h('p', { class: 'hidden rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700', role: 'alert' });
    var form = h('form', { id: formId, novalidate: true, class: 'space-y-4' }, o.intro || null, o.content, errBox);
    var save = ui.btn(o.submitText || 'Save', { kind: 'primary', type: 'submit', icon: 'check' });
    save.setAttribute('form', formId);
    var m = ui.modal({
      title: o.title, size: o.size || 'md', body: form,
      footer: [ui.btn('Cancel', { onClick: function () { m.close(); } }), save],
    });
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

  function stockLine(r) {
    return h('div', { class: 'rounded-lg bg-stone-50 px-4 py-3 text-sm text-stone-600' },
      h('span', { class: 'font-medium text-stone-900' }, r.type_name), ' — in stock now: ',
      h('b', null, r.bags_qty + (r.bags_qty === 1 ? ' bag' : ' bags') + (r.bag_size_grams ? ' of ' + fmt.kg(r.bag_size_grams) : '')),
      ' and ', h('b', null, fmt.kg(r.loose_grams) + ' loose'), '.');
  }

  // ------------------------------------------------------------------ dialogs
  function openAdd() {
    var name = ui.input({ type: 'text', maxlength: 100, placeholder: 'e.g. Sona Masoori 25kg' });
    var price = numIn({ placeholder: 'e.g. 62' });
    var bagPrice = numIn({ placeholder: 'Leave blank if not sold in bags' });
    var bagSize = numIn({ placeholder: 'e.g. 25' });
    var cost = numIn({ placeholder: 'Optional' });
    var bags = intIn({ placeholder: '0' });
    var loose = numIn({ placeholder: '0' });
    var low = intIn({ placeholder: '0 = no alert' });
    formModal({
      title: 'Add rice type', size: 'lg', submitText: 'Add rice type',
      content: h('div', { class: 'space-y-4' },
        ui.field({ label: 'Rice type name', input: name, required: true, hint: 'The name is the identifier, so keep it unique.' }),
        h('div', { class: 'grid gap-4 sm:grid-cols-2' },
          ui.field({ label: 'Price per kg (₹)', input: price, required: true }),
          ui.field({ label: 'Bag price (₹)', input: bagPrice, hint: 'Blank means this rice is not sold by the bag.' }),
          ui.field({ label: 'Bag size (kg)', input: bagSize, hint: 'Usually 18, 20, 25 or 26.' }),
          ui.field({ label: 'Purchase cost per kg (₹)', input: cost })),
        h('fieldset', { class: 'rounded-lg border border-stone-200 p-4' },
          h('legend', { class: 'px-1 text-sm font-medium text-stone-700' }, 'Opening stock (optional)'),
          h('div', { class: 'grid gap-4 sm:grid-cols-3' },
            ui.field({ label: 'Bags', input: bags }),
            ui.field({ label: 'Loose (kg)', input: loose }),
            ui.field({ label: 'Low-stock alert at (bags)', input: low })),
          h('p', { class: 'mt-3 text-xs text-stone-500' }, HELP_LOOSE))),
      onSubmit: function () {
        var nm = name.value.trim();
        if (!nm) throw new Error('Rice type name is required.');
        var body = {
          type_name: nm,
          price_per_kg: readMoney(price, 'Price per kg', true),
          bag_price: readMoney(bagPrice, 'Bag price'),
          bag_size_grams: readKg(bagSize, 'Bag size'),
          purchase_cost_per_kg: readMoney(cost, 'Purchase cost'),
          bags_qty: readInt(bags, 'Bags', { blank: 0 }),
          loose_grams: readKg(loose, 'Loose kg') || 0,
          low_stock_bags: readInt(low, 'Low-stock alert', { blank: 0 }),
        };
        if (body.bags_qty > 0 && !body.bag_size_grams) throw new Error('Enter the bag size when you add bags.');
        return App.api.post('/api/inventory/rice-types', body, { silent: true }).then(function () { ui.toast('“' + nm + '” added'); });
      },
    });
  }

  function openReceive(r) {
    var bags = intIn({ placeholder: '0' });
    var size = numIn({ value: r.bag_size_grams ? fmt.gramsToKg(r.bag_size_grams) : '', placeholder: 'kg per bag' });
    var loose = numIn({ placeholder: '0' });
    var price = numIn({ value: r.price_per_kg });
    var bagPrice = numIn({ value: r.bag_price === null || r.bag_price === undefined ? '' : r.bag_price });
    var cost = canEdit && r.purchase_cost_per_kg !== undefined ? numIn({ value: r.purchase_cost_per_kg === null ? '' : r.purchase_cost_per_kg }) : null;
    var note = ui.input({ type: 'text', maxlength: 200, placeholder: 'e.g. Lorry from Guntur, bill 1234' });
    var changePrice = h('input', { type: 'checkbox', class: 'h-4 w-4 rounded border-stone-300 text-primary-600 focus:ring-primary-500' });
    var priceBox = h('div', { class: 'hidden grid gap-4 sm:grid-cols-3' },
      ui.field({ label: 'Price per kg (₹)', input: price }), ui.field({ label: 'Bag price (₹)', input: bagPrice }),
      cost ? ui.field({ label: 'Purchase cost per kg (₹)', input: cost }) : null);
    changePrice.addEventListener('change', function () { priceBox.classList.toggle('hidden', !changePrice.checked); });
    formModal({
      title: 'Receive stock — ' + r.type_name, size: 'lg', submitText: 'Add to stock',
      intro: stockLine(r),
      content: h('div', { class: 'space-y-4' },
        h('div', { class: 'grid gap-4 sm:grid-cols-3' },
          ui.field({ label: 'New bags', input: bags }),
          ui.field({ label: 'Bag size (kg)', input: size, hint: r.bags_qty > 0 ? 'Cannot change while bags are in stock.' : 'Set when the stock arrives.' }),
          ui.field({ label: 'Loose rice (kg)', input: loose })),
        h('p', { class: 'text-xs text-stone-500' }, HELP_LOOSE),
        h('label', { class: 'flex items-center gap-2 text-sm text-stone-700' }, changePrice, 'Prices changed with this delivery'),
        priceBox,
        ui.field({ label: 'Note', input: note, hint: 'Optional, shown in the stock history.' })),
      onSubmit: function () {
        var nb = readInt(bags, 'New bags', { blank: 0 });
        var lg = readKg(loose, 'Loose kg') || 0;
        if (nb <= 0 && lg <= 0) throw new Error('Enter the number of bags or the loose kg received.');
        var sz = readKg(size, 'Bag size');
        if (nb > 0 && !sz) throw new Error('Enter the bag size for the new bags.');
        var body = { bags: nb, loose_grams: lg, note: note.value.trim() || null };
        if (sz) body.bag_size_grams = sz;
        if (changePrice.checked) {
          body.price_per_kg = readMoney(price, 'Price per kg', true);
          body.bag_price = readMoney(bagPrice, 'Bag price');
          if (cost) body.purchase_cost_per_kg = readMoney(cost, 'Purchase cost');
        }
        return App.api.post('/api/inventory/rice-types/' + encName(r.type_name) + '/receive', body, { silent: true })
          .then(function () { ui.toast('Stock added to ' + r.type_name); });
      },
    });
  }

  function openAdjust(r) {
    var bags = ui.input({ type: 'number', step: 1, inputmode: 'numeric', placeholder: '0, e.g. -2 or 3' });
    var loose = ui.input({ type: 'number', step: 'any', inputmode: 'decimal', placeholder: '0, e.g. -1.5 or 2' });
    var note = ui.input({ type: 'text', maxlength: 200, placeholder: 'e.g. Stock-take on Sunday' });
    var preview = h('p', { class: 'text-sm text-stone-600' });
    function upd() {
      var db = Number(bags.value) || 0;
      var dg = fmt.kgToGrams(loose.value);
      if (!isFinite(dg)) dg = 0;
      var nb = r.bags_qty + (Number.isInteger(db) ? db : 0);
      var ng = r.loose_grams + dg;
      var bad = nb < 0 || ng < 0;
      preview.className = 'text-sm ' + (bad ? 'text-red-600' : 'text-stone-600');
      preview.textContent = 'Stock after this change: ' + nb + (nb === 1 ? ' bag' : ' bags') + ' and ' + fmt.kg(ng) + ' loose' + (bad ? ' (cannot be negative)' : '') + '.';
    }
    bags.addEventListener('input', upd); loose.addEventListener('input', upd); upd();
    formModal({
      title: 'Adjust stock — ' + r.type_name, submitText: 'Save adjustment',
      intro: stockLine(r),
      content: h('div', { class: 'space-y-4' },
        h('p', { class: 'text-sm text-stone-500' }, 'Use this after counting the shop: enter how much to add (+) or remove (−) so the system matches what is on the shelf.'),
        h('div', { class: 'grid gap-4 sm:grid-cols-2' },
          ui.field({ label: 'Bags (+ / −)', input: bags }), ui.field({ label: 'Loose kg (+ / −)', input: loose })),
        preview,
        ui.field({ label: 'Reason', input: note, required: true, hint: 'Required, kept in the stock history.' })),
      onSubmit: function () {
        var db = readInt(bags, 'Bags', { signed: true, blank: 0 });
        var dg = loose.value.trim() === '' ? 0 : fmt.kgToGrams(loose.value);
        if (!isFinite(dg)) throw new Error('Loose kg must be a number.');
        if (db === 0 && dg === 0) throw new Error('Enter how many bags or kg to add or remove.');
        if (r.bags_qty + db < 0 || r.loose_grams + dg < 0) throw new Error('Stock cannot go below zero.');
        var nt = note.value.trim();
        if (!nt) throw new Error('Please give a reason for the adjustment.');
        return App.api.post('/api/inventory/rice-types/' + encName(r.type_name) + '/adjust', { bags_delta: db, loose_grams_delta: dg, note: nt }, { silent: true })
          .then(function () { ui.toast('Stock adjusted'); });
      },
    });
  }

  function openBag(r) {
    var count = intIn({ value: 1, min: 1, max: r.bags_qty });
    formModal({
      title: 'Open a bag — ' + r.type_name, size: 'sm', submitText: 'Open bag',
      intro: stockLine(r),
      content: h('div', { class: 'space-y-3' },
        ui.field({ label: 'Bags to open', input: count, hint: r.bag_size_grams ? 'Each bag adds ' + fmt.kg(r.bag_size_grams) + ' to the loose stock.' : '' }),
        h('p', { class: 'text-xs text-stone-500' }, 'Bags also open on their own when a loose sale needs more than the loose rice you have.')),
      onSubmit: function () {
        var n = readInt(count, 'Bags to open', { required: true });
        if (n < 1) throw new Error('Open at least one bag.');
        if (n > r.bags_qty) throw new Error('Only ' + r.bags_qty + ' bag(s) in stock.');
        return App.api.post('/api/inventory/rice-types/' + encName(r.type_name) + '/open-bag', { count: n }, { silent: true })
          .then(function () { ui.toast(n + (n === 1 ? ' bag opened' : ' bags opened')); });
      },
    });
  }

  function openPrices(r) {
    var price = numIn({ value: r.price_per_kg });
    var bagPrice = numIn({ value: r.bag_price === null || r.bag_price === undefined ? '' : r.bag_price, placeholder: 'Blank = not sold in bags' });
    var size = numIn({ value: r.bag_size_grams ? fmt.gramsToKg(r.bag_size_grams) : '', disabled: r.bags_qty > 0 });
    var cost = r.purchase_cost_per_kg !== undefined ? numIn({ value: r.purchase_cost_per_kg === null ? '' : r.purchase_cost_per_kg }) : null;
    var low = intIn({ value: r.low_stock_bags || 0 });
    var active = h('input', { type: 'checkbox', checked: r.is_active !== false, class: 'h-4 w-4 rounded border-stone-300 text-primary-600 focus:ring-primary-500' });
    formModal({
      title: 'Edit — ' + r.type_name, size: 'lg', submitText: 'Save changes',
      content: h('div', { class: 'space-y-4' },
        h('div', { class: 'grid gap-4 sm:grid-cols-2' },
          ui.field({ label: 'Price per kg (₹)', input: price, required: true }),
          ui.field({ label: 'Bag price (₹)', input: bagPrice, hint: 'Blank means not sold by the bag.' }),
          ui.field({ label: 'Bag size (kg)', input: size, hint: r.bags_qty > 0 ? 'Locked while bags are in stock (sell or adjust them first).' : 'Can change because no bags are in stock.' }),
          cost ? ui.field({ label: 'Purchase cost per kg (₹)', input: cost }) : null,
          ui.field({ label: 'Low-stock alert at (bags)', input: low, hint: '0 turns the alert off.' })),
        h('label', { class: 'flex items-center gap-2 text-sm text-stone-700' }, active, 'Active (untick to stop offering this rice in new sales)')),
      onSubmit: function () {
        var body = {
          price_per_kg: readMoney(price, 'Price per kg', true),
          bag_price: readMoney(bagPrice, 'Bag price'),
          low_stock_bags: readInt(low, 'Low-stock alert', { blank: 0 }),
          is_active: active.checked,
        };
        if (!size.disabled) body.bag_size_grams = readKg(size, 'Bag size');
        if (body.bag_price !== null && !(size.disabled ? r.bag_size_grams : body.bag_size_grams)) throw new Error('Enter a bag size to sell this rice by the bag.');
        if (cost) body.purchase_cost_per_kg = readMoney(cost, 'Purchase cost');
        return App.api.put('/api/inventory/rice-types/' + encName(r.type_name), body, { silent: true }).then(function () { ui.toast('Saved'); });
      },
    });
  }

  function openHistory(r) {
    var body = h('div', null, ui.spinner());
    ui.modal({ title: 'Stock history — ' + r.type_name, size: 'xl', body: body, backdropClose: true });
    App.api.get('/api/inventory/movements', { type_name: r.type_name, limit: 100 }, { silent: true }).then(function (rows) {
      body.innerHTML = '';
      body.appendChild(ui.table({
        rows: rows || [], empty: 'No stock movements recorded yet.', emptyIcon: 'history',
        columns: [
          { key: 'moved_at', label: 'When', render: function (m) { return h('span', { class: 'whitespace-nowrap' }, fmt.dateTime(m.moved_at)); } },
          { key: 'kind', label: 'What', render: function (m) { return ui.badge(KIND_LABEL[m.kind] || m.kind, m.kind === 'sale' ? 'blue' : (m.kind === 'receive' || m.kind === 'create' ? 'green' : (m.kind === 'adjust' ? 'amber' : 'gray'))); } },
          { key: 'delta_bags', label: 'Bags', align: 'right', render: function (m) { return m.delta_bags ? signed(m.delta_bags, '') : '—'; } },
          { key: 'delta_loose_grams', label: 'Loose', align: 'right', render: function (m) { return m.delta_loose_grams ? signedKg(m.delta_loose_grams) : '—'; } },
          { key: 'after', label: 'Stock after', align: 'right', class: 'hidden sm:table-cell', render: function (m) { return m.bags_after + (m.bags_after === 1 ? ' bag' : ' bags') + ' + ' + fmt.kg(m.loose_after); } },
          { key: 'note', label: 'Note', class: 'hidden md:table-cell', render: function (m) { return m.note || ''; } },
          { key: 'created_by', label: 'By', class: 'hidden md:table-cell', render: function (m) { return m.created_by || ''; } },
        ],
      }));
      if ((rows || []).length >= 100) body.appendChild(h('p', { class: 'mt-2 text-xs text-stone-400' }, 'Showing the latest 100 movements.'));
    }).catch(function (e) {
      body.innerHTML = '';
      body.appendChild(h('div', { class: 'rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800', role: 'alert' }, e.message));
    });
  }

  function actionButtons(r) {
    var b = [];
    if (canEdit) {
      b.push(ui.btn('Receive', { small: true, kind: 'primary', icon: 'plus', onClick: function () { openReceive(r); }, title: 'Receive new stock' }));
      b.push(ui.btn('Adjust', { small: true, onClick: function () { openAdjust(r); }, title: 'Correct the stock after counting' }));
      b.push(ui.btn('Open bag', { small: true, disabled: r.bags_qty < 1, onClick: function () { openBag(r); }, title: 'Turn a bag into loose rice' }));
      b.push(ui.btn('Prices', { small: true, icon: 'edit', onClick: function () { openPrices(r); }, title: 'Edit prices, bag size and alert level' }));
    }
    b.push(ui.btn('History', { small: true, kind: 'ghost', icon: 'history', onClick: function () { openHistory(r); } }));
    return h('div', { class: 'flex min-w-[17rem] flex-wrap justify-end gap-1.5' }, b);
  }

  // ------------------------------------------------------------------ table
  function renderList() {
    listEl.innerHTML = '';
    if (!loaded) { listEl.appendChild(ui.spinner()); return; }
    var hasCost = items.some(function (r) { return 'purchase_cost_per_kg' in r; });
    var cols = [
      { key: 'type_name', label: 'Rice type', class: 'min-w-[8rem]', render: function (r) {
        return h('div', null, h('span', { class: 'font-medium text-stone-900' }, r.type_name),
          h('div', { class: 'mt-0.5 flex flex-wrap gap-1' }, statusBadges(r)),
          h('div', { class: 'mt-2 md:hidden [&>div]:min-w-0 [&>div]:justify-start' }, actionButtons(r)));
      } },
      { key: 'price_per_kg', label: 'Price / kg', align: 'right', render: function (r) { return fmt.money(r.price_per_kg); } },
      { key: 'bag_price', label: 'Bag price', align: 'right', render: function (r) { return r.bag_price === null || r.bag_price === undefined ? h('span', { class: 'text-stone-300' }, '—') : fmt.money(r.bag_price); } },
      { key: 'bag_size_grams', label: 'Bag size', align: 'right', class: 'hidden sm:table-cell', render: function (r) { return r.bag_size_grams ? fmt.kg(r.bag_size_grams) : h('span', { class: 'text-stone-300' }, '—'); } },
    ];
    if (hasCost) cols.push({ key: 'purchase_cost_per_kg', label: 'Cost / kg', align: 'right', class: 'hidden md:table-cell', render: function (r) { return r.purchase_cost_per_kg === null || r.purchase_cost_per_kg === undefined ? h('span', { class: 'text-stone-300' }, '—') : fmt.money(r.purchase_cost_per_kg); } });
    cols.push(
      { key: 'bags_qty', label: 'Bags', align: 'right', render: function (r) { return h('span', { class: 'font-semibold ' + (isLow(r) ? 'text-amber-700' : '') }, r.bags_qty); } },
      { key: 'loose_grams', label: 'Loose', align: 'right', render: function (r) { return fmt.kg(r.loose_grams); } },
      { key: '_actions', label: '', class: 'hidden md:table-cell', render: function (r) { return actionButtons(r); } },
    );
    listEl.appendChild(ui.table({
      columns: cols, rows: items, emptyIcon: 'box',
      empty: canEdit ? 'No rice types yet. Use “Add rice type” to set up your first one.' : 'No rice types have been added yet.',
      rowClass: function (r) { return isLow(r) ? 'bg-amber-50/60' : (r.is_active === false ? 'opacity-60' : ''); },
    }));
  }

  function statusBadges(r) {
    var badges = [];
    if (r.is_active === false) badges.push(ui.badge('Inactive', 'gray'));
    if (r.bags_qty === 0 && r.loose_grams === 0) badges.push(ui.badge('Out of stock', 'red'));
    else if (isLow(r)) badges.push(ui.badge('Low stock', 'amber'));
    return badges;
  }

  function load() {
    var mine = ++seq;
    var inc = canEdit && inactiveEl.checked ? 1 : 0;
    return App.api.get('/api/inventory/rice-types', { include_inactive: inc }, { silent: true }).then(function (list) {
      if (mine !== seq) return;
      items = list || [];
      loaded = true;
      renderList();
    }).catch(function (e) {
      if (mine !== seq) return;
      loaded = true;
      listEl.innerHTML = '';
      listEl.appendChild(h('div', { class: 'rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800', role: 'alert' },
        h('p', { class: 'font-semibold' }, 'Stock could not be loaded.'), h('p', { class: 'mt-1' }, e.message),
        ui.btn('Try again', { small: true, class: 'mt-3', onClick: function () { loaded = false; renderList(); load(); } })));
    });
  }

  App.registerTab('inventory', {
    init: function (root) {
      listEl = root.querySelector('[data-role=list]');
      inactiveEl = root.querySelector('[data-role=inactive]');
      canEdit = App.can('inventory:edit');
      if (canEdit) {
        var add = root.querySelector('[data-role=add]');
        add.classList.remove('hidden'); add.classList.add('inline-flex');
        add.addEventListener('click', openAdd);
        var wrap = root.querySelector('[data-role=inactive-wrap]');
        wrap.classList.remove('hidden'); wrap.classList.add('inline-flex');
        inactiveEl.addEventListener('change', function () { loaded = false; renderList(); load(); });
      }
    },
    show: function () {
      if (!loaded) renderList();
      load();
    },
  });
})();

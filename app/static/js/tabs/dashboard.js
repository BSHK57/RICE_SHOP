/*
 * tabs/dashboard.js - landing page: today's sales, credit position, pending reminders, low stock, recent sales.
 * Data: GET /api/dashboard (widgets the user may not see are null and are simply not rendered).
 * Amounts arrive already masked by the server; nothing is computed here except display formatting.
 */
(function () {
  'use strict';
  var App = window.App;
  var h = App.ui.h;
  var fmt = App.fmt;
  var loadedOnce = false;
  var seq = 0;

  function greeting() {
    var hr = new Date().getHours();
    var part = hr < 12 ? 'Good morning' : (hr < 17 ? 'Good afternoon' : 'Good evening');
    return part + ', ' + (App.user.display_name || App.user.username);
  }

  function section(title, body, action) {
    return h('section', null,
      h('div', { class: 'mb-2 flex items-center justify-between gap-2' },
        h('h3', { class: 'text-sm font-semibold uppercase tracking-wide text-stone-500' }, title), action || null),
      body);
  }

  function grid(children, cols) {
    return h('div', { class: 'grid grid-cols-2 gap-3 ' + (cols || 'lg:grid-cols-4') }, children);
  }

  function channelStats(c, label) {
    return section(label, grid([
      App.components.stat({ label: 'Total', value: fmt.money(c.total), sub: c.count + (c.count === 1 ? ' sale' : ' sales'), tone: 'green', icon: 'rupee' }),
      App.components.stat({ label: 'Cash', value: fmt.money(c.cash) }),
      App.components.stat({ label: 'UPI', value: fmt.money(c.upi), tone: 'blue' }),
      App.components.stat({ label: 'On credit', value: fmt.money(c.credit), tone: c.credit > 0 ? 'amber' : 'default' }),
    ]));
  }

  function canOpen(id) { return App.tabs.some(function (t) { return t.id === id; }); }

  function openTabBtn(label, id) {
    if (!canOpen(id)) return null;
    return App.ui.btn(label, { kind: 'ghost', small: true, onClick: function () { App.showTab(id); } });
  }

  function creditsBlock(c) {
    var cards = [
      App.components.stat({ label: 'Outstanding credit', value: fmt.money(c.outstanding), tone: c.outstanding > 0 ? 'amber' : 'default', icon: 'ledger' }),
      App.components.stat({ label: 'Overdue', value: fmt.money(c.overdue_total), tone: c.overdue_total > 0 ? 'red' : 'default',
        sub: c.overdue_count ? c.overdue_count + (c.overdue_count === 1 ? ' entry' : ' entries') + ' past due date' : 'Nothing overdue', icon: 'alert' }),
    ];
    if (c.due_today !== undefined && c.due_today !== null) {
      cards.push(App.components.stat({ label: 'Due today', value: fmt.money(c.due_today), tone: c.due_today > 0 ? 'amber' : 'default', icon: 'calendar' }));
    }
    return section('Credit', grid(cards, 'lg:grid-cols-3'), openTabBtn('Open credits', 'credits'));
  }

  function ordersBlock(o) {
    var overdueTxt = o.overdue ? o.overdue + ' overdue' : 'None overdue';
    var cards = [
      App.components.stat({
        label: 'Pending deliveries', value: o.pending, tone: o.pending > 0 ? 'amber' : 'default', icon: 'clock',
        sub: overdueTxt,
        onClick: canOpen('reminders') ? function () { App.showTab('reminders'); } : null,
      }),
    ];
    if (o.overdue) cards.push(App.components.stat({ label: 'Overdue deliveries', value: o.overdue, tone: 'red', icon: 'alert',
      onClick: canOpen('reminders') ? function () { App.showTab('reminders'); } : null }));
    return section('Reminders', grid(cards, 'lg:grid-cols-4'), openTabBtn('Open reminders', 'reminders'));
  }

  function lowStockBlock(list) {
    var body;
    if (!list.length) {
      body = h('div', { class: 'flex items-center gap-3 rounded-xl border border-stone-200 bg-white p-4 text-sm text-stone-600' },
        h('span', { class: 'flex h-8 w-8 items-center justify-center rounded-full bg-emerald-100 text-emerald-700' }, App.icon('check', 'h-4 w-4')),
        'All rice types are above their low-stock level.');
    } else {
      body = h('ul', { class: 'divide-y divide-stone-100 overflow-hidden rounded-xl border border-amber-200 bg-white shadow-sm' }, list.map(function (r) {
        return h('li', { class: 'flex items-center justify-between gap-3 px-4 py-3' },
          h('div', { class: 'min-w-0' },
            h('p', { class: 'truncate text-sm font-medium text-stone-900' }, r.type_name),
            h('p', { class: 'text-xs text-stone-500' }, 'Alert at ' + r.low_stock_bags + (r.low_stock_bags === 1 ? ' bag' : ' bags') + ' or fewer')),
          h('div', { class: 'shrink-0 text-right' },
            App.ui.badge(r.bags_qty + (r.bags_qty === 1 ? ' bag' : ' bags') + ' left', r.bags_qty === 0 ? 'red' : 'amber'),
            h('p', { class: 'mt-0.5 text-xs text-stone-500' }, '+ ' + fmt.kg(r.loose_grams) + ' loose')));
      }));
    }
    return section('Low stock', body, openTabBtn('Open inventory', 'inventory'));
  }

  var PAY_TONE = { cash: 'green', upi: 'blue', credit: 'amber' };

  function recentBlock(rows) {
    var cols = [
      { key: 'created_at', label: 'When', render: function (r) { return h('span', { class: 'whitespace-nowrap text-stone-600' }, fmt.dateTime(r.created_at || r.sale_date)); } },
      { key: 'customer_name', label: 'Customer', render: function (r) { return r.customer_name || h('span', { class: 'text-stone-400' }, 'Walk-in'); } },
      { key: 'rice_type', label: 'Rice', render: function (r) { return r.rice_type || '—'; } },
      { key: 'qty', label: 'Quantity', render: function (r) { return r.quantity_label || fmt.qty(r); } },
      { key: 'channel', label: 'Type', render: function (r) { return App.ui.badge(r.channel === 'wholesale' ? 'Wholesale' : 'Retail', r.channel === 'wholesale' ? 'blue' : 'gray'); } },
      { key: 'payment_mode', label: 'Paid by', render: function (r) { return App.ui.badge((r.payment_mode || '').toUpperCase(), PAY_TONE[r.payment_mode] || 'gray'); } },
      { key: 'amount', label: 'Amount', align: 'right', render: function (r) { return fmt.money(r.amount); } },
    ];
    return section('Recent sales', App.ui.table({ columns: cols, rows: rows, empty: 'No sales recorded yet today.', emptyIcon: 'shopping' }));
  }

  function skeleton() {
    var cards = [];
    for (var i = 0; i < 4; i++) cards.push(h('div', { class: 'skeleton h-24' }));
    return h('div', { class: 'space-y-6' }, grid(cards), h('div', { class: 'skeleton h-48' }));
  }

  function render(content, d) {
    content.innerHTML = '';
    var any = false;
    var t = d.today || {};
    if (t.retail) { content.appendChild(channelStats(t.retail, "Today's retail sales")); any = true; }
    if (t.wholesale) { content.appendChild(channelStats(t.wholesale, "Today's wholesale sales")); any = true; }
    if (d.credits) { content.appendChild(creditsBlock(d.credits)); any = true; }
    if (d.orders) { content.appendChild(ordersBlock(d.orders)); any = true; }
    if (d.low_stock) { content.appendChild(lowStockBlock(d.low_stock)); any = true; }
    if (d.recent_sales) { content.appendChild(recentBlock(d.recent_sales)); any = true; }
    if (!any) content.appendChild(App.ui.empty('Nothing to show on the dashboard for your account yet.', 'home'));
  }

  function load(root) {
    var content = root.querySelector('[data-role=content]');
    var mine = ++seq;
    if (!loadedOnce) { content.innerHTML = ''; content.appendChild(skeleton()); }
    root.querySelector('[data-role=greeting]').textContent = greeting();
    root.querySelector('[data-role=today]').textContent = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    return App.api.get('/api/dashboard', null, { silent: true }).then(function (d) {
      if (mine !== seq) return;
      loadedOnce = true;
      render(content, d || {});
    }).catch(function (e) {
      if (mine !== seq) return;
      content.innerHTML = '';
      content.appendChild(h('div', { class: 'rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800', role: 'alert' },
        h('p', { class: 'font-semibold' }, 'The dashboard could not be loaded.'),
        h('p', { class: 'mt-1' }, e.message),
        App.ui.btn('Try again', { kind: 'secondary', small: true, class: 'mt-3', onClick: function () { load(root); } })));
    });
  }

  App.registerTab('dashboard', {
    init: function (root) {
      var btn = root.querySelector('[data-role=refresh]');
      btn.addEventListener('click', function () {
        btn.disabled = true;
        load(root).then(function () { btn.disabled = false; App.ui.toast('Dashboard refreshed', 'info'); });
      });
    },
    show: function (root) { load(root); },
  });
})();

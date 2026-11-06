/*
 * tabs/wholesale.js — Wholesale tab (wholesale:view; 'New wholesale sale' needs wholesale:edit;
 * 'Void' needs sales:void).
 *
 * Filters: date range (default last 30 days) + customer -> GET /api/sales/wholesale?from&to&customer_id.
 * Table of sale headers (date sent, call received, customer, items, total, payment, credit info) with
 * totals cards. Row click opens the sale detail. The form (incl. 'Send later' -> reminder) is App.saleForm.
 */
(function () {
  'use strict';
  const h = (...a) => App.ui.h(...a);
  const K = () => App.salekit;

  let els = null;
  let seq = 0;

  function init(root) {
    const host = root.querySelector('[data-tab-root]') || root;
    const today = App.fmt.today();
    const range = App.components.dateRange({ from: K().addDays(today, -30), to: today, onChange: () => load() });
    const cust = App.components.customerPicker({ allowCreate: false, onChange: () => load() });
    const newBtn = App.can('wholesale:edit')
      ? App.ui.btn('New wholesale sale', { kind: 'primary', icon: 'plus', onClick: () => App.saleForm.open({ channel: 'wholesale', mode: 'sale' }) })
      : null;
    if (newBtn) newBtn.classList.add('min-h-[48px]', 'px-5', 'text-base');
    els = { range, cust, stats: h('div', {}), list: h('div', {}), sub: h('span', {}) };
    host.replaceChildren(
      K().tabHeader('Wholesale sales', els.sub, newBtn),
      h('div', { class: 'flex flex-wrap items-end gap-3' },
        range.el,
        h('div', { class: 'min-w-[14rem] flex-1 max-w-sm' }, App.ui.field({ label: 'Customer', input: cust.el }))),
      els.stats,
      K().sectionCard(null, els.list));
  }

  function show() { load(); }

  function columns() {
    const cols = [
      { key: 'sent_on', label: 'Date sent', render: (s) => h('span', { class: 'tabular-nums whitespace-nowrap' }, App.fmt.date(s.sent_on || s.sale_date)) },
      { key: 'call_received_on', label: 'Call received', render: (s) => s.call_received_on ? h('span', { class: 'tabular-nums whitespace-nowrap text-stone-500' }, App.fmt.date(s.call_received_on)) : '—' },
      { key: 'customer_name', label: 'Customer', render: (s) => h('span', { class: 'font-medium' }, s.customer_name || '—') },
      { key: 'items', label: 'Items', render: (s) => h('span', { class: 'text-sm text-stone-700' }, K().itemsSummary(s.items)) },
      { key: 'total_amount', label: 'Total', align: 'right', render: (s) => h('span', { class: 'font-semibold tabular-nums' }, App.fmt.money(s.total_amount)) },
      { key: 'payment_mode', label: 'Payment', render: (s) => K().payBadge(s.payment_mode) },
      {
        key: 'credit_amount', label: 'Credit', align: 'right',
        render: (s) => s.payment_mode !== 'credit' ? '—' : h('div', { class: 'text-right tabular-nums text-sm' },
          h('div', { class: 'font-semibold text-amber-700' }, App.fmt.money(s.credit_amount || 0)),
          s.paid_amount ? h('div', { class: 'text-xs text-stone-500' }, 'Advance ' + App.fmt.money(s.paid_amount)) : null),
      },
    ];
    if (App.can('sales:void')) {
      cols.push({
        key: '_act', label: '', align: 'right',
        render: (s) => {
          const b = App.ui.btn('Void', { kind: 'ghost', small: true, icon: 'trash', onClick: () => K().voidSale(s, load) });
          b.addEventListener('click', (e) => e.stopPropagation());
          return b;
        },
      });
    }
    return cols;
  }

  async function load() {
    if (!els) return;
    const my = ++seq;
    const r = els.range.get();
    els.list.replaceChildren(App.ui.spinner());
    let d;
    try {
      d = await App.api.get('/api/sales/wholesale', { from: r.from, to: r.to, customer_id: els.cust.getId() || null });
    } catch (e) {
      if (my === seq) els.list.replaceChildren(App.ui.empty(e.message || 'Could not load wholesale sales', 'alert'));
      return;
    }
    if (my !== seq) return;
    const t = d.totals || {};
    els.sub.textContent = r.from && r.to ? `${App.fmt.date(r.from)} – ${App.fmt.date(r.to)}` : '';
    els.stats.replaceChildren(K().statsRow([
      { label: 'Total', value: App.fmt.money(t.total || 0), sub: `${t.count || 0} sale${t.count === 1 ? '' : 's'}`, tone: 'green' },
      { label: 'Bags', value: String(t.bags || 0) },
      { label: 'Cash', value: App.fmt.money(t.cash || 0) },
      { label: 'UPI', value: App.fmt.money(t.upi || 0) },
      { label: 'Credit', value: App.fmt.money(t.credit || 0), tone: t.credit ? 'amber' : undefined },
    ]));
    els.list.replaceChildren(K().scrollWrap(App.ui.table({
      columns: columns(),
      rows: d.sales || [],
      empty: 'No wholesale sales in this period',
      onRowClick: (s) => K().openSale(s.id, { onChanged: load }),
    })));
  }

  App.registerTab('wholesale', { init, show });
})();

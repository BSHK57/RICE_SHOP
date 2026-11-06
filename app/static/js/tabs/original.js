/*
 * tabs/original.js — Original Sales tab (original:view): every sale line with the EXACT charged price,
 * the standard price, discount, cost and profit. GET /api/sales/original?from&to&channel&customer_id&payment_mode.
 * Filters: date range, channel (wholesale option only with wholesale:view), payment mode, customer.
 * Discounts > 0 are highlighted. Row click opens the sale. 'Export CSV' (reports:view) uses
 * App.api.download('/api/reports/sales.csv', {from,to,channel}).
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
    const chOpts = [{ value: '', label: 'Retail & wholesale' }, { value: 'retail', label: 'Retail' }];
    if (App.can('wholesale:view')) chOpts.push({ value: 'wholesale', label: 'Wholesale' });
    const channel = App.ui.select(chOpts.length > 2 ? chOpts : [{ value: 'retail', label: 'Retail' }], { 'aria-label': 'Channel' });
    const mode = App.ui.select([
      { value: '', label: 'All payments' }, { value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'credit', label: 'Credit' },
    ], { 'aria-label': 'Payment mode' });
    const cust = App.components.customerPicker({ allowCreate: false, onChange: () => load() });
    channel.addEventListener('change', load);
    mode.addEventListener('change', load);
    const exportBtn = App.can('reports:view')
      ? App.ui.btn('Export CSV', {
        kind: 'secondary', icon: 'download',
        onClick: () => { const r = range.get(); App.api.download('/api/reports/sales.csv', { from: r.from, to: r.to, channel: channel.value || 'both' }); },
      })
      : null;
    els = { range, channel, mode, cust, stats: h('div', {}), list: h('div', {}), sub: h('span', {}) };
    host.replaceChildren(
      K().tabHeader('Original sales', 'Exact prices, discounts, cost and profit', exportBtn),
      h('div', { class: 'flex flex-wrap items-end gap-3' },
        range.el,
        App.ui.field({ label: 'Channel', input: channel }),
        App.ui.field({ label: 'Payment', input: mode }),
        h('div', { class: 'min-w-[14rem]' }, App.ui.field({ label: 'Customer', input: cust.el }))),
      els.stats,
      K().sectionCard(els.sub, els.list));
  }

  function show() { load(); }

  const num = (n, cls = '') => n == null ? h('span', { class: 'text-stone-400' }, '—') : h('span', { class: 'tabular-nums ' + cls }, App.fmt.money(n));

  function columns() {
    return [
      { key: 'sale_date', label: 'Date', render: (r) => h('div', { class: 'whitespace-nowrap' }, h('div', { class: 'tabular-nums' }, App.fmt.date(r.sale_date)), h('div', { class: 'text-xs text-stone-400' }, K().timeOf(r.created_at))) },
      { key: 'channel', label: 'Channel', render: (r) => K().channelBadge(r.channel) },
      { key: 'customer_name', label: 'Customer', render: (r) => r.customer_name || h('span', { class: 'text-stone-400' }, 'Walk-in') },
      { key: 'rice_type', label: 'Rice', render: (r) => h('span', { class: 'font-medium' }, r.rice_type) },
      { key: 'quantity_label', label: 'Qty', render: (r) => h('span', { class: 'tabular-nums whitespace-nowrap' }, K().lineQty(r)) },
      { key: 'unit_price', label: 'Charged rate', align: 'right', render: (r) => h('span', { class: 'tabular-nums whitespace-nowrap' }, K().price(r.unit_price) + K().unitLabel(r.item_kind)) },
      { key: 'list_unit_price', label: 'Standard rate', align: 'right', render: (r) => h('span', { class: 'tabular-nums whitespace-nowrap text-stone-500' }, K().price(r.list_unit_price) + K().unitLabel(r.item_kind)) },
      { key: 'amount', label: 'Charged', align: 'right', render: (r) => num(r.amount, 'font-semibold') },
      { key: 'list_amount', label: 'Standard', align: 'right', render: (r) => num(r.list_amount, 'text-stone-500') },
      { key: 'discount', label: 'Discount', align: 'right', render: (r) => K().discountCell(r.discount) },
      { key: 'cost_amount', label: 'Cost', align: 'right', render: (r) => num(r.cost_amount) },
      { key: 'profit', label: 'Profit', align: 'right', render: (r) => num(r.profit, r.profit < 0 ? 'text-rose-700 font-semibold' : 'text-emerald-700') },
      { key: 'payment_mode', label: 'Payment', render: (r) => K().payBadge(r.payment_mode) },
    ];
  }

  async function load() {
    if (!els) return;
    const my = ++seq;
    const r = els.range.get();
    els.list.replaceChildren(App.ui.spinner());
    let d;
    try {
      d = await App.api.get('/api/sales/original', {
        from: r.from, to: r.to, channel: els.channel.value || null,
        customer_id: els.cust.getId() || null, payment_mode: els.mode.value || null,
      });
    } catch (e) {
      if (my === seq) els.list.replaceChildren(App.ui.empty(e.message || 'Could not load sales', 'alert'));
      return;
    }
    if (my !== seq) return;
    const t = d.totals || {};
    els.sub.textContent = `${t.count || 0} sale${t.count === 1 ? '' : 's'} · ${(d.rows || []).length} line${(d.rows || []).length === 1 ? '' : 's'}`;
    els.stats.replaceChildren(K().statsRow([
      { label: 'Sales total', value: App.fmt.money(t.total || 0), sub: `${t.count || 0} sales`, tone: 'green' },
      { label: 'At standard prices', value: App.fmt.money(t.list_total || 0) },
      { label: 'Discount given', value: App.fmt.money(t.discount || 0), tone: t.discount > 0 ? 'red' : undefined },
      { label: 'Cost', value: t.cost == null ? '—' : App.fmt.money(t.cost) },
      { label: 'Profit', value: t.profit == null ? '—' : App.fmt.money(t.profit), tone: 'green' },
    ]));
    els.list.replaceChildren(K().scrollWrap(App.ui.table({
      columns: columns(),
      rows: d.rows || [],
      empty: 'No sales in this period',
      onRowClick: (row) => K().openSale(row.sale_id, { onChanged: load }),
    })));
  }

  App.registerTab('original', { init, show });
})();

/*
 * tabs/retail.js — Retail Sales tab (retail:view; 'New sale' needs retail:edit; 'Void' needs sales:void).
 *
 * Day view (date picker, default today) from GET /api/sales/retail?date=…:
 *   summary cards -> 'Loose sales' table (API `loose` lines) on top -> 'Bag sales' table (`bags`) below.
 * Masking: staff get standard amounts only. Exact columns (standard vs charged, discount, profit) are
 * rendered ONLY when those fields are present in the response — nothing is computed client-side.
 * Clicking a row opens the full sale (App.salekit.openSale). New sale -> App.saleForm (shared).
 */
(function () {
  'use strict';
  const h = (...a) => App.ui.h(...a);
  const K = () => App.salekit;
  const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

  let els = null;
  let date = null;
  let seq = 0;

  function init(root) {
    const host = root.querySelector('[data-tab-root]') || root;
    date = App.fmt.today();
    const dateIn = App.ui.input({ type: 'date', value: date, max: App.fmt.today(), 'aria-label': 'Sales date' });
    dateIn.addEventListener('change', () => { if (dateIn.value) { date = dateIn.value; load(); } });
    const todayBtn = App.ui.btn('Today', { kind: 'ghost', small: true, onClick: () => { date = App.fmt.today(); dateIn.value = date; load(); } });
    const prevBtn = App.ui.btn('‹', { kind: 'secondary', small: true, onClick: () => shift(-1) });
    prevBtn.setAttribute('aria-label', 'Previous day'); prevBtn.title = 'Previous day';
    const nextBtn = App.ui.btn('›', { kind: 'secondary', small: true, onClick: () => shift(1) });
    nextBtn.setAttribute('aria-label', 'Next day'); nextBtn.title = 'Next day';
    function shift(d) {
      const n = K().addDays(date, d);
      if (n > App.fmt.today()) return;
      date = n; dateIn.value = n; load();
    }
    const refresh = App.ui.btn('', { kind: 'ghost', small: true, icon: 'refresh', onClick: () => load() });
    refresh.setAttribute('aria-label', 'Refresh'); refresh.title = 'Refresh';
    const newBtn = App.can('retail:edit')
      ? App.ui.btn('New sale', { kind: 'primary', icon: 'plus', onClick: () => App.saleForm.open({ channel: 'retail', mode: 'sale', date }) })
      : null;
    if (newBtn) newBtn.classList.add('min-h-[48px]', 'px-5', 'text-base');

    els = {
      title: h('span', {}),
      dateIn,
      stats: h('div', {}),
      loose: h('div', {}),
      bags: h('div', {}),
      looseCount: h('span', { class: 'text-sm font-normal text-stone-500' }),
      bagCount: h('span', { class: 'text-sm font-normal text-stone-500' }),
    };
    host.replaceChildren(
      K().tabHeader('Retail sales', els.title, newBtn),
      h('div', { class: 'flex flex-wrap items-center gap-2' }, prevBtn, h('div', { class: 'w-44' }, dateIn), nextBtn, todayBtn, refresh),
      els.stats,
      K().sectionCard(h('span', { class: 'flex items-center gap-2' }, 'Loose sales', els.looseCount), els.loose),
      K().sectionCard(h('span', { class: 'flex items-center gap-2' }, 'Bag sales', els.bagCount), els.bags),
    );
  }

  function show() { load(); }

  function columns(rows, exact) {
    const cols = [
      { key: 'created_at', label: 'Time', render: (r) => h('span', { class: 'tabular-nums text-stone-500' }, K().timeOf(r.created_at)) },
      { key: 'customer_name', label: 'Customer', render: (r) => r.customer_name || h('span', { class: 'text-stone-400' }, 'Walk-in') },
      { key: 'rice_type', label: 'Rice', render: (r) => h('span', { class: 'font-medium' }, r.rice_type) },
      { key: 'quantity_label', label: 'Qty', render: (r) => h('span', { class: 'tabular-nums' }, K().lineQty(r)) },
    ];
    if (exact) {
      cols.push({ key: 'list_unit_price', label: 'Standard rate', align: 'right', render: (r) => has(r, 'list_unit_price') ? K().price(r.list_unit_price) + K().unitLabel(r.item_kind) : '—' });
      cols.push({ key: 'unit_price', label: 'Charged rate', align: 'right', render: (r) => K().price(r.unit_price) + K().unitLabel(r.item_kind) });
      cols.push({ key: 'discount', label: 'Discount', align: 'right', render: (r) => K().discountCell(r.discount) });
      cols.push({ key: 'profit', label: 'Profit', align: 'right', render: (r) => r.profit == null ? '—' : h('span', { class: 'tabular-nums' }, App.fmt.money(r.profit)) });
    } else {
      cols.push({ key: 'unit_price', label: 'Rate', align: 'right', render: (r) => K().price(r.unit_price) + K().unitLabel(r.item_kind) });
    }
    cols.push({ key: 'amount', label: 'Amount', align: 'right', render: (r) => h('span', { class: 'font-semibold tabular-nums' }, App.fmt.money(r.amount)) });
    cols.push({ key: 'payment_mode', label: 'Payment', render: (r) => K().payBadge(r.payment_mode) });
    if (App.can('sales:void')) {
      cols.push({
        key: '_act', label: '', align: 'right',
        render: (r) => {
          const b = App.ui.btn('Void', { kind: 'ghost', small: true, icon: 'trash', onClick: (e) => { if (e) e.stopPropagation(); voidLine(r); } });
          b.addEventListener('click', (e) => e.stopPropagation());
          return b;
        },
      });
    }
    return cols;
  }

  function voidLine(row) {
    const sale = (els.sales || []).find((s) => s.id === row.sale_id) || { id: row.sale_id, channel: 'retail', total_amount: row.amount, customer_name: row.customer_name, payment_mode: row.payment_mode };
    K().voidSale(sale, () => load());
  }

  function table(rows, exact, emptyMsg) {
    const sum = rows.reduce((s, r) => s + (r.amount || 0), 0);
    return K().scrollWrap(App.ui.table({
      columns: columns(rows, exact),
      rows,
      empty: emptyMsg,
      onRowClick: (r) => K().openSale(r.sale_id, { onChanged: load }),
      footer: rows.length ? h('div', { class: 'flex justify-end gap-2 font-semibold tabular-nums' }, 'Total ', App.fmt.money(sum)) : null,
    }));
  }

  async function load() {
    if (!els) return;
    const my = ++seq;
    els.title.textContent = date === App.fmt.today() ? `Today · ${App.fmt.date(date)}` : App.fmt.date(date);
    els.loose.replaceChildren(App.ui.spinner());
    els.bags.replaceChildren(App.ui.spinner());
    let d;
    try {
      d = await App.api.get('/api/sales/retail', { date });
    } catch (e) {
      if (my !== seq) return;
      els.loose.replaceChildren(App.ui.empty(e.message || 'Could not load sales', 'alert'));
      els.bags.replaceChildren();
      return;
    }
    if (my !== seq) return;
    els.sales = d.sales || [];
    const loose = d.loose || [];
    const bags = d.bags || [];
    const exact = loose.concat(bags).some((r) => has(r, 'discount') || has(r, 'list_amount'));
    const t = d.totals || {};
    const stats = [
      { label: 'Total sales', value: App.fmt.money(t.total || 0), sub: `${t.count || 0} sale${t.count === 1 ? '' : 's'}`, tone: 'green' },
      { label: 'Cash', value: App.fmt.money(t.cash || 0) },
      { label: 'UPI', value: App.fmt.money(t.upi || 0) },
      { label: 'Credit given', value: App.fmt.money(t.credit || 0), tone: t.credit ? 'amber' : undefined },
      { label: 'Loose sold', value: App.fmt.kg(t.loose_grams || 0) },
      { label: 'Bags sold', value: App.fmt.num ? App.fmt.num(t.bags || 0) : String(t.bags || 0) },
    ];
    if (has(t, 'discount') && t.discount != null) stats.push({ label: 'Discount given', value: App.fmt.money(t.discount), tone: t.discount > 0 ? 'red' : undefined });
    if (has(t, 'profit') && t.profit != null) stats.push({ label: 'Profit', value: App.fmt.money(t.profit), tone: 'green' });
    els.stats.replaceChildren(K().statsRow(stats));
    els.looseCount.textContent = loose.length ? `(${loose.length})` : '';
    els.bagCount.textContent = bags.length ? `(${bags.length})` : '';
    els.loose.replaceChildren(table(loose, exact, 'No loose sales on this day'));
    els.bags.replaceChildren(table(bags, exact, 'No bag sales on this day'));
  }

  App.registerTab('retail', { init, show });
})();

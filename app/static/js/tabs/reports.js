/*
 * tabs/reports.js — Reports tab (reports:view). GET /api/reports/summary?from&to&channel=both|retail|wholesale.
 * Channel chooser shows 'Both' / 'Wholesale' only with wholesale:view.
 * Sections: totals cards (discount/profit only when present), 'Sales by day' pure-CSS bar chart
 * (role=img with a text summary + a 'Show as table' fallback), 'By rice type' table, 'By payment mode'
 * stacked bar, 'Top customers'. Export CSV -> App.api.download('/api/reports/sales.csv', …).
 * No chart libraries.
 */
(function () {
  'use strict';
  const h = (...a) => App.ui.h(...a);
  const K = () => App.salekit;
  const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k) && o[k] != null;

  let els = null;
  let channel = 'both';
  let seq = 0;

  const MODE = {
    cash: { label: 'Cash', bar: 'bg-emerald-500', dot: 'bg-emerald-500' },
    upi: { label: 'UPI', bar: 'bg-sky-500', dot: 'bg-sky-500' },
    credit: { label: 'Credit', bar: 'bg-amber-500', dot: 'bg-amber-500' },
  };

  function init(root) {
    const host = root.querySelector('[data-tab-root]') || root;
    const today = App.fmt.today();
    const range = App.components.dateRange({ from: K().addDays(today, -30), to: today, onChange: () => load() });
    const wh = App.can('wholesale:view');
    if (!wh) channel = 'retail';
    const seg = wh ? K().segmented({
      options: [{ value: 'both', label: 'Both' }, { value: 'retail', label: 'Retail' }, { value: 'wholesale', label: 'Wholesale' }],
      value: channel, size: 'sm', label: 'Channel', onChange: (v) => { channel = v; load(); },
    }) : null;
    const exportBtn = App.ui.btn('Export CSV', {
      kind: 'secondary', icon: 'download',
      onClick: () => { const r = range.get(); App.api.download('/api/reports/sales.csv', { from: r.from, to: r.to, channel }); },
    });
    els = { range, stats: h('div', {}), body: h('div', { class: 'space-y-5' }), sub: h('span', {}) };
    host.replaceChildren(
      K().tabHeader('Reports', els.sub, exportBtn),
      h('div', { class: 'flex flex-wrap items-end gap-3' }, range.el, seg ? h('div', { class: 'min-w-[16rem]' }, seg.el) : null),
      els.stats, els.body);
  }

  function show() { load(); }

  async function load() {
    if (!els) return;
    const my = ++seq;
    const r = els.range.get();
    els.body.replaceChildren(App.ui.spinner());
    let d;
    try {
      d = await App.api.get('/api/reports/summary', { from: r.from, to: r.to, channel });
    } catch (e) {
      if (my === seq) els.body.replaceChildren(App.ui.empty(e.message || 'Could not load the report', 'alert'));
      return;
    }
    if (my !== seq) return;
    const t = d.totals || {};
    const rg = d.range || r;
    els.sub.textContent = rg.from && rg.to ? `${App.fmt.date(rg.from)} – ${App.fmt.date(rg.to)}` : '';
    els.stats.replaceChildren(K().statsRow([
      { label: 'Total sales', value: App.fmt.money(t.total || 0), sub: `${t.count || 0} sales`, tone: 'green' },
      { label: 'Cash', value: App.fmt.money(t.cash || 0) },
      { label: 'UPI', value: App.fmt.money(t.upi || 0) },
      { label: 'Credit', value: App.fmt.money(t.credit || 0), tone: t.credit ? 'amber' : undefined },
      { label: 'Bags', value: String(t.bags || 0), sub: `${App.fmt.kg(t.loose_grams || 0)} loose` },
      has(t, 'discount') ? { label: 'Discount given', value: App.fmt.money(t.discount), tone: t.discount > 0 ? 'red' : undefined } : null,
      has(t, 'profit') ? { label: 'Profit', value: App.fmt.money(t.profit), tone: 'green' } : null,
    ]));
    if (!t.count) {
      els.body.replaceChildren(App.ui.empty('No sales in this period', 'chart'));
      return;
    }
    els.body.replaceChildren(
      K().sectionCard('Sales by day', dayChart(fillDays(d.by_day || [], rg))),
      h('div', { class: 'grid grid-cols-1 xl:grid-cols-2 gap-5' },
        K().sectionCard('By payment mode', paymentSplit(d.by_payment_mode || [])),
        K().sectionCard('Top customers', topCustomers(d.top_customers || []))),
      K().sectionCard('By rice type', riceTable(d.by_rice || [])));
  }

  // ---------------------------------------------------------------- charts -- //
  /** Add zero rows for days without sales (ranges up to ~3 months) so the bars line up with the calendar. */
  function fillDays(days, rg) {
    if (!rg || !rg.from || !rg.to) return days;
    const byDate = {};
    days.forEach((x) => { byDate[x.date] = x; });
    const out = [];
    let d = rg.from;
    for (let i = 0; d <= rg.to && i < 93; i++, d = K().addDays(d, 1)) out.push(byDate[d] || { date: d, total: 0, count: 0 });
    return d <= rg.to ? days : out;
  }
  function dayChart(days) {
    if (!days.length) return App.ui.empty('No sales', 'chart');
    const rows = days.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    const max = Math.max(1, ...rows.map((x) => x.total || 0));
    const best = rows.reduce((a, b) => ((b.total || 0) > (a.total || 0) ? b : a), rows[0]);
    const sum = rows.reduce((s, x) => s + (x.total || 0), 0);
    const every = Math.max(1, Math.ceil(rows.length / 10));
    const showProfit = rows.some((x) => has(x, 'profit'));

    const bars = rows.map((x, i) => {
      const pct = Math.round(((x.total || 0) / max) * 100);
      const tip = `${App.fmt.date(x.date)}: ${App.fmt.money(x.total || 0)} (${x.count || 0} sales)` + (has(x, 'profit') ? ` · profit ${App.fmt.money(x.profit)}` : '');
      return h('div', { class: 'flex-1 min-w-[6px] flex flex-col items-center justify-end h-full group', title: tip },
        h('div', { class: 'w-full max-w-[36px] rounded-t-md bg-emerald-500 group-hover:bg-emerald-600 transition-all', style: `height:${Math.max(pct, x.total ? 2 : 0)}%` }),
        h('div', { class: 'h-5 text-[10px] text-stone-500 tabular-nums mt-1 whitespace-nowrap' }, i % every === 0 ? x.date.slice(8) + '/' + x.date.slice(5, 7) : ''));
    });
    const figure = h('div', {
      role: 'img',
      'aria-label': `Sales by day: ${rows.length} days, total ${App.fmt.money(sum)}, best day ${App.fmt.date(best.date)} with ${App.fmt.money(best.total || 0)}.`,
      class: 'relative',
    },
      h('div', { class: 'absolute left-0 top-0 text-xs text-stone-400 tabular-nums' }, App.fmt.money(max)),
      h('div', { class: 'flex items-end gap-1 h-48 pt-5 border-b border-stone-200' }, bars));
    const tbl = App.ui.table({
      columns: [
        { key: 'date', label: 'Date', render: (x) => App.fmt.date(x.date) },
        { key: 'count', label: 'Sales', align: 'right', render: (x) => h('span', { class: 'tabular-nums' }, String(x.count || 0)) },
        { key: 'total', label: 'Total', align: 'right', render: (x) => h('span', { class: 'tabular-nums font-semibold' }, App.fmt.money(x.total || 0)) },
        showProfit ? { key: 'profit', label: 'Profit', align: 'right', render: (x) => has(x, 'profit') ? h('span', { class: 'tabular-nums' }, App.fmt.money(x.profit)) : '—' } : null,
      ].filter(Boolean),
      rows: rows.slice().reverse(),
    });
    return h('div', { class: 'space-y-3' },
      h('p', { class: 'text-sm text-stone-600' }, `Best day: ${App.fmt.date(best.date)} · ${App.fmt.money(best.total || 0)}  ·  Daily average ${App.fmt.money(Math.round(sum / rows.length))}`),
      figure,
      h('details', { class: 'text-sm' }, h('summary', { class: 'cursor-pointer text-stone-600 select-none' }, 'Show as table'), h('div', { class: 'mt-2' }, K().scrollWrap(tbl))));
  }

  function paymentSplit(modes) {
    const total = modes.reduce((s, m) => s + (m.total || 0), 0);
    if (!total) return App.ui.empty('No sales', 'rupee');
    const order = ['cash', 'upi', 'credit'];
    const rows = modes.slice().sort((a, b) => order.indexOf(a.mode) - order.indexOf(b.mode));
    const pct = (m) => Math.round(((m.total || 0) / total) * 1000) / 10;
    return h('div', { class: 'space-y-4' },
      h('div', {
        class: 'flex h-6 w-full overflow-hidden rounded-full bg-stone-100', role: 'img',
        'aria-label': rows.map((m) => `${(MODE[m.mode] || { label: m.mode }).label} ${pct(m)}%`).join(', '),
      }, rows.map((m) => h('div', { class: (MODE[m.mode] || { bar: 'bg-stone-400' }).bar, style: `width:${pct(m)}%`, title: `${(MODE[m.mode] || { label: m.mode }).label}: ${App.fmt.money(m.total || 0)}` }))),
      h('div', { class: 'grid grid-cols-1 sm:grid-cols-3 gap-3' }, rows.map((m) => {
        const meta = MODE[m.mode] || { label: m.mode, dot: 'bg-stone-400' };
        return h('div', { class: 'rounded-xl border border-stone-200 p-3' },
          h('div', { class: 'flex items-center gap-2 text-sm text-stone-600' }, h('span', { class: `inline-block w-3 h-3 rounded-full ${meta.dot}` }), meta.label),
          h('div', { class: 'text-lg font-bold tabular-nums' }, App.fmt.money(m.total || 0)),
          h('div', { class: 'text-xs text-stone-500 tabular-nums' }, `${pct(m)}% · ${m.count || 0} sales`));
      })));
  }

  function topCustomers(list) {
    if (!list.length) return App.ui.empty('No named customers in this period', 'users');
    const max = Math.max(1, ...list.map((c) => c.total || 0));
    return h('ol', { class: 'space-y-2' }, list.map((c, i) => h('li', { class: 'space-y-1' },
      h('div', { class: 'flex justify-between gap-3 text-sm' },
        h('span', { class: 'font-medium text-stone-800' }, `${i + 1}. ${c.name}`),
        h('span', { class: 'tabular-nums font-semibold' }, App.fmt.money(c.total || 0), h('span', { class: 'text-xs font-normal text-stone-500' }, ` · ${c.count || 0}`))),
      h('div', { class: 'h-2 rounded-full bg-stone-100 overflow-hidden' },
        h('div', { class: 'h-full rounded-full bg-emerald-500', style: `width:${Math.round(((c.total || 0) / max) * 100)}%` })))));
  }

  function riceTable(rows) {
    const showProfit = rows.some((r) => has(r, 'profit'));
    const sorted = rows.slice().sort((a, b) => (b.amount || 0) - (a.amount || 0));
    return K().scrollWrap(App.ui.table({
      columns: [
        { key: 'rice_type', label: 'Rice type', render: (r) => h('span', { class: 'font-medium' }, r.rice_type) },
        { key: 'grams', label: 'Loose', align: 'right', render: (r) => h('span', { class: 'tabular-nums' }, r.grams ? App.fmt.kg(r.grams) : '—') },
        { key: 'bags', label: 'Bags', align: 'right', render: (r) => h('span', { class: 'tabular-nums' }, r.bags ? String(r.bags) : '—') },
        { key: 'amount', label: 'Amount', align: 'right', render: (r) => h('span', { class: 'tabular-nums font-semibold' }, App.fmt.money(r.amount || 0)) },
        showProfit ? { key: 'profit', label: 'Profit', align: 'right', render: (r) => has(r, 'profit') ? h('span', { class: 'tabular-nums' }, App.fmt.money(r.profit)) : '—' } : null,
      ].filter(Boolean),
      rows: sorted,
      empty: 'No sales',
    }));
  }

  App.registerTab('reports', { init, show });
})();

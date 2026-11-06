/*
 * shared/salekit.js — small helpers shared by the sales/credit tabs (retail, wholesale, original,
 * reminders, credits, reports) and core/bell.js.  Exposes `App.salekit`.
 *
 * Owns:
 *   - badges: payBadge(mode), channelBadge(channel), statusBadge(status)
 *   - text helpers: itemsSummary(items), lineQty(line), timeOf(datetime), unitLabel(kind)
 *   - number parsing for form inputs: parseMoney(str) -> int|null, parsePrice(str) -> number|null
 *   - openSale(idOrSale, {onChanged}) -> modal with the full sale detail (+ Void when allowed)
 *   - voidSale(sale, onDone) -> confirm + optional reason, POST /api/sales/<id>/void
 *   - refreshAfterSale(channel) -> App.reload of the affected tabs + App.refreshBell()
 *   - scrollWrap(node), sectionCard(title, ...children), segmented(...) layout helpers
 *
 * Masking: nothing here computes discounts. Exact-only fields (list_*, discount, cost, profit) are
 * rendered only when they are present in the API response.
 */
(function () {
  'use strict';
  const App = (window.App = window.App || {});
  const h = (...a) => App.ui.h(...a);
  const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;

  const PAY = {
    cash: { label: 'Cash', tone: 'green' },
    upi: { label: 'UPI', tone: 'blue' },
    credit: { label: 'Credit', tone: 'amber' },
  };

  function payBadge(mode) {
    const p = PAY[mode] || { label: mode || '—', tone: 'gray' };
    return App.ui.badge(p.label, p.tone);
  }
  function channelBadge(channel) {
    return App.ui.badge(channel === 'wholesale' ? 'Wholesale' : 'Retail', channel === 'wholesale' ? 'blue' : 'gray');
  }
  function statusBadge(status) {
    const map = {
      pending: ['Pending', 'amber'], sent: ['Sent', 'green'], cancelled: ['Cancelled', 'gray'],
      void: ['Void', 'red'], open: ['Yet to collect', 'amber'], settled: ['Collected', 'green'],
      active: ['Active', 'green'],
    };
    const m = map[status] || [status || '—', 'gray'];
    return App.ui.badge(m[0], m[1]);
  }

  function lineQty(line) {
    if (!line) return '';
    if (line.quantity_label) return line.quantity_label;
    try { return App.fmt.qty(line); } catch (e) { return ''; }
  }
  function itemsSummary(items) {
    return (items || []).map((it) => `${it.rice_type} · ${lineQty(it)}`).join(', ');
  }
  function unitLabel(kind) { return kind === 'bag' ? '/bag' : '/kg'; }

  /** 'YYYY-MM-DD HH:MM[:SS]' -> '4:30 PM' */
  function timeOf(dt) {
    if (!dt) return '';
    const m = String(dt).match(/[ T](\d{2}):(\d{2})/);
    if (!m) return '';
    let hh = Number(m[1]);
    const ap = hh >= 12 ? 'PM' : 'AM';
    hh = hh % 12 || 12;
    return `${hh}:${m[2]} ${ap}`;
  }

  function parseMoney(v) {
    if (v == null) return null;
    const s = String(v).trim().replace(/[,₹\s]/g, '');
    if (s === '') return null;
    if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
    return Math.round(Number(s));
  }
  function parsePrice(v) {
    if (v == null) return null;
    const s = String(v).trim().replace(/[,₹\s]/g, '');
    if (s === '') return null;
    if (!/^\d+(\.\d+)?$/.test(s)) return NaN;
    return Math.round(Number(s) * 100) / 100;
  }
  function price(n) {
    if (n == null || n === '') return '—';
    const v = Number(n);
    const s = v.toLocaleString('en-IN', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
    return '₹' + s;
  }
  function addDays(iso, d) {
    const [y, m, dd] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, dd + d);
    const p = (x) => String(x).padStart(2, '0');
    return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
  }
  function refreshBell() { if (typeof App.refreshBell === 'function') { try { App.refreshBell(); } catch (e) { /* ignore */ } } }
  function reload(id) { if (typeof App.reload === 'function') { try { App.reload(id); } catch (e) { /* ignore */ } } }
  function refreshAfterSale(channel) {
    reload(channel === 'wholesale' ? 'wholesale' : 'retail');
    ['original', 'credits', 'reports', 'reminders', 'dashboard', 'inventory', 'customers'].forEach(reload);
    refreshBell();
  }

  // ----------------------------- layout helpers ----------------------------- //
  function scrollWrap(node) {
    return h('div', { class: 'overflow-x-auto -mx-1 px-1' }, node);
  }
  function sectionCard(title, ...children) {
    return h('section', { class: 'bg-white rounded-2xl border border-stone-200 shadow-sm p-4 sm:p-5 space-y-3' },
      title ? h('h3', { class: 'text-base font-semibold text-stone-800 flex items-center gap-2' }, title) : null,
      ...children);
  }
  function statsRow(stats) {
    return h('div', { class: 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3' },
      stats.filter(Boolean).map((s) => App.components.stat(s)));
  }
  /**
   * Big segmented toggle buttons (payment mode, loose/bag, channel ...).
   * options: [{value,label,tone?}] ; returns {el, get(), set(v)}
   */
  function segmented({ options, value, onChange, size = 'lg', label }) {
    let current = value;
    const tones = {
      green: 'bg-emerald-600 text-white border-emerald-600',
      blue: 'bg-sky-600 text-white border-sky-600',
      amber: 'bg-amber-500 text-white border-amber-500',
      gray: 'bg-stone-800 text-white border-stone-800',
    };
    const pad = size === 'lg' ? 'px-4 py-3 text-base min-h-[48px]' : 'px-3 py-2 text-sm min-h-[40px]';
    const btns = options.map((o) => {
      const b = h('button', {
        type: 'button',
        class: `flex-1 rounded-xl border font-semibold transition ${pad}`,
        dataset: { value: o.value },
        on: { click: () => set(o.value, true) },
      }, o.label);
      b._tone = tones[o.tone || 'gray'];
      return b;
    });
    const el = h('div', { class: 'flex gap-2', role: 'group' }, btns);
    if (label) el.setAttribute('aria-label', label);
    function paint() {
      btns.forEach((b) => {
        const on = b.dataset.value === String(current);
        b.className = `flex-1 rounded-xl border font-semibold transition ${pad} ` +
          (on ? b._tone : 'bg-white text-stone-700 border-stone-300 hover:bg-stone-50');
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
    }
    function set(v, fire) {
      current = v;
      paint();
      if (fire && onChange) onChange(v);
    }
    paint();
    return { el, get: () => current, set: (v) => set(v, false) };
  }

  function kv(label, value) {
    return h('div', { class: 'flex justify-between gap-3 py-1' },
      h('span', { class: 'text-stone-500' }, label),
      h('span', { class: 'font-medium text-stone-800 text-right tabular-nums' }, value == null || value === '' ? '—' : value));
  }

  // ------------------------------- sale detail ------------------------------ //
  async function openSale(idOrSale, opts = {}) {
    const box = h('div', { class: 'space-y-4' }, App.ui.spinner());
    const m = App.ui.modal({ title: 'Sale', body: box, size: 'lg' });
    let sale = idOrSale;
    try {
      const id = typeof idOrSale === 'object' ? idOrSale.id : idOrSale;
      sale = await App.api.get(`/api/sales/${id}`);
    } catch (e) {
      box.replaceChildren(App.ui.empty(e.message || 'Could not load the sale.', 'alert'));
      return m;
    }
    m.setTitle && m.setTitle(`${sale.channel === 'wholesale' ? 'Wholesale' : 'Retail'} sale #${sale.id}`);
    box.replaceChildren(renderSale(sale, () => {
      m.close();
      if (opts.onChanged) opts.onChanged();
    }));
    return m;
  }

  function renderSale(sale, onVoided) {
    const exact = has(sale, 'list_total');
    const items = sale.items || [];
    const cols = [
      { key: 'rice_type', label: 'Rice' },
      { key: 'qty', label: 'Quantity', render: (r) => lineQty(r) },
      { key: 'unit_price', label: 'Rate', align: 'right', render: (r) => price(r.unit_price) + unitLabel(r.item_kind) },
    ];
    if (exact) {
      cols.push({ key: 'list_unit_price', label: 'Standard rate', align: 'right', render: (r) => has(r, 'list_unit_price') ? price(r.list_unit_price) + unitLabel(r.item_kind) : '—' });
      cols.push({ key: 'discount', label: 'Discount', align: 'right', render: (r) => discountCell(r.discount) });
      cols.push({ key: 'cost_amount', label: 'Cost', align: 'right', render: (r) => r.cost_amount == null ? '—' : App.fmt.money(r.cost_amount) });
      cols.push({ key: 'profit', label: 'Profit', align: 'right', render: (r) => r.profit == null ? '—' : App.fmt.money(r.profit) });
    }
    cols.push({ key: 'amount', label: 'Amount', align: 'right', render: (r) => h('span', { class: 'font-semibold tabular-nums' }, App.fmt.money(r.amount)) });

    const head = h('div', { class: 'grid sm:grid-cols-2 gap-x-6 text-sm' },
      kv('Date', App.fmt.date(sale.sale_date)),
      kv('Customer', sale.customer_name || 'Walk-in'),
      kv('Payment', payBadge(sale.payment_mode)),
      kv('Status', statusBadge(sale.status === 'void' ? 'void' : 'active')),
      sale.channel === 'wholesale' ? kv('Call received', sale.call_received_on ? App.fmt.date(sale.call_received_on) : '—') : null,
      sale.channel === 'wholesale' ? kv('Sent on', sale.sent_on ? App.fmt.date(sale.sent_on) : App.fmt.date(sale.sale_date)) : null,
      kv('Entered', `${sale.created_by || ''} ${sale.created_at ? '· ' + App.fmt.dateTime(sale.created_at.slice(0, 16)) : ''}`),
    );

    const totals = h('div', { class: 'rounded-xl bg-stone-50 border border-stone-200 p-3 text-sm' },
      kv('Total', h('span', { class: 'text-lg font-bold' }, App.fmt.money(sale.total_amount))),
      exact ? kv('At standard prices', App.fmt.money(sale.list_total)) : null,
      exact ? kv('Discount given', discountCell(sale.discount_total)) : null,
      exact && sale.cost_total != null ? kv('Cost', App.fmt.money(sale.cost_total)) : null,
      exact && sale.profit_total != null ? kv('Profit', App.fmt.money(sale.profit_total)) : null,
      sale.payment_mode === 'credit' ? kv('Advance paid', App.fmt.money(sale.paid_amount || 0)) : null,
      sale.payment_mode === 'credit' ? kv('On credit', h('span', { class: 'font-semibold text-amber-700' }, App.fmt.money(sale.credit_amount || 0))) : null,
    );

    const actions = h('div', { class: 'flex flex-wrap gap-2 justify-end' });
    if (sale.status !== 'void' && App.can('sales:void')) {
      actions.append(App.ui.btn('Void sale', { kind: 'danger', icon: 'trash', onClick: () => voidSale(sale, onVoided) }));
    }

    return h('div', { class: 'space-y-4' },
      head,
      scrollWrap(App.ui.table({ columns: cols, rows: items, empty: 'No items' })),
      totals,
      sale.notes ? h('div', { class: 'text-sm' }, h('div', { class: 'text-stone-500' }, 'Notes'), h('p', { class: 'whitespace-pre-wrap text-stone-800' }, sale.notes)) : null,
      actions);
  }

  function discountCell(n) {
    if (n == null) return '—';
    if (Number(n) > 0) return h('span', { class: 'inline-block rounded-md bg-rose-50 text-rose-700 font-semibold px-1.5 tabular-nums' }, App.fmt.money(n));
    return h('span', { class: 'text-stone-400 tabular-nums' }, App.fmt.money(n));
  }

  async function voidSale(sale, onDone) {
    const reason = App.ui.input({ placeholder: 'Reason (optional)', maxlength: 200 });
    const body = h('div', { class: 'space-y-3' },
      h('p', { class: 'text-stone-700' },
        `Void sale #${sale.id} of ${App.fmt.money(sale.total_amount)}${sale.customer_name ? ' for ' + sale.customer_name : ''}? `,
        sale.channel === 'retail' ? 'Stock is put back' : '',
        sale.payment_mode === 'credit' ? ' and the credit is removed.' : (sale.channel === 'retail' ? '.' : '')),
      App.ui.field({ label: 'Reason', input: reason }));
    const err = h('p', { class: 'text-sm text-rose-600 hidden' });
    const m = App.ui.modal({ title: 'Void sale', body: h('div', { class: 'space-y-3' }, body, err), size: 'sm' });
    const cancel = App.ui.btn('Keep sale', { kind: 'secondary', onClick: () => m.close() });
    const ok = App.ui.btn('Void sale', {
      kind: 'danger', icon: 'trash',
      onClick: async () => {
        ok.disabled = true;
        err.classList.add('hidden');
        try {
          await App.api.post(`/api/sales/${sale.id}/void`, { reason: reason.value.trim() || undefined }, { silent: true });
          m.close();
          App.ui.toast('Sale voided');
          refreshAfterSale(sale.channel);
          if (onDone) onDone();
        } catch (e) {
          err.textContent = e.message || 'Could not void the sale.';
          err.classList.remove('hidden');
          ok.disabled = false;
        }
      },
    });
    m.body.append(h('div', { class: 'flex justify-end gap-2 pt-2' }, cancel, ok));
    reason.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ok.click(); } });
    setTimeout(() => reason.focus(), 50);
  }

  /** Standard page header for a tab: title, subtitle, right-hand actions. */
  function tabHeader(title, sub, ...actions) {
    return h('div', { class: 'flex flex-wrap items-end justify-between gap-3' },
      h('div', {},
        h('h2', { class: 'text-xl sm:text-2xl font-bold text-stone-800' }, title),
        sub ? h('p', { class: 'text-sm text-stone-500' }, sub) : null),
      h('div', { class: 'flex flex-wrap items-center gap-2' }, ...actions));
  }

  /** Debounce helper. */
  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  App.salekit = {
    payBadge, channelBadge, statusBadge, lineQty, itemsSummary, unitLabel, timeOf,
    parseMoney, parsePrice, price, addDays, has, kv, discountCell,
    refreshBell, reload, refreshAfterSale,
    scrollWrap, sectionCard, statsRow, segmented, tabHeader, debounce,
    openSale, renderSale, voidSale,
  };
})();

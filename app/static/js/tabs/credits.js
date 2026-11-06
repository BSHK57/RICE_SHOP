/*
 * tabs/credits.js — Credits tab (credits:view; record payments / add credit / edit due date with
 * credits:edit; undo payment / delete manual entry only with credits:delete).
 *
 * Layout: KPI cards (GET /api/credits/summary; wholesale figure only when non-null) + inner pills:
 *   By customer  GET /api/credits/by-customer   -> click = customer ledger modal
 *   By date      GET /api/credits/by-date       (date_field credit_date | due_date), grouped by day
 *   All credits  GET /api/credits/entries       (status / channel / customer / date filters)
 *   Collections  GET /api/credits/collections   (payments received + total)
 * Ledger modal: GET /api/credits/customer/<id>; lump-sum payment (applied oldest-first by the server),
 * per-entry 'Pay', edit due date/notes, delete payment/entry (credits:delete, confirm).
 * Wholesale rows are filtered by the server; the wholesale channel option is shown only with
 * credits:wholesale. Each inner view keeps its own filters while the tab stays open.
 */
(function () {
  'use strict';
  const h = (...a) => App.ui.h(...a);
  const K = () => App.salekit;

  let els = null;
  let active = 'customer';
  const views = {};

  // -------------------------------------------------------------------------- //
  function init(root) {
    const host = root.querySelector('[data-tab-root]') || root;
    const addBtn = App.can('credits:edit')
      ? App.ui.btn('Add credit', { kind: 'primary', icon: 'plus', onClick: () => openAddCredit() })
      : null;
    if (addBtn) addBtn.classList.add('min-h-[48px]', 'px-5');
    const pills = App.ui.tabs({
      items: [
        { id: 'customer', label: 'By customer' }, { id: 'date', label: 'By date' },
        { id: 'all', label: 'All credits' }, { id: 'collections', label: 'Collections' },
      ],
      active,
      onChange: (id) => { active = id; renderView(); },
    });
    els = { kpis: h('div', {}), pills, view: h('div', {}) };
    host.replaceChildren(
      K().tabHeader('Credits', 'Who owes what, and payments received', addBtn),
      els.kpis, pills.el, els.view);
  }

  function show() { refreshAll(); }

  function refreshAll() {
    loadSummary();
    renderView();
  }

  function renderView() {
    if (!els) return;
    if (!views[active]) views[active] = BUILDERS[active]();
    els.view.replaceChildren(views[active].el);
    views[active].load();
  }

  async function loadSummary() {
    let s;
    try { s = await App.api.get('/api/credits/summary', null, { silent: true }); } catch (e) { return; }
    const outSub = s.outstanding_wholesale != null
      ? `Retail ${App.fmt.money(s.outstanding_retail || 0)} · Wholesale ${App.fmt.money(s.outstanding_wholesale)}`
      : null;
    els.kpis.replaceChildren(h('div', { class: 'grid grid-cols-2 lg:grid-cols-5 gap-3' },
      App.components.stat({ label: 'Outstanding', value: App.fmt.money(s.outstanding_total || 0), sub: outSub, tone: 'amber' }),
      App.components.stat({ label: 'Overdue', value: App.fmt.money(s.overdue_total || 0), sub: `${s.overdue_count || 0} entr${s.overdue_count === 1 ? 'y' : 'ies'}`, tone: s.overdue_total ? 'red' : undefined }),
      App.components.stat({ label: 'To collect from', value: `${s.customers_with_balance || 0}`, sub: 'customers' }),
      App.components.stat({ label: 'Collected today', value: App.fmt.money(s.collected_today || 0), tone: 'green' }),
      App.components.stat({ label: 'Collected this month', value: App.fmt.money(s.collected_this_month || 0), tone: 'green' })));
  }

  function afterChange() {
    refreshAll();
    ['customers', 'dashboard', 'retail', 'wholesale', 'original'].forEach((t) => K().reload(t));
  }

  // ------------------------------ shared cells ------------------------------ //
  function dueCell(e) {
    if (!e.due_date) return h('span', { class: 'text-stone-400' }, '—');
    return h('span', { class: 'inline-flex items-center gap-1 whitespace-nowrap tabular-nums ' + (e.overdue ? 'text-rose-700 font-semibold' : '') },
      App.fmt.date(e.due_date), e.overdue ? App.ui.badge('Overdue', 'red') : null);
  }
  const money = (n, cls = '') => h('span', { class: 'tabular-nums ' + cls }, App.fmt.money(n || 0));

  function entryColumns({ showCustomer = true } = {}) {
    return [
      { key: 'credit_date', label: 'Credit date', render: (e) => h('span', { class: 'tabular-nums whitespace-nowrap' }, App.fmt.date(e.credit_date)) },
      showCustomer ? { key: 'customer_name', label: 'Customer', render: (e) => h('div', {}, h('div', { class: 'font-medium' }, e.customer_name), e.customer_phone ? h('div', { class: 'text-xs text-stone-500' }, e.customer_phone) : null) } : null,
      { key: 'channel', label: 'Channel', render: (e) => K().channelBadge(e.channel) },
      { key: 'amount', label: 'Amount', align: 'right', render: (e) => money(e.amount) },
      { key: 'paid', label: 'Paid', align: 'right', render: (e) => money(e.paid, 'text-emerald-700') },
      { key: 'balance', label: 'Balance', align: 'right', render: (e) => money(e.balance, e.balance > 0 ? 'font-semibold text-amber-700' : 'text-stone-400') },
      { key: 'due_date', label: 'Collect by', render: dueCell },
      { key: 'status', label: 'Status', render: (e) => K().statusBadge(e.status) },
      { key: 'notes', label: 'Notes', render: (e) => h('span', { class: 'text-sm text-stone-600' }, e.notes || (e.sale_id ? `Sale #${e.sale_id}` : '')) },
    ].filter(Boolean);
  }

  function channelSelect() {
    const opts = [{ value: '', label: 'Retail & wholesale' }, { value: 'retail', label: 'Retail' }];
    if (App.can('credits:wholesale')) opts.push({ value: 'wholesale', label: 'Wholesale' });
    if (opts.length === 2) return null;
    return App.ui.select(opts, { 'aria-label': 'Channel' });
  }

  function filterBar(...items) {
    return h('div', { class: 'flex flex-wrap items-end gap-3' }, items.filter(Boolean));
  }

  function makeLoader(box, fn) {
    let seq = 0;
    return async () => {
      const my = ++seq;
      box.replaceChildren(App.ui.spinner());
      try {
        const node = await fn();
        if (my === seq) box.replaceChildren(node);
      } catch (e) {
        if (my === seq) box.replaceChildren(App.ui.empty(e.message || 'Could not load', 'alert'));
      }
    };
  }

  // ------------------------------- By customer ------------------------------ //
  function buildByCustomer() {
    const q = App.ui.input({ type: 'search', placeholder: 'Search name, nickname or phone', 'aria-label': 'Search customers' });
    const st = App.ui.select([{ value: 'open', label: 'With balance' }, { value: 'all', label: 'Everyone with credit' }], { 'aria-label': 'Show' });
    const box = h('div', {});
    const load = makeLoader(box, async () => {
      const rows = await App.api.get('/api/credits/by-customer', { status: st.value, q: q.value.trim() || null });
      return K().scrollWrap(App.ui.table({
        columns: [
          {
            key: 'name', label: 'Customer',
            render: (r) => h('div', {},
              h('div', { class: 'font-semibold text-stone-900 flex items-center gap-2' }, r.name, r.overdue ? App.ui.badge('Overdue', 'red') : null),
              h('div', { class: 'text-xs text-stone-500' }, [r.phone, r.place].filter(Boolean).join(' · '))),
          },
          { key: 'balance', label: 'Balance', align: 'right', render: (r) => money(r.balance, r.balance > 0 ? 'text-base font-bold text-amber-700' : 'text-stone-400') },
          { key: 'total_credit', label: 'Total credit', align: 'right', render: (r) => money(r.total_credit) },
          { key: 'total_paid', label: 'Paid', align: 'right', render: (r) => money(r.total_paid, 'text-emerald-700') },
          { key: 'open_count', label: 'Open', align: 'right', render: (r) => h('span', { class: 'tabular-nums' }, String(r.open_count || 0)) },
          { key: 'oldest_open_date', label: 'Oldest', render: (r) => r.oldest_open_date ? App.fmt.date(r.oldest_open_date) : '—' },
          { key: 'next_due_date', label: 'Next due', render: (r) => r.next_due_date ? h('span', { class: r.overdue ? 'text-rose-700 font-semibold' : '' }, App.fmt.date(r.next_due_date)) : '—' },
          { key: 'last_payment_on', label: 'Last payment', render: (r) => r.last_payment_on ? App.fmt.date(r.last_payment_on) : '—' },
        ],
        rows,
        empty: q.value.trim() ? 'No customer matches that search' : 'Nobody owes anything right now',
        onRowClick: (r) => openLedger(r.customer_id),
      }));
    });
    q.addEventListener('input', K().debounce(load, 300));
    st.addEventListener('change', load);
    return {
      el: h('div', { class: 'space-y-3' },
        filterBar(h('div', { class: 'flex-1 min-w-[14rem] max-w-md' }, q), h('div', { class: 'w-56' }, st)),
        K().sectionCard(null, box)),
      load,
    };
  }

  // --------------------------------- By date -------------------------------- //
  function buildByDate() {
    const today = App.fmt.today();
    let field = 'credit_date';
    const range = App.components.dateRange({ from: K().addDays(today, -30), to: today, onChange: () => load() });
    const seg = K().segmented({
      options: [{ value: 'credit_date', label: 'Credit given date' }, { value: 'due_date', label: 'Collect-by date' }],
      value: field, size: 'sm', label: 'Date field', onChange: (v) => {
        field = v;
        // upcoming due dates are in the future, so don't keep the 'last 30 days' window for them
        if (v === 'due_date') range.set('', '', true); else range.set(K().addDays(today, -30), today, true);
        load();
      },
    });
    const box = h('div', { class: 'space-y-4' });
    const load = makeLoader(box, async () => {
      const r = range.get();
      const groups = await App.api.get('/api/credits/by-date', { from: r.from, to: r.to, date_field: field });
      if (!groups.length) return App.ui.empty('No credits in this period', 'ledger');
      return h('div', { class: 'space-y-4' }, groups.map((g) => K().sectionCard(
        h('span', { class: 'flex flex-wrap items-center justify-between gap-2 w-full' },
          h('span', {}, App.fmt.date(g.date)),
          h('span', { class: 'text-sm font-normal text-stone-600 tabular-nums' },
            `Given ${App.fmt.money(g.total_amount || 0)} · Balance `, h('b', { class: 'text-amber-700' }, App.fmt.money(g.total_balance || 0)))),
        K().scrollWrap(App.ui.table({ columns: entryColumns(), rows: g.entries || [], empty: 'No entries', onRowClick: (e) => openLedger(e.customer_id) })))));
    });
    return {
      el: h('div', { class: 'space-y-3' }, filterBar(range.el, h('div', { class: 'min-w-[18rem]' }, seg.el)), box),
      load,
    };
  }

  // ------------------------------- All credits ------------------------------ //
  function buildAll() {
    const st = App.ui.select([{ value: 'open', label: 'Yet to collect' }, { value: 'settled', label: 'Collected' }, { value: 'all', label: 'All' }], { 'aria-label': 'Status' });
    const ch = channelSelect();
    const cust = App.components.customerPicker({ allowCreate: false, onChange: () => load() });
    const today = App.fmt.today();
    // blank dates = no limit, so old unpaid credits are never hidden by a default range
    const range = App.components.dateRange({ from: '', to: '', onChange: () => load() });
    const box = h('div', {});
    const load = makeLoader(box, async () => {
      const r = range.get();
      const rows = await App.api.get('/api/credits/entries', {
        status: st.value, channel: ch ? ch.value || null : null, customer_id: cust.getId() || null, from: r.from, to: r.to,
      });
      const totAmt = rows.reduce((s, e) => s + (e.amount || 0), 0);
      const totBal = rows.reduce((s, e) => s + (e.balance || 0), 0);
      return K().scrollWrap(App.ui.table({
        columns: entryColumns(), rows, empty: 'No credits match these filters',
        onRowClick: (e) => openLedger(e.customer_id),
        footer: rows.length ? h('div', { class: 'flex flex-wrap justify-end gap-4 font-semibold tabular-nums' },
          h('span', {}, `${rows.length} entries`), h('span', {}, 'Amount ' + App.fmt.money(totAmt)),
          h('span', { class: 'text-amber-700' }, 'Balance ' + App.fmt.money(totBal))) : null,
      }));
    });
    st.addEventListener('change', load);
    if (ch) ch.addEventListener('change', load);
    return {
      el: h('div', { class: 'space-y-3' },
        filterBar(App.ui.field({ label: 'Status', input: st }), ch ? App.ui.field({ label: 'Channel', input: ch }) : null,
          h('div', { class: 'min-w-[14rem]' }, App.ui.field({ label: 'Customer', input: cust.el })), range.el),
        K().sectionCard(null, box)),
      load,
    };
  }

  // ------------------------------- Collections ------------------------------ //
  function buildCollections() {
    const today = App.fmt.today();
    const range = App.components.dateRange({ from: today.slice(0, 8) + '01', to: today, onChange: () => load() });
    const ch = channelSelect();
    const box = h('div', {});
    const load = makeLoader(box, async () => {
      const r = range.get();
      const d = await App.api.get('/api/credits/collections', { from: r.from, to: r.to, channel: ch ? ch.value || null : null });
      const cols = [
        { key: 'paid_on', label: 'Paid on', render: (p) => h('span', { class: 'tabular-nums whitespace-nowrap' }, App.fmt.date(p.paid_on)) },
        { key: 'customer_name', label: 'Customer', render: (p) => h('span', { class: 'font-medium' }, p.customer_name) },
        { key: 'amount', label: 'Amount', align: 'right', render: (p) => money(p.amount, 'font-semibold text-emerald-700') },
        { key: 'mode', label: 'Mode', render: (p) => K().payBadge(p.mode) },
        { key: 'channel', label: 'Channel', render: (p) => p.channel ? K().channelBadge(p.channel) : '—' },
        { key: 'notes', label: 'Notes', render: (p) => h('span', { class: 'text-sm text-stone-600' }, p.notes || '') },
        { key: 'created_by', label: 'By', render: (p) => h('span', { class: 'text-sm text-stone-500' }, p.created_by || '') },
      ];
      if (App.can('credits:delete')) cols.push({ key: '_del', label: '', align: 'right', render: (p) => deletePaymentBtn(p, load) });
      return h('div', { class: 'space-y-3' },
        h('div', { class: 'flex items-baseline gap-2' }, h('span', { class: 'text-stone-500' }, 'Total collected'),
          h('span', { class: 'text-2xl font-bold tabular-nums text-emerald-700' }, App.fmt.money(d.total || 0))),
        K().scrollWrap(App.ui.table({ columns: cols, rows: d.payments || [], empty: 'No payments received in this period', onRowClick: (p) => openLedger(p.customer_id) })));
    });
    if (ch) ch.addEventListener('change', load);
    return {
      el: h('div', { class: 'space-y-3' }, filterBar(range.el, ch ? App.ui.field({ label: 'Channel', input: ch }) : null), K().sectionCard(null, box)),
      load,
    };
  }

  const BUILDERS = { customer: buildByCustomer, date: buildByDate, all: buildAll, collections: buildCollections };

  // ------------------------------- actions ---------------------------------- //
  function deletePaymentBtn(p, onDone) {
    const b = App.ui.btn('Undo', { kind: 'ghost', small: true, icon: 'trash', onClick: async () => {
      const ok = await App.ui.confirm({
        title: 'Undo payment?', danger: true, confirmText: 'Undo payment',
        message: `Remove the payment of ${App.fmt.money(p.amount)} from ${p.customer_name || 'this customer'} on ${App.fmt.date(p.paid_on)}? The balance goes back up.`,
      });
      if (!ok) return;
      try {
        await App.api.del(`/api/credits/payments/${p.id}`);
        App.ui.toast('Payment removed');
        afterChange();
        if (onDone) onDone();
      } catch (e) { /* toast shown by api */ }
    } });
    b.addEventListener('click', (e) => e.stopPropagation());
    return b;
  }

  /** Generic small form modal. fields: [{name,label,input,hint}] ; submit(values) -> Promise */
  function formModal({ title, fields, submitText, submit, size = 'sm', intro }) {
    const err = h('div', { class: 'hidden rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-sm p-3', role: 'alert' });
    const btn = App.ui.btn(submitText, { kind: 'primary', icon: 'check', type: 'submit' });
    btn.classList.add('min-h-[48px]', 'px-6');
    const form = h('form', { class: 'space-y-4', novalidate: true },
      intro || null,
      fields.map((f) => f.node || App.ui.field({ label: f.label, input: f.input, hint: f.hint })),
      err,
      h('div', { class: 'flex justify-end gap-2 pt-2' }, App.ui.btn('Cancel', { kind: 'ghost', onClick: () => m.close() }), btn));
    const m = App.ui.modal({ title, body: form, size });
    let busy = false;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      err.classList.add('hidden');
      busy = true; btn.disabled = true;
      try {
        await submit();
        m.close();
      } catch (ex) {
        err.textContent = ex.message || 'Could not save';
        err.classList.remove('hidden');
      } finally {
        busy = false; btn.disabled = false;
      }
    });
    setTimeout(() => { const f = form.querySelector('input:not([type=hidden]),select,textarea'); if (f) f.focus(); }, 60);
    return m;
  }
  const invalid = (msg) => Object.assign(new Error(msg), { code: 'client' });

  function paymentFields(defaultAmount) {
    const amount = App.ui.input({ type: 'text', inputmode: 'numeric', placeholder: defaultAmount ? String(defaultAmount) : 'Amount', autocomplete: 'off' });
    if (defaultAmount) amount.value = String(defaultAmount);
    const mode = K().segmented({ options: [{ value: 'cash', label: 'Cash', tone: 'green' }, { value: 'upi', label: 'UPI', tone: 'blue' }], value: 'cash', label: 'Mode' });
    const paidOn = App.ui.input({ type: 'date', value: App.fmt.today(), max: App.fmt.today() });
    const notes = App.ui.input({ type: 'text', placeholder: 'Optional', maxlength: 200 });
    return {
      fields: [
        { label: 'Amount received (₹)', input: amount },
        { node: h('div', { class: 'space-y-1' }, h('div', { class: 'text-sm font-medium text-stone-700' }, 'Paid by'), mode.el) },
        { label: 'Date', input: paidOn },
        { label: 'Notes', input: notes },
      ],
      values(max) {
        const a = K().parseMoney(amount.value);
        if (a == null || Number.isNaN(a) || a <= 0) throw invalid('Enter the amount received (whole rupees).');
        if (max != null && a > max) throw invalid(`That is more than the balance of ${App.fmt.money(max)}.`);
        return { amount: a, mode: mode.get(), paid_on: paidOn.value || undefined, notes: notes.value.trim() || undefined };
      },
    };
  }

  function openEntryPay(entry, onDone) {
    const pf = paymentFields(entry.balance);
    formModal({
      title: 'Record payment', submitText: 'Save payment', fields: pf.fields,
      intro: h('p', { class: 'text-sm text-stone-600' }, `${entry.customer_name} · credit of ${App.fmt.money(entry.amount)} on ${App.fmt.date(entry.credit_date)} · balance `, h('b', {}, App.fmt.money(entry.balance))),
      submit: async () => {
        const body = pf.values(entry.balance);
        await App.api.post(`/api/credits/entries/${entry.id}/payments`, body, { silent: true });
        App.ui.toast(`Payment of ${App.fmt.money(body.amount)} recorded`);
        afterChange();
        if (onDone) onDone();
      },
    });
  }

  function openEditEntry(entry, onDone) {
    const due = App.ui.input({ type: 'date', value: entry.due_date || '' });
    const notes = App.ui.textarea({ rows: 2, maxlength: 500 });
    notes.value = entry.notes || '';
    formModal({
      title: 'Edit credit', submitText: 'Save',
      fields: [{ label: 'When to collect', input: due, hint: 'Clear the date to remove it' }, { label: 'Notes', input: notes }],
      submit: async () => {
        await App.api.put(`/api/credits/entries/${entry.id}`, { due_date: due.value || null, notes: notes.value.trim() }, { silent: true });
        App.ui.toast('Credit updated');
        afterChange();
        if (onDone) onDone();
      },
    });
  }

  async function deleteEntry(entry, onDone) {
    const ok = await App.ui.confirm({
      title: 'Delete credit entry?', danger: true, confirmText: 'Delete',
      message: `Delete the manual credit of ${App.fmt.money(entry.amount)} for ${entry.customer_name} (${App.fmt.date(entry.credit_date)})? This cannot be undone.`,
    });
    if (!ok) return;
    try {
      await App.api.del(`/api/credits/entries/${entry.id}`);
      App.ui.toast('Credit entry deleted');
      afterChange();
      if (onDone) onDone();
    } catch (e) { /* api toast */ }
  }

  function openAddCredit(presetCustomer) {
    const cust = App.components.customerPicker({ required: true, allowCreate: true });
    if (presetCustomer && cust.setCustomer) cust.setCustomer(presetCustomer);
    const amount = App.ui.input({ type: 'text', inputmode: 'numeric', placeholder: 'e.g. 1500', autocomplete: 'off' });
    const date = App.ui.input({ type: 'date', value: App.fmt.today(), max: App.fmt.today() });
    const due = App.ui.input({ type: 'date' });
    const notes = App.ui.input({ type: 'text', placeholder: 'e.g. from the old book', maxlength: 300 });
    const chOpts = [{ value: 'retail', label: 'Retail' }];
    if (App.can('credits:wholesale')) chOpts.push({ value: 'wholesale', label: 'Wholesale' });
    const ch = App.ui.select(chOpts, {});
    formModal({
      title: 'Add credit (manual entry)', submitText: 'Add credit', size: 'md',
      fields: [
        { label: 'Customer', input: cust.el },
        { label: 'Amount (₹)', input: amount },
        { node: h('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-3' }, App.ui.field({ label: 'Credit date', input: date }), App.ui.field({ label: 'When to collect', input: due, hint: 'Optional' })) },
        chOpts.length > 1 ? { label: 'Channel', input: ch } : null,
        { label: 'Notes', input: notes },
      ].filter(Boolean),
      submit: async () => {
        const id = cust.getId();
        if (!id) throw invalid('Pick or add the customer.');
        const a = K().parseMoney(amount.value);
        if (a == null || Number.isNaN(a) || a <= 0) throw invalid('Enter the amount (whole rupees).');
        await App.api.post('/api/credits/entries', {
          customer_id: id, channel: ch.value || 'retail', amount: a,
          credit_date: date.value || undefined, due_date: due.value || undefined, notes: notes.value.trim() || undefined,
        }, { silent: true });
        App.ui.toast(`Credit of ${App.fmt.money(a)} added`);
        afterChange();
        reloadLedger();
      },
    });
  }

  // --------------------------------- ledger --------------------------------- //
  let ledger = null; // {m, id}
  function reloadLedger() {
    if (ledger && ledger.m && ledger.m.el && document.body.contains(ledger.m.el)) fillLedger();
  }

  function openLedger(customerId) {
    const m = App.ui.modal({ title: 'Customer credit', body: h('div', {}, App.ui.spinner()), size: 'lg' });
    ledger = { m, id: customerId };
    fillLedger();
  }

  async function fillLedger() {
    const { m, id } = ledger;
    let d;
    try {
      d = await App.api.get(`/api/credits/customer/${id}`, null, { silent: true });
    } catch (e) {
      m.body.replaceChildren(App.ui.empty(e.message || 'Could not load', 'alert'));
      return;
    }
    const c = d.customer || {};
    const s = d.summary || {};
    if (m.setTitle) m.setTitle(c.name || 'Customer credit');
    const canEdit = App.can('credits:edit');
    const canDel = App.can('credits:delete');

    const head = h('div', { class: 'space-y-3' },
      h('div', { class: 'flex flex-wrap gap-x-4 gap-y-1 text-sm text-stone-600' },
        c.phone ? h('a', { href: 'tel:' + c.phone, class: 'inline-flex items-center gap-1 text-sky-700' }, App.icon('phone', 'w-4 h-4'), c.phone) : null,
        c.place ? h('span', {}, c.place) : null,
        c.notes ? h('span', { class: 'italic' }, c.notes) : null),
      h('div', { class: 'grid grid-cols-3 gap-3' },
        App.components.stat({ label: 'Total credit', value: App.fmt.money(s.total_credit || 0) }),
        App.components.stat({ label: 'Paid', value: App.fmt.money(s.total_paid || 0), tone: 'green' }),
        App.components.stat({ label: 'Balance', value: App.fmt.money(s.balance || 0), tone: s.balance > 0 ? 'amber' : undefined })));

    let payBox = null;
    if (canEdit && s.balance > 0) {
      const pf = paymentFields(null);
      const err = h('p', { class: 'text-sm text-rose-600' });
      const btn = App.ui.btn('Record payment', { kind: 'primary', icon: 'rupee', type: 'submit' });
      btn.classList.add('min-h-[48px]');
      payBox = h('form', { class: 'rounded-2xl border border-emerald-200 bg-emerald-50/50 p-4 space-y-3', novalidate: true },
        h('div', { class: 'font-semibold text-stone-800' }, 'Record a payment'),
        h('p', { class: 'text-xs text-stone-500' }, 'The amount is applied to the oldest credit first.'),
        h('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-3' }, pf.fields.map((f) => f.node || App.ui.field({ label: f.label, input: f.input }))),
        err,
        h('div', { class: 'flex justify-end' }, btn));
      payBox.addEventListener('submit', async (e) => {
        e.preventDefault();
        err.textContent = '';
        let body;
        try { body = pf.values(s.balance); } catch (ex) { err.textContent = ex.message; return; }
        btn.disabled = true;
        try {
          const r = await App.api.post(`/api/credits/customer/${id}/payments`, body, { silent: true });
          App.ui.toast(`Payment of ${App.fmt.money(r && r.allocated != null ? r.allocated : body.amount)} recorded`);
          afterChange();
          fillLedger();
        } catch (ex) {
          err.textContent = ex.message || 'Could not save the payment';
          btn.disabled = false;
        }
      });
    }

    const entries = d.entries || [];
    const list = h('div', { class: 'space-y-3' },
      entries.length ? entries.map((e) => entryCard(e, { canEdit, canDel })) : App.ui.empty('No credit entries', 'ledger'));

    const addBtn = canEdit ? App.ui.btn('Add credit', { kind: 'secondary', icon: 'plus', small: true, onClick: () => openAddCredit({ id: c.id, name: c.name, phone: c.phone, place: c.place }) }) : null;

    m.body.replaceChildren(h('div', { class: 'space-y-4' },
      head, payBox,
      h('div', { class: 'flex items-center justify-between' }, h('h4', { class: 'font-semibold text-stone-800' }, 'Credit history (oldest first)'), addBtn),
      list));
  }

  function entryCard(e, { canEdit, canDel }) {
    const actions = h('div', { class: 'flex flex-wrap gap-2' });
    if (canEdit && e.balance > 0) actions.append(App.ui.btn('Pay', { kind: 'primary', small: true, icon: 'rupee', onClick: () => openEntryPay(e, fillLedger) }));
    if (canEdit) actions.append(App.ui.btn('Edit', { kind: 'secondary', small: true, icon: 'edit', onClick: () => openEditEntry(e, fillLedger) }));
    if (e.sale_id) actions.append(App.ui.btn(`Sale #${e.sale_id}`, { kind: 'ghost', small: true, icon: 'eye', onClick: () => K().openSale(e.sale_id) }));
    if (canDel && !e.sale_id && !(e.payments || []).length && !e.paid) {
      actions.append(App.ui.btn('Delete', { kind: 'ghost', small: true, icon: 'trash', onClick: () => deleteEntry(e, fillLedger) }));
    }
    const pays = (e.payments || []).map((p) => h('div', { class: 'flex flex-wrap items-center justify-between gap-2 py-1.5 border-t border-stone-100 text-sm' },
      h('div', { class: 'flex flex-wrap items-center gap-2' },
        h('span', { class: 'tabular-nums text-stone-500' }, App.fmt.date(p.paid_on)),
        K().payBadge(p.mode),
        h('span', { class: 'font-semibold text-emerald-700 tabular-nums' }, App.fmt.money(p.amount)),
        p.notes ? h('span', { class: 'text-stone-500' }, p.notes) : null,
        p.created_by ? h('span', { class: 'text-xs text-stone-400' }, 'by ' + p.created_by) : null),
      canDel ? deletePaymentBtn(Object.assign({ customer_name: e.customer_name }, p), fillLedger) : null));

    return h('div', { class: 'rounded-xl border p-3 space-y-2 ' + (e.overdue ? 'border-rose-300 bg-rose-50/50' : 'border-stone-200 bg-white') },
      h('div', { class: 'flex flex-wrap items-start justify-between gap-2' },
        h('div', { class: 'space-y-0.5' },
          h('div', { class: 'flex flex-wrap items-center gap-2' },
            h('span', { class: 'font-semibold tabular-nums' }, App.fmt.date(e.credit_date)),
            K().channelBadge(e.channel), K().statusBadge(e.status)),
          h('div', { class: 'text-sm text-stone-600 flex flex-wrap gap-x-2 items-center' }, 'Collect by ', dueCell(e)),
          e.notes ? h('div', { class: 'text-sm text-stone-600 whitespace-pre-wrap' }, e.notes) : null),
        h('div', { class: 'text-right tabular-nums text-sm' },
          h('div', {}, 'Credit ', h('b', {}, App.fmt.money(e.amount))),
          h('div', { class: 'text-emerald-700' }, 'Paid ' + App.fmt.money(e.paid || 0)),
          h('div', { class: e.balance > 0 ? 'text-amber-700 font-bold text-base' : 'text-stone-400' }, 'Balance ' + App.fmt.money(e.balance || 0)))),
      pays.length ? h('div', {}, pays) : null,
      actions.children.length ? actions : null);
  }

  App.registerTab('credits', { init, show });
})();

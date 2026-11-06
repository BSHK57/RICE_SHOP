/*
 * shared/saleform.js — the ONE line-item form used for:
 *   - new retail sale        (POST /api/sales/retail, live preview via POST /api/sales/retail/preview)
 *   - new wholesale sale     (POST /api/sales/wholesale)
 *   - new / edit reminder    (POST /api/orders, PUT /api/orders/<id>) for either channel
 * Exposes `App.saleForm.open(opts)`:
 *   opts = {
 *     channel: 'retail'|'wholesale',     // initial channel
 *     mode: 'sale'|'reminder',           // initial mode ('Send later' toggle switches it, if allowed)
 *     order?: Order,                     // edit an existing pending order (forces reminder mode)
 *     date?: 'YYYY-MM-DD',               // default sale date (retail) / sent date (wholesale)
 *     chooseChannel?: bool,              // reminder mode: show a Retail/Wholesale chooser (limited by perms)
 *     allowModeToggle?: bool (default true) // show the 'Send later' toggle (needs orders:edit)
 *     onDone?(result)
 *   }
 *
 * Non-obvious behaviour
 *   - Retail amounts come ONLY from the server preview (debounced 300 ms; stale responses are ignored).
 *     Preview lines can outnumber form lines (loose auto-split into bags); they are mapped back to form
 *     lines by rice type + grams, and when that mapping fails only the total is shown.
 *   - Users without retail:edit (e.g. reminder-only users) get no preview: prices are settled when sent.
 *   - Wholesale totals are computed client-side for display only; the server recomputes.
 *   - Discounts are never computed or shown here; the 'Price for this customer' field is simply sent
 *     as unit_price when filled in.
 *   - Enter inside a line's quantity/price adds a new line; Enter in the other plain inputs or
 *     Ctrl/Cmd+Enter anywhere submits.
 */
(function () {
  'use strict';
  const App = (window.App = window.App || {});
  const h = (...a) => App.ui.h(...a);
  const K = () => App.salekit;

  const BAG_SIZES = [18, 20, 25, 26];
  const KG_RE = /^\d*\.?\d+$/;
  const INT_RE = /^\d+$/;

  function pad(n) { return String(n).padStart(2, '0'); }
  function defaultSendAt() {
    const d = new Date(Date.now() + 60 * 60 * 1000);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
  }
  function plural(n, w) { return `${n} ${w}${n === 1 ? '' : 's'}`; }
  function lineInput(attrs) {
    const el = App.ui.input(attrs);
    el.dataset.lineInput = '1';
    return el;
  }
  function submitInput(attrs) {
    const el = App.ui.input(attrs);
    el.dataset.submitOnEnter = '1';
    return el;
  }
  function focusPicker(picker, fallback) {
    const el = picker.el;
    const f = el.matches && el.matches('input,select') ? el : el.querySelector('input,select');
    (f || fallback).focus();
  }
  function small(text, cls = 'text-xs text-stone-500') { return h('p', { class: cls }, text); }

  let catalogCache = null; // [RiceType] for retail, refreshed on each open()
  async function loadCatalog() {
    try {
      const rows = await App.api.get('/api/inventory/rice-types', null, { silent: true });
      catalogCache = {};
      (rows || []).forEach((r) => { catalogCache[r.type_name] = r; });
    } catch (e) {
      catalogCache = catalogCache || {};
    }
    return catalogCache;
  }

  // ------------------------------------------------------------------------ //
  // Retail line
  // ------------------------------------------------------------------------ //
  function retailLine(init, ctx) {
    const picker = App.components.ricePicker({ mode: 'retail', onChange: () => { paintInfo(); ctx.changed(); } });
    const info = small('Pick a rice type');
    const kind = K().segmented({
      options: [{ value: 'loose', label: 'Loose (kg)' }, { value: 'bag', label: 'Bag' }],
      value: init.item_kind || 'loose', size: 'sm', label: 'Loose or bag',
      onChange: () => { paintKind(); ctx.changed(); },
    });
    const qty = lineInput({ type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-label': 'Quantity' });
    const qtyHint = small('');
    const priceIn = lineInput({ type: 'text', inputmode: 'decimal', autocomplete: 'off' });
    const priceLabel = h('span', {});
    const amount = h('div', { class: 'text-lg font-bold tabular-nums text-stone-800 text-right' }, '—');
    const note = h('div', { class: 'text-xs text-emerald-700 space-y-0.5' });
    const err = small('', 'text-xs text-rose-600');
    const removeBtn = h('button', {
      type: 'button', class: 'p-2 rounded-lg text-stone-400 hover:text-rose-600 hover:bg-rose-50', title: 'Remove line',
      'aria-label': 'Remove line', on: { click: () => ctx.remove(api) },
    }, App.icon('trash', 'w-5 h-5'));

    if (init.rice_type) picker.setValue(init.rice_type);
    if (init.item_kind === 'bag') qty.value = init.bags != null ? String(init.bags) : '';
    else if (init.grams != null) qty.value = String(App.fmt.gramsToKg(init.grams));
    if (init.unit_price != null) priceIn.value = String(init.unit_price);

    [qty, priceIn].forEach((i) => i.addEventListener('input', () => { paintQtyHint(); ctx.changed(); }));

    function type() { return (catalogCache || {})[picker.getValue()] || (picker.getItem && picker.getItem()) || null; }
    function paintInfo() {
      const t = type();
      if (!picker.getValue()) { info.textContent = 'Pick a rice type'; info.className = 'text-xs text-stone-500'; paintKind(); return; }
      if (!t) { info.textContent = ''; paintKind(); return; }
      const parts = [`Standard ${K().price(t.price_per_kg)}/kg`];
      if (t.bag_price != null) parts.push(`Bag ${K().price(t.bag_price)}${t.bag_size_grams ? ' (' + App.fmt.kg(t.bag_size_grams) + ')' : ''}`);
      else parts.push('no standard bag price');
      parts.push(`Stock: ${plural(t.bags_qty || 0, 'bag')} + ${App.fmt.kg(t.loose_grams || 0)} loose`);
      info.textContent = parts.join(' · ');
      const low = t.low_stock_bags > 0 && t.bags_qty <= t.low_stock_bags;
      info.className = 'text-xs ' + (low ? 'text-amber-700' : 'text-stone-500');
      paintKind();
    }
    function paintKind() {
      const t = type();
      const isBag = kind.get() === 'bag';
      qty.placeholder = isBag ? 'Bags, e.g. 1' : 'kg, e.g. 2.5 or 0.25';
      qty.setAttribute('inputmode', isBag ? 'numeric' : 'decimal');
      priceLabel.textContent = `Price for this customer (₹${isBag ? '/bag' : '/kg'})`;
      const std = t ? (isBag ? t.bag_price : t.price_per_kg) : null;
      priceIn.placeholder = std != null ? `Standard ${K().price(std)} — leave blank` : (isBag ? 'Enter bag price' : 'Standard price');
      paintQtyHint();
    }
    function paintQtyHint() {
      const v = qty.value.trim();
      if (kind.get() === 'loose' && KG_RE.test(v)) {
        const g = App.fmt.kgToGrams(v);
        qtyHint.textContent = g > 0 ? `= ${App.fmt.kg(g)}` : '';
      } else qtyHint.textContent = '';
    }

    function payload() {
      const rice = picker.getValue();
      const v = qty.value.trim();
      const p = priceIn.value.trim();
      if (!rice && !v && !p) return { empty: true };
      if (!rice) return { error: 'Pick a rice type' };
      const item = { rice_type: rice, item_kind: kind.get() };
      if (kind.get() === 'loose') {
        if (!KG_RE.test(v)) return { error: 'Enter the kg (e.g. 2.5)' };
        const g = App.fmt.kgToGrams(v);
        if (!(g > 0)) return { error: 'Quantity must be more than 0' };
        item.grams = g;
      } else {
        if (!INT_RE.test(v) || Number(v) < 1) return { error: 'Enter whole bags (1, 2, …)' };
        item.bags = Number(v);
      }
      if (p !== '') {
        const n = K().parsePrice(p);
        if (Number.isNaN(n)) return { error: 'Price must be a number' };
        item.unit_price = n;
      }
      return { item };
    }

    paintInfo();
    const api = {
      kind: 'retail',
      payload,
      focus() { focusPicker(picker, qty); },
      setAmount(v) { amount.textContent = v == null ? '—' : App.fmt.money(v); },
      setNotes(list) { note.replaceChildren(...list.map((t) => h('div', {}, t))); },
      setError(t) { err.textContent = t || ''; },
      refreshInfo: paintInfo,
      el: h('div', { class: 'rounded-xl border border-stone-200 bg-stone-50/60 p-3 space-y-2' },
        h('div', { class: 'grid grid-cols-1 md:grid-cols-12 gap-3 items-start' },
          h('div', { class: 'md:col-span-5 space-y-1' }, picker.el, info),
          h('div', { class: 'md:col-span-3' }, kind.el),
          h('div', { class: 'md:col-span-2 space-y-1' }, qty, qtyHint),
          h('div', { class: 'md:col-span-2 flex items-center justify-between md:justify-end gap-2' }, amount, removeBtn)),
        h('div', { class: 'grid grid-cols-1 md:grid-cols-12 gap-3 items-start' },
          h('label', { class: 'md:col-span-5 text-sm text-stone-600 space-y-1 block' }, priceLabel, priceIn),
          h('div', { class: 'md:col-span-7 pt-1' }, note, err))),
    };
    return api;
  }

  // ------------------------------------------------------------------------ //
  // Wholesale line
  // ------------------------------------------------------------------------ //
  function wholesaleLine(init, ctx) {
    const picker = App.components.ricePicker({ mode: 'wholesale', onChange: () => ctx.changed() });
    const kind = K().segmented({
      options: [{ value: 'bag', label: 'Bags' }, { value: 'loose', label: 'Loose (sample)' }],
      value: init.item_kind || 'bag', size: 'sm', label: 'Bags or loose',
      onChange: () => { paintKind(); ctx.changed(); },
    });
    const bags = lineInput({ type: 'text', inputmode: 'numeric', placeholder: 'e.g. 10', autocomplete: 'off' });
    const sizeSel = App.ui.select(
      BAG_SIZES.map((s) => ({ value: String(s), label: `${s} kg` })).concat([{ value: 'custom', label: 'Other…' }]), {});
    const sizeCustom = lineInput({ type: 'text', inputmode: 'decimal', placeholder: 'kg per bag', autocomplete: 'off' });
    const bagPrice = lineInput({ type: 'text', inputmode: 'decimal', autocomplete: 'off' });
    const kgIn = lineInput({ type: 'text', inputmode: 'decimal', placeholder: 'kg, e.g. 1', autocomplete: 'off' });
    const kgPrice = lineInput({ type: 'text', inputmode: 'decimal', autocomplete: 'off' });
    const amount = h('div', { class: 'text-lg font-bold tabular-nums text-stone-800 text-right' }, '—');
    const err = small('', 'text-xs text-rose-600');
    const removeBtn = h('button', {
      type: 'button', class: 'p-2 rounded-lg text-stone-400 hover:text-rose-600 hover:bg-rose-50', title: 'Remove line',
      'aria-label': 'Remove line', on: { click: () => ctx.remove(api) },
    }, App.icon('trash', 'w-5 h-5'));

    sizeSel.value = '25';
    if (init.rice_type) picker.setValue(init.rice_type);
    if (init.item_kind === 'loose') {
      if (init.grams != null) kgIn.value = String(App.fmt.gramsToKg(init.grams));
      if (init.unit_price != null) kgPrice.value = String(init.unit_price);
    } else {
      if (init.bags != null) bags.value = String(init.bags);
      if (init.bag_size_grams) {
        const kg = App.fmt.gramsToKg(init.bag_size_grams);
        if (BAG_SIZES.includes(kg)) sizeSel.value = String(kg);
        else { sizeSel.value = 'custom'; sizeCustom.value = String(kg); }
      }
      if (init.unit_price != null) bagPrice.value = String(init.unit_price);
    }
    sizeSel.addEventListener('change', () => { paintKind(); ctx.changed(); });
    [bags, sizeCustom, bagPrice, kgIn, kgPrice].forEach((i) => i.addEventListener('input', () => ctx.changed()));

    const bagRow = h('div', { class: 'grid grid-cols-2 md:grid-cols-4 gap-3' },
      App.ui.field({ label: 'Bags', input: bags }),
      App.ui.field({ label: 'Bag size', input: sizeSel }),
      h('div', { class: 'hidden' }, App.ui.field({ label: 'Bag size (kg)', input: sizeCustom })),
      App.ui.field({ label: 'Price per bag (₹)', input: bagPrice }));
    const customWrap = bagRow.children[2];
    const looseRow = h('div', { class: 'grid grid-cols-2 gap-3' },
      App.ui.field({ label: 'Quantity (kg)', input: kgIn }),
      App.ui.field({ label: 'Price per kg (₹)', input: kgPrice }));

    function paintKind() {
      const isBag = kind.get() === 'bag';
      bagRow.classList.toggle('hidden', !isBag);
      looseRow.classList.toggle('hidden', isBag);
      customWrap.classList.toggle('hidden', sizeSel.value !== 'custom');
      const opt = ctx.mode() === 'reminder' ? 'Optional (add when sent)' : 'Required';
      bagPrice.placeholder = opt;
      kgPrice.placeholder = opt;
    }

    function payload() {
      const rice = (picker.getValue() || '').trim();
      const isBag = kind.get() === 'bag';
      const q = (isBag ? bags : kgIn).value.trim();
      const p = (isBag ? bagPrice : kgPrice).value.trim();
      if (!rice && !q && !p) return { empty: true };
      if (!rice) return { error: 'Enter the rice type' };
      const item = { rice_type: rice, item_kind: kind.get() };
      if (isBag) {
        if (!INT_RE.test(q) || Number(q) < 1) return { error: 'Enter the number of bags' };
        item.bags = Number(q);
        const sizeKg = sizeSel.value === 'custom' ? sizeCustom.value.trim() : sizeSel.value;
        if (!KG_RE.test(sizeKg)) return { error: 'Enter the bag size in kg' };
        item.bag_size_grams = App.fmt.kgToGrams(sizeKg);
        if (!(item.bag_size_grams > 0)) return { error: 'Bag size must be more than 0' };
      } else {
        if (!KG_RE.test(q)) return { error: 'Enter the kg (e.g. 1.5)' };
        item.grams = App.fmt.kgToGrams(q);
        if (!(item.grams > 0)) return { error: 'Quantity must be more than 0' };
      }
      if (p === '') {
        if (ctx.mode() !== 'reminder') return { error: isBag ? 'Enter the price per bag' : 'Enter the price per kg' };
      } else {
        const n = K().parsePrice(p);
        if (Number.isNaN(n)) return { error: 'Price must be a number' };
        item.unit_price = n;
      }
      return { item };
    }
    /** Display-only amount (server recomputes). */
    function localAmount() {
      const r = payload();
      if (!r.item || r.item.unit_price == null) return null;
      const it = r.item;
      return it.item_kind === 'bag' ? Math.round(it.unit_price * it.bags) : Math.round(it.unit_price * it.grams / 1000);
    }

    paintKind();
    const api = {
      kind: 'wholesale',
      payload,
      localAmount,
      repaint: paintKind,
      focus() { focusPicker(picker, bags); },
      setAmount(v) { amount.textContent = v == null ? '—' : App.fmt.money(v); },
      setNotes() {},
      setError(t) { err.textContent = t || ''; },
      el: h('div', { class: 'rounded-xl border border-stone-200 bg-stone-50/60 p-3 space-y-3' },
        h('div', { class: 'grid grid-cols-1 md:grid-cols-12 gap-3 items-start' },
          h('div', { class: 'md:col-span-5 space-y-1' }, picker.el, small('Type a new name to add it — new names are saved for next time')),
          h('div', { class: 'md:col-span-4' }, kind.el),
          h('div', { class: 'md:col-span-3 flex items-center justify-between md:justify-end gap-2' }, amount, removeBtn)),
        bagRow, looseRow, err),
    };
    return api;
  }

  // ------------------------------------------------------------------------ //
  // The form
  // ------------------------------------------------------------------------ //
  async function open(opts = {}) {
    const order = opts.order || null;
    const state = {
      channel: order ? order.channel : (opts.channel || 'retail'),
      mode: order ? 'reminder' : (opts.mode || 'sale'),
      lines: [],
      preview: null,
      previewSeq: 0,
      saving: false,
    };
    const canRemind = App.can('orders:edit');
    const allowToggle = !order && opts.allowModeToggle !== false && canRemind;
    const canPreview = () => state.channel === 'retail' && App.can('retail:edit');

    const body = h('form', { class: 'space-y-5', novalidate: true });
    const m = App.ui.modal({ title: '', body, size: 'xl' });
    body.append(App.ui.spinner());
    await loadCatalog();
    body.replaceChildren();

    // channel chooser (reminder mode only)
    const channelOpts = [];
    if (App.can('retail:view')) channelOpts.push({ value: 'retail', label: 'Retail' });
    if (App.can('wholesale:view')) channelOpts.push({ value: 'wholesale', label: 'Wholesale' });
    const channelSeg = (opts.chooseChannel && !order && channelOpts.length > 1)
      ? K().segmented({ options: channelOpts, value: state.channel, size: 'sm', label: 'Channel', onChange: (v) => { state.channel = v; rebuildLines(); paint(); } })
      : null;

    // customer
    const custErr = small('', 'text-xs text-rose-600');
    const customer = App.components.customerPicker({
      value: order ? order.customer_id : undefined,
      required: false,
      allowCreate: true,
      onChange: () => { custErr.textContent = ''; changed(); },
    });
    if (order && order.customer_id && customer.setCustomer) {
      customer.setCustomer({ id: order.customer_id, name: order.customer_name, phone: order.customer_phone, place: order.customer_place });
    }
    const custLabel = h('span', {});

    // lines
    const linesBox = h('div', { class: 'space-y-3' });
    const addBtn = App.ui.btn('Add another rice', { kind: 'secondary', icon: 'plus', onClick: () => addLine({}, true) });
    const previewNote = h('div', { class: 'space-y-1 text-sm' });

    // dates
    const saleDate = submitInput({ type: 'date', value: opts.date || App.fmt.today(), max: App.fmt.today() });
    const sentOn = submitInput({ type: 'date', value: opts.date || App.fmt.today() });
    const callOn = submitInput({ type: 'date', value: order && order.call_received_on ? order.call_received_on : '' });
    const sendAt = submitInput({ type: 'datetime-local', value: order && order.requested_for ? order.requested_for.replace(' ', 'T').slice(0, 16) : defaultSendAt() });

    // payment
    const pay = K().segmented({
      options: [{ value: 'cash', label: 'Cash', tone: 'green' }, { value: 'upi', label: 'UPI', tone: 'blue' }, { value: 'credit', label: 'Credit', tone: 'amber' }],
      value: 'cash', label: 'Payment', onChange: () => { paint(); changed(); },
    });
    const advance = submitInput({ type: 'text', inputmode: 'numeric', placeholder: '0', autocomplete: 'off' });
    const dueDate = submitInput({ type: 'date' });
    const owe = h('div', { class: 'text-sm text-amber-800 font-semibold' });
    advance.addEventListener('input', paintTotals);
    const syncDueMin = () => { dueDate.min = (state.channel === 'wholesale' ? sentOn.value : saleDate.value) || ''; };
    saleDate.addEventListener('change', syncDueMin);
    sentOn.addEventListener('change', syncDueMin);
    const creditBox = h('div', { class: 'grid grid-cols-1 sm:grid-cols-3 gap-3 rounded-xl bg-amber-50 border border-amber-200 p-3' },
      App.ui.field({ label: 'Advance paid now (₹)', input: advance, hint: 'Optional' }),
      App.ui.field({ label: 'When to collect', input: dueDate, hint: 'Optional' }),
      h('div', { class: 'flex items-end pb-2' }, owe));

    const notes = App.ui.textarea({ rows: 2, placeholder: 'Anything to remember (optional)', maxlength: 500 });
    if (order && order.notes) notes.value = order.notes;

    // footer
    const totalEl = h('div', { class: 'text-2xl font-bold tabular-nums text-stone-900' }, '—');
    const totalSub = small('');
    const formErr = h('div', { class: 'hidden rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-sm p-3', role: 'alert' });
    const remindToggle = allowToggle ? h('button', {
      type: 'button',
      class: 'inline-flex items-center gap-2 rounded-xl border px-4 py-3 min-h-[48px] font-semibold',
      on: { click: () => { state.mode = state.mode === 'reminder' ? 'sale' : 'reminder'; paint(); changed(); } },
    }, App.icon('clock', 'w-5 h-5'), h('span', {}, 'Send later')) : null;
    const saveBtn = App.ui.btn('Save sale', { kind: 'primary', icon: 'check', type: 'submit' });
    saveBtn.classList.add('min-h-[48px]', 'px-6', 'text-base');
    const cancelBtn = App.ui.btn('Cancel', { kind: 'ghost', onClick: () => m.close() });

    // sections (visibility toggled in paint())
    const secChannel = channelSeg ? App.ui.field({ label: 'Reminder for', input: channelSeg.el }) : null;
    const secSaleDate = App.ui.field({ label: 'Sale date', input: saleDate });
    const secSentOn = App.ui.field({ label: 'Sent date', input: sentOn });
    const secCallOn = App.ui.field({ label: 'Call received on', input: callOn, hint: 'Optional' });
    const secSendAt = App.ui.field({ label: 'Send at (date & time)', input: sendAt });
    const secPayment = h('div', { class: 'space-y-3' }, h('div', { class: 'text-sm font-medium text-stone-700' }, 'Payment'), pay.el, creditBox);
    const dateRow = h('div', { class: 'grid grid-cols-1 sm:grid-cols-3 gap-3' });

    body.append(...[
      secChannel,
      h('div', { class: 'space-y-1' }, h('div', { class: 'text-sm font-medium text-stone-700' }, custLabel), customer.el, custErr),
      h('div', { class: 'space-y-2' },
        h('div', { class: 'text-sm font-medium text-stone-700' }, 'Items'),
        linesBox,
        h('div', { class: 'flex flex-wrap items-center gap-3' }, addBtn, small('Tip: press Enter in a quantity or price box to add another line')),
        previewNote),
      dateRow,
      secPayment,
      App.ui.field({ label: 'Notes', input: notes }),
      formErr,
      h('div', { class: 'sticky bottom-0 -mx-1 px-1 pt-3 pb-1 bg-white border-t border-stone-200 flex flex-wrap items-center justify-between gap-3' },
        h('div', {}, h('div', { class: 'text-xs uppercase tracking-wide text-stone-500' }, 'Total'), totalEl, totalSub),
        h('div', { class: 'flex flex-wrap gap-2 ml-auto' }, cancelBtn, remindToggle, saveBtn)),
    ].filter(Boolean));

    // ---------------------------- line management --------------------------- //
    const ctx = {
      changed: () => changed(),
      remove: (line) => {
        state.lines = state.lines.filter((l) => l !== line);
        line.el.remove();
        if (!state.lines.length) addLine({}, false);
        changed();
      },
      mode: () => state.mode,
    };
    function addLine(init, focus) {
      const line = state.channel === 'wholesale' ? wholesaleLine(init, ctx) : retailLine(init, ctx);
      state.lines.push(line);
      linesBox.append(line.el);
      if (focus) setTimeout(() => line.focus(), 30);
      return line;
    }
    function rebuildLines() {
      state.lines.forEach((l) => l.el.remove());
      state.lines = [];
      state.preview = null;
      addLine({}, false);
    }
    if (order && order.items && order.items.length) order.items.forEach((it) => addLine(it, false));
    else addLine({}, false);

    linesBox.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || !e.target.dataset || !e.target.dataset.lineInput) return;
      e.preventDefault();
      const idx = state.lines.findIndex((l) => l.el.contains(e.target));
      const next = state.lines[idx + 1];
      if (next) next.focus();
      else addLine({}, true);
    });
    body.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); submit(); return; }
      if (e.target.dataset && e.target.dataset.submitOnEnter) { e.preventDefault(); submit(); return; }
      // stop implicit form submission from other inputs (customer search, rice name …)
      if (e.target.tagName === 'INPUT') e.preventDefault();
    });
    body.addEventListener('submit', (e) => { e.preventDefault(); submit(); });

    // ------------------------------- painting ------------------------------- //
    function paint() {
      const wh = state.channel === 'wholesale';
      const rem = state.mode === 'reminder';
      const credit = pay.get() === 'credit';
      if (m.setTitle) {
        m.setTitle(order ? 'Edit reminder' : rem ? `New ${wh ? 'wholesale ' : ''}reminder (send later)` : wh ? 'New wholesale sale' : 'New retail sale');
      }
      custLabel.textContent = (wh || rem || credit) ? 'Customer (required)' : 'Customer (optional for cash / UPI)';
      secPayment.classList.toggle('hidden', rem);
      creditBox.classList.toggle('hidden', !credit);
      dateRow.replaceChildren(...[
        !wh && !rem ? secSaleDate : null,
        wh && !rem ? secSentOn : null,
        rem ? secSendAt : null,
        wh ? secCallOn : null,
      ].filter(Boolean));
      dateRow.classList.toggle('hidden', !dateRow.children.length);
      syncDueMin();
      saveBtn.replaceChildren(App.icon(rem ? 'clock' : 'check', 'w-5 h-5'), h('span', {}, order ? 'Save changes' : rem ? 'Save reminder' : 'Save sale'));
      if (remindToggle) {
        remindToggle.className = 'inline-flex items-center gap-2 rounded-xl border px-4 py-3 min-h-[48px] font-semibold ' +
          (rem ? 'bg-amber-100 border-amber-400 text-amber-900' : 'bg-white border-stone-300 text-stone-700 hover:bg-stone-50');
        remindToggle.setAttribute('aria-pressed', rem ? 'true' : 'false');
        remindToggle.title = rem ? 'Switch back to recording the sale now' : 'Save as a reminder to deliver later';
      }
      state.lines.forEach((l) => l.repaint && l.repaint());
      paintTotals();
    }

    function currentTotal() {
      if (state.channel === 'wholesale') {
        let sum = 0; let any = false; let missing = false;
        state.lines.forEach((l) => {
          const a = l.localAmount();
          const p = l.payload();
          if (a != null) { sum += a; any = true; } else if (!p.empty) missing = true;
        });
        return any ? { total: sum, partial: missing } : null;
      }
      return state.preview ? { total: state.preview.total, partial: false } : null;
    }

    function paintTotals() {
      const t = currentTotal();
      totalEl.textContent = t ? App.fmt.money(t.total) : '—';
      if (state.channel === 'wholesale') {
        state.lines.forEach((l) => l.setAmount(l.localAmount()));
        totalSub.textContent = t && t.partial ? 'Some lines have no price yet' : (t ? 'Final amount is calculated when saved' : '');
      } else if (!canPreview()) {
        totalSub.textContent = 'Prices are worked out when the order is marked as sent';
      } else totalSub.textContent = '';
      if (pay.get() === 'credit' && state.mode !== 'reminder') {
        const adv = K().parseMoney(advance.value) || 0;
        owe.textContent = t ? `Customer will owe ${App.fmt.money(Math.max(0, t.total - (Number.isNaN(adv) ? 0 : adv)))}` : '';
      } else owe.textContent = '';
    }

    // ------------------------------- preview -------------------------------- //
    const runPreview = K().debounce(async () => {
      if (!canPreview()) { state.preview = null; previewNote.replaceChildren(); paintTotals(); return; }
      const items = [];
      const owners = [];
      state.lines.forEach((l) => { const r = l.payload(); l.setError(''); if (r.item) { items.push(r.item); owners.push(l); } });
      state.lines.forEach((l) => { l.setAmount(null); l.setNotes([]); });
      if (!items.length) { state.preview = null; previewNote.replaceChildren(); paintTotals(); return; }
      const seq = ++state.previewSeq;
      const reqBody = { payment_mode: state.mode === 'reminder' ? 'cash' : pay.get(), customer_id: customer.getId() || null, items };
      let res;
      try {
        res = await App.api.post('/api/sales/retail/preview', reqBody, { silent: true });
      } catch (e) {
        if (seq !== state.previewSeq) return;
        state.preview = null;
        previewNote.replaceChildren(h('div', { class: 'rounded-lg bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2' }, e.message || 'Could not work out the price'));
        paintTotals();
        return;
      }
      if (seq !== state.previewSeq) return;
      state.preview = res;
      applyPreview(res, items, owners);
      paintTotals();
    }, 300);

    function applyPreview(res, items, owners) {
      const plines = (res.lines || []).slice();
      let pi = 0;
      const groups = [];
      let ok = true;
      for (let i = 0; i < items.length && ok; i++) {
        const it = items[i];
        const g = [];
        if (it.item_kind === 'bag') {
          const pl = plines[pi];
          if (pl && pl.rice_type === it.rice_type) { g.push(pl); pi++; } else ok = false;
        } else {
          let got = 0;
          while (got < it.grams && pi < plines.length && plines[pi].rice_type === it.rice_type) {
            const pl = plines[pi++];
            g.push(pl);
            got += pl.item_kind === 'bag' ? (pl.bags || 0) * (pl.bag_size_grams || 0) : (pl.grams || 0);
          }
          if (got !== it.grams) ok = false;
        }
        groups.push(g);
      }
      if (ok && pi !== plines.length) ok = false;
      const notesTop = [];
      if (ok) {
        groups.forEach((g, i) => {
          const line = owners[i];
          line.setAmount(g.reduce((s, x) => s + (x.amount || 0), 0));
          const n = [];
          const split = g.length > 1 || g.some((x) => x.auto_split);
          if (split) {
            const parts = g.map((x) => x.item_kind === 'bag' ? plural(x.bags, 'bag') + (x.bag_size_grams ? ` (${App.fmt.kg(x.bag_size_grams)})` : '') : App.fmt.kg(x.grams) + ' loose');
            n.push(`This is ${parts.join(' + ')}`);
          }
          const opened = g.reduce((s, x) => s + (x.opens_bags || 0), 0);
          if (opened && !(res.warnings || []).length) n.push(opened === 1 ? 'A bag will be opened for loose' : `${opened} bags will be opened for loose`);
          line.setNotes(n);
        });
      } else {
        // could not map: describe the bill as the server sees it
        (res.lines || []).forEach((x) => {
          const q = x.item_kind === 'bag' ? plural(x.bags, 'bag') : App.fmt.kg(x.grams) + ' loose';
          notesTop.push(`${x.rice_type}: ${q} = ${App.fmt.money(x.amount)}${x.opens_bags ? ' (opens ' + plural(x.opens_bags, 'bag') + ')' : ''}`);
        });
      }
      const box = [];
      if (notesTop.length) box.push(h('div', { class: 'rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 px-3 py-2 space-y-0.5' }, notesTop.map((t) => h('div', {}, t))));
      if (res.stock_ok === false) box.push(h('div', { class: 'rounded-lg bg-rose-50 border border-rose-200 text-rose-700 px-3 py-2 font-medium flex gap-2 items-center' }, App.icon('alert', 'w-4 h-4'), state.mode === 'reminder' ? 'Not enough stock right now — check before sending' : 'Not enough stock for this sale'));
      (res.warnings || []).forEach((w) => box.push(h('div', { class: 'rounded-lg bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2' }, w)));
      previewNote.replaceChildren(...box);
    }

    function changed() {
      formErr.classList.add('hidden');
      if (state.channel === 'retail') runPreview();
      paintTotals();
    }

    // -------------------------------- submit -------------------------------- //
    function showErr(msg) {
      formErr.textContent = msg;
      formErr.classList.remove('hidden');
    }
    async function submit() {
      if (state.saving) return;
      formErr.classList.add('hidden');
      const items = [];
      let bad = false;
      state.lines.forEach((l) => {
        const r = l.payload();
        l.setError(r.error || '');
        if (r.error) bad = true;
        if (r.item) items.push(r.item);
      });
      if (bad) return showErr('Please fix the highlighted lines.');
      if (!items.length) { state.lines[0] && state.lines[0].focus(); return showErr('Add at least one item.'); }
      const rem = state.mode === 'reminder';
      const wh = state.channel === 'wholesale';
      const custId = customer.getId() || null;
      const needCust = wh || rem || pay.get() === 'credit';
      if (needCust && !custId) {
        custErr.textContent = pay.get() === 'credit' && !wh && !rem ? 'A credit sale needs a customer' : 'Pick or add the customer';
        return showErr(custErr.textContent + '.');
      }
      const noteVal = notes.value.trim() || undefined;
      let url; let method = 'post'; let reqBody;
      if (rem) {
        if (!sendAt.value) return showErr('Choose when to send (date & time).');
        reqBody = {
          channel: state.channel, customer_id: custId, requested_for: sendAt.value.replace('T', ' '),
          call_received_on: wh ? (callOn.value || undefined) : undefined, notes: noteVal, items,
        };
        url = order ? `/api/orders/${order.id}` : '/api/orders';
        if (order) method = 'put';
      } else {
        const mode = pay.get();
        reqBody = { customer_id: custId, payment_mode: mode, notes: noteVal, items };
        if (mode === 'credit') {
          const adv = K().parseMoney(advance.value);
          if (Number.isNaN(adv)) return showErr('Advance must be a whole rupee amount.');
          const t = currentTotal();
          if (adv && t && adv > t.total) return showErr('Advance cannot be more than the total.');
          if (adv) reqBody.advance_paid = adv;
          if (dueDate.value) reqBody.due_date = dueDate.value;
        }
        if (wh) {
          reqBody.sent_on = sentOn.value || undefined;
          reqBody.call_received_on = callOn.value || undefined;
          url = '/api/sales/wholesale';
        } else {
          reqBody.sale_date = saleDate.value || undefined;
          url = '/api/sales/retail';
        }
      }
      state.saving = true;
      saveBtn.disabled = true;
      try {
        const res = await App.api[method](url, reqBody, { silent: true });
        m.close();
        if (rem) {
          App.ui.toast(order ? 'Reminder updated' : `Reminder saved for ${App.fmt.dateTime(reqBody.requested_for)}`);
          K().reload('reminders');
          K().reload('dashboard');
          K().refreshBell();
        } else {
          App.ui.toast(`${wh ? 'Wholesale' : 'Retail'} sale saved · ${App.fmt.money(res && res.total_amount != null ? res.total_amount : 0)}`);
          K().refreshAfterSale(state.channel);
        }
        if (opts.onDone) opts.onDone(res);
      } catch (e) {
        showErr(e.message || 'Could not save. Please try again.');
        state.saving = false;
        saveBtn.disabled = false;
      }
    }

    paint();
    changed();
    setTimeout(() => state.lines[0] && (order ? null : state.lines[0].focus()), 60);
    return m;
  }

  App.saleForm = { open, loadCatalog };
})();

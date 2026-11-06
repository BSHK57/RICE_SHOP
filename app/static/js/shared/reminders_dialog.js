/*
 * shared/reminders_dialog.js — reminder (pending order) UI shared by the Reminders tab and the bell
 * drawer (core/bell.js). Exposes `App.reminders`:
 *   openMarkSent(order, onDone)        'Mark as sent' dialog -> POST /api/orders/<id>/fulfill
 *   openEditor(order?, onDone)         new / edit reminder (delegates to App.saleForm in reminder mode)
 *   cancelOrder(order, onDone)         confirm -> POST /api/orders/<id>/cancel
 *   orderCard(order, {onChanged, compact, beforeAction}) -> Node  card with the order details + actions
 *       (beforeAction runs before any dialog opens - the bell uses it to close its drawer, since
 *        dialogs would otherwise stack underneath the drawer)
 *
 * Every successful action refreshes the bell (App.refreshBell) and reloads the affected tabs.
 * Wholesale items without a price get per-item price inputs in the mark-sent dialog (sent as
 * item_prices keyed by item id); retail items fall back to the standard price on the server.
 */
(function () {
  'use strict';
  const App = (window.App = window.App || {});
  const h = (...a) => App.ui.h(...a);
  const K = () => App.salekit;

  function afterChange(order) {
    K().reload('reminders');
    K().reload('dashboard');
    K().refreshBell();
  }

  function openEditor(order, onDone) {
    if (!App.saleForm) return;
    if (order) {
      return App.saleForm.open({ order, onDone });
    }
    const channel = App.can('retail:view') ? 'retail' : 'wholesale';
    return App.saleForm.open({ mode: 'reminder', channel, chooseChannel: true, allowModeToggle: false, onDone });
  }

  async function cancelOrder(order, onDone) {
    const ok = await App.ui.confirm({
      title: 'Cancel reminder?',
      message: `Cancel the ${order.channel} order for ${order.customer_name || 'this customer'} (${App.fmt.dateTime(order.requested_for)})? Nothing is sold or deducted.`,
      confirmText: 'Cancel order', cancelText: 'Keep it', danger: true,
    });
    if (!ok) return;
    try {
      await App.api.post(`/api/orders/${order.id}/cancel`, {});
      App.ui.toast('Reminder cancelled');
      afterChange(order);
      if (onDone) onDone();
    } catch (e) { /* api shows the error toast */ }
  }

  function openMarkSent(order, onDone) {
    const wh = order.channel === 'wholesale';
    const sentDate = App.ui.input({ type: 'date', value: App.fmt.today() });
    const creditAmt = App.ui.input({ type: 'text', inputmode: 'numeric', placeholder: 'blank = full amount', autocomplete: 'off' });
    const dueDate = App.ui.input({ type: 'date' });
    const notes = App.ui.input({ type: 'text', placeholder: 'Optional', maxlength: 300 });
    const err = h('div', { class: 'hidden rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-sm p-3', role: 'alert' });

    const creditBox = h('div', { class: 'hidden grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-xl bg-amber-50 border border-amber-200 p-3' },
      App.ui.field({ label: 'Credit amount (₹)', input: creditAmt, hint: 'Leave blank if the whole amount is on credit' }),
      App.ui.field({ label: 'When to collect', input: dueDate, hint: 'Optional' }));
    const pay = K().segmented({
      options: [{ value: 'cash', label: 'Cash', tone: 'green' }, { value: 'upi', label: 'UPI', tone: 'blue' }, { value: 'credit', label: 'Credit', tone: 'amber' }],
      value: 'cash', label: 'Payment', onChange: (v) => creditBox.classList.toggle('hidden', v !== 'credit'),
    });

    const priceInputs = {};
    const items = order.items || [];
    const itemRows = items.map((it) => {
      const unit = it.item_kind === 'bag' ? 'per bag' : 'per kg';
      let right;
      if (wh && it.unit_price == null) {
        const inp = App.ui.input({ type: 'text', inputmode: 'decimal', placeholder: `Price ${unit} (₹)`, autocomplete: 'off', 'aria-label': `Price ${unit} for ${it.rice_type}` });
        priceInputs[it.id] = inp;
        right = h('div', { class: 'w-40' }, inp);
      } else {
        right = h('span', { class: 'text-sm text-stone-600 tabular-nums' },
          it.unit_price != null ? `${K().price(it.unit_price)} ${unit}` : 'Standard price');
      }
      return h('div', { class: 'flex flex-wrap items-center justify-between gap-2 py-2 border-b border-stone-100 last:border-0' },
        h('div', {}, h('div', { class: 'font-medium text-stone-800' }, it.rice_type), h('div', { class: 'text-sm text-stone-500' }, K().lineQty(it))),
        right);
    });

    const saveBtn = App.ui.btn('Mark as sent', { kind: 'primary', icon: 'send', type: 'submit' });
    saveBtn.classList.add('min-h-[48px]', 'px-6');
    const form = h('form', { class: 'space-y-4', novalidate: true },
      h('div', { class: 'flex flex-wrap items-center gap-2 text-sm' },
        K().channelBadge(order.channel),
        h('span', { class: 'font-semibold text-stone-800' }, order.customer_name || '—'),
        order.customer_phone ? h('span', { class: 'text-stone-500' }, order.customer_phone) : null,
        h('span', { class: 'text-stone-500' }, '· wanted ' + App.fmt.dateTime(order.requested_for))),
      h('div', { class: 'rounded-xl border border-stone-200 px-3' }, itemRows),
      Object.keys(priceInputs).length ? h('p', { class: 'text-xs text-stone-500' }, 'Wholesale items need a price before they can be sent.') : null,
      App.ui.field({ label: 'Date sent', input: sentDate }),
      h('div', { class: 'space-y-2' }, h('div', { class: 'text-sm font-medium text-stone-700' }, 'Payment'), pay.el),
      creditBox,
      App.ui.field({ label: 'Notes', input: notes }),
      err,
      h('div', { class: 'flex justify-end gap-2 pt-2' }, App.ui.btn('Not now', { kind: 'ghost', onClick: () => m.close() }), saveBtn));

    const m = App.ui.modal({ title: 'Mark as sent', body: form, size: 'md' });
    let saving = false;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (saving) return;
      err.classList.add('hidden');
      const fail = (msg) => { err.textContent = msg; err.classList.remove('hidden'); };
      if (!sentDate.value) return fail('Choose the date sent.');
      const body = { sent_date: sentDate.value, payment_mode: pay.get(), notes: notes.value.trim() || undefined };
      if (pay.get() === 'credit') {
        const c = K().parseMoney(creditAmt.value);
        if (Number.isNaN(c)) return fail('Credit amount must be a whole rupee amount.');
        if (c != null) body.credit_amount = c;
        if (dueDate.value) body.due_date = dueDate.value;
      }
      const ids = Object.keys(priceInputs);
      if (ids.length) {
        body.item_prices = {};
        for (const id of ids) {
          const p = K().parsePrice(priceInputs[id].value);
          if (p == null || Number.isNaN(p) || p <= 0) { priceInputs[id].focus(); return fail('Enter a price for every item.'); }
          body.item_prices[id] = p;
        }
      }
      saving = true;
      saveBtn.disabled = true;
      try {
        const res = await App.api.post(`/api/orders/${order.id}/fulfill`, body, { silent: true });
        m.close();
        App.ui.toast(`Added to ${order.channel === 'wholesale' ? 'Wholesale' : 'Retail'} sales on ${App.fmt.date(body.sent_date)}`);
        K().refreshAfterSale(order.channel);
        afterChange(order);
        if (onDone) onDone(res);
      } catch (ex) {
        fail(ex.message || 'Could not mark as sent.');
        saving = false;
        saveBtn.disabled = false;
      }
    });
    setTimeout(() => (Object.values(priceInputs)[0] || saveBtn).focus(), 60);
    return m;
  }

  function orderCard(order, { onChanged, compact = false, beforeAction } = {}) {
    const pending = order.status === 'pending';
    const overdue = pending && order.overdue;
    const canEdit = App.can('orders:edit');
    const when = h('div', { class: 'flex flex-wrap items-center gap-2' },
      h('span', { class: 'inline-flex items-center gap-1 font-semibold tabular-nums ' + (overdue ? 'text-rose-700' : 'text-stone-800') },
        App.icon('clock', 'w-4 h-4'), App.fmt.dateTime(order.requested_for)),
      overdue ? App.ui.badge('Overdue', 'red') : null,
      K().channelBadge(order.channel),
      !pending ? K().statusBadge(order.status) : null);

    const who = h('div', { class: 'flex flex-wrap items-center gap-x-3 gap-y-1 text-sm' },
      h('span', { class: 'font-semibold text-stone-900 text-base' }, order.customer_name || '—'),
      order.customer_phone ? h('a', { href: 'tel:' + order.customer_phone, class: 'inline-flex items-center gap-1 text-sky-700 hover:underline', on: { click: (e) => e.stopPropagation() } }, App.icon('phone', 'w-4 h-4'), order.customer_phone) : null,
      order.customer_place ? h('span', { class: 'text-stone-500' }, order.customer_place) : null);

    const items = h('div', { class: 'text-sm text-stone-700' }, K().itemsSummary(order.items) || 'No items');
    const extra = h('div', { class: 'text-xs text-stone-500 space-y-0.5' },
      order.call_received_on ? h('div', {}, 'Call received ' + App.fmt.date(order.call_received_on)) : null,
      order.notes ? h('div', { class: 'whitespace-pre-wrap text-stone-600' }, order.notes) : null,
      !pending && order.closed_at ? h('div', {}, (order.status === 'sent' ? 'Sent ' : 'Closed ') + App.fmt.dateTime(String(order.closed_at).slice(0, 16))) : null);

    const actions = h('div', { class: 'flex flex-wrap gap-2' });
    const done = () => { if (onChanged) onChanged(); };
    const pre = () => { if (beforeAction) beforeAction(); };
    if (pending && canEdit) {
      const sent = App.ui.btn('Mark as sent', { kind: 'primary', icon: 'send', small: compact, onClick: () => { pre(); openMarkSent(order, done); } });
      actions.append(sent);
      if (!compact) actions.append(App.ui.btn('Edit', { kind: 'secondary', icon: 'edit', onClick: () => { pre(); openEditor(order, done); } }));
      actions.append(App.ui.btn('Cancel', { kind: 'ghost', icon: 'x', small: compact, onClick: () => { pre(); cancelOrder(order, done); } }));
    }
    if (order.status === 'sent' && order.sale_id) {
      actions.append(App.ui.btn('View sale', { kind: 'secondary', icon: 'eye', small: true, onClick: () => { pre(); K().openSale(order.sale_id); } }));
    }

    return h('article', {
      class: 'rounded-2xl border p-4 space-y-2 shadow-sm ' + (overdue ? 'border-rose-300 bg-rose-50/60' : 'border-stone-200 bg-white'),
      dataset: { orderId: order.id },
    }, when, who, items, extra, actions.children.length ? actions : null);
  }

  App.reminders = { openMarkSent, openEditor, cancelOrder, orderCard };
})();

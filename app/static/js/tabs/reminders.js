/*
 * tabs/reminders.js — Reminders / pending deliveries tab (orders:view; actions need orders:edit).
 *
 * Status pills Pending / Sent / Cancelled / All -> GET /api/orders?status=… ; optional channel filter
 * (only channels the user can view). Cards come from App.reminders.orderCard (shared with the bell),
 * so 'Mark as sent', 'Edit', 'Cancel' behave identically in both places and refresh the bell.
 * '+ New reminder' opens App.saleForm in reminder mode with a Retail/Wholesale chooser.
 */
(function () {
  'use strict';
  const h = (...a) => App.ui.h(...a);
  const K = () => App.salekit;

  let els = null;
  let status = 'pending';
  let channel = '';
  let seq = 0;

  function init(root) {
    const host = root.querySelector('[data-tab-root]') || root;
    const pills = App.ui.tabs({
      items: [
        { id: 'pending', label: 'Pending' }, { id: 'sent', label: 'Sent' },
        { id: 'cancelled', label: 'Cancelled' }, { id: 'all', label: 'All' },
      ],
      active: status,
      onChange: (id) => { status = id; load(); },
    });
    const chOpts = [{ value: '', label: 'Retail & wholesale' }];
    if (App.can('retail:view')) chOpts.push({ value: 'retail', label: 'Retail' });
    if (App.can('wholesale:view')) chOpts.push({ value: 'wholesale', label: 'Wholesale' });
    const chSel = chOpts.length > 2 ? App.ui.select(chOpts, { 'aria-label': 'Channel' }) : null;
    if (chSel) chSel.addEventListener('change', () => { channel = chSel.value; load(); });
    const newBtn = App.can('orders:edit')
      ? App.ui.btn('New reminder', { kind: 'primary', icon: 'plus', onClick: () => App.reminders.openEditor(null, load) })
      : null;
    if (newBtn) newBtn.classList.add('min-h-[48px]', 'px-5', 'text-base');
    els = { pills, list: h('div', { class: 'space-y-3' }), sub: h('span', {}) };
    host.replaceChildren(
      K().tabHeader('Reminders', els.sub, newBtn),
      h('div', { class: 'flex flex-wrap items-center justify-between gap-3' }, pills.el, chSel ? h('div', { class: 'w-56' }, chSel) : null),
      els.list);
  }

  function show() { load(); }

  async function load() {
    if (!els) return;
    const my = ++seq;
    els.list.replaceChildren(App.ui.spinner());
    let orders;
    try {
      orders = await App.api.get('/api/orders', { status, channel: channel || null });
    } catch (e) {
      if (my === seq) els.list.replaceChildren(App.ui.empty(e.message || 'Could not load reminders', 'alert'));
      return;
    }
    if (my !== seq) return;
    const overdue = orders.filter((o) => o.status === 'pending' && o.overdue).length;
    els.sub.textContent = status === 'pending'
      ? (orders.length ? `${orders.length} to deliver${overdue ? ` · ${overdue} overdue` : ''}` : 'Nothing pending')
      : `${orders.length} order${orders.length === 1 ? '' : 's'}`;
    if (!orders.length) {
      const msg = { pending: 'No pending deliveries. All caught up!', sent: 'No sent orders yet', cancelled: 'No cancelled orders', all: 'No reminders yet' }[status];
      els.list.replaceChildren(App.ui.empty(msg, status === 'pending' ? 'check' : 'clock'));
      return;
    }
    els.list.replaceChildren(h('div', { class: 'grid grid-cols-1 lg:grid-cols-2 gap-3' },
      orders.map((o) => App.reminders.orderCard(o, { onChanged: load }))));
  }

  App.registerTab('reminders', { init, show });
})();

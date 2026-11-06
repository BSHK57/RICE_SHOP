/*
 * core/bell.js — the header bell for reminders / pending deliveries (loaded only with orders:view).
 * Defines App.refreshBell() and wires #bell-btn / #bell-badge.
 *
 *   - Badge = GET /api/orders/summary, fetched on page load and whenever App.refreshBell() is called
 *     (after sales / reminder actions). Static: there is NO polling.
 *   - Click opens App.ui.drawer with the PENDING orders (GET /api/orders?status=pending); overdue
 *     ones are highlighted. Per-order 'Mark as sent' / 'Cancel' use App.reminders (shared/reminders_dialog.js).
 *   - 'Open Reminders' switches to the Reminders tab.
 */
(function () {
  'use strict';
  const App = (window.App = window.App || {});
  let drawer = null;

  async function refreshBell() {
    const badge = document.getElementById('bell-badge');
    const btn = document.getElementById('bell-btn');
    if (!badge) return null;
    let s;
    try {
      s = await App.api.get('/api/orders/summary', null, { silent: true });
    } catch (e) {
      return null;
    }
    const n = (s && s.pending) || 0;
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.classList.toggle('hidden', n === 0);
    // red when something is overdue, amber otherwise
    badge.classList.remove('bg-rose-600', 'bg-amber-500');
    badge.classList.add(s && s.overdue ? 'bg-rose-600' : 'bg-amber-500');
    if (btn) {
      const label = n === 0 ? 'No pending deliveries'
        : `${n} pending deliver${n === 1 ? 'y' : 'ies'}${s.overdue ? `, ${s.overdue} overdue` : ''}`;
      btn.setAttribute('aria-label', label);
      btn.title = label;
    }
    if (drawer && drawer.el && document.body.contains(drawer.el)) fillDrawer();
    return s;
  }

  async function fillDrawer() {
    const h = App.ui.h;
    const body = drawer.body;
    body.replaceChildren(App.ui.spinner());
    let orders;
    try {
      orders = await App.api.get('/api/orders', { status: 'pending' }, { silent: true });
    } catch (e) {
      body.replaceChildren(App.ui.empty(e.message || 'Could not load reminders', 'alert'));
      return;
    }
    const top = h('div', { class: 'flex items-center justify-between gap-2 mb-3' },
      h('p', { class: 'text-sm text-stone-600' },
        orders.length ? `${orders.length} pending · ${orders.filter((o) => o.overdue).length} overdue` : ''),
      App.tabs && App.tabs.some && App.tabs.some((t) => t.id === 'reminders')
        ? App.ui.btn('Open Reminders', { kind: 'secondary', icon: 'clock', small: true, onClick: () => { drawer.close(); App.showTab('reminders'); } })
        : null);
    const list = h('div', { class: 'space-y-3' },
      orders.length
        ? orders.map((o) => App.reminders
          ? App.reminders.orderCard(o, { compact: true, onChanged: () => {}, beforeAction: () => drawer.close() })
          : h('div', {}, `${o.customer_name} · ${App.fmt.dateTime(o.requested_for)}`))
        : App.ui.empty('No pending deliveries. All caught up!', 'check'));
    body.replaceChildren(top, list);
  }

  function openDrawer() {
    drawer = App.ui.drawer({ title: 'Pending deliveries', body: App.ui.h('div', {}), side: 'right' });
    fillDrawer();
  }

  App.refreshBell = refreshBell;

  function wire() {
    const btn = document.getElementById('bell-btn');
    if (btn && !btn.dataset.bellWired) {
      btn.dataset.bellWired = '1';
      btn.addEventListener('click', openDrawer);
    }
    refreshBell();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
})();

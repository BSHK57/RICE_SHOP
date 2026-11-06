/*
 * core/components.js - number/date formatting (App.fmt) and reusable form widgets (App.components).
 * Load order: api.js, ui.js, components.js, app.js.
 *
 * App.fmt
 *   fmt.money(1250)            -> '₹1,250'      (Indian grouping: 125000 -> '₹1,25,000'; decimals only if present)
 *   fmt.kg(2500)               -> '2.5 kg'      fmt.kg(250) -> '250 g'      (argument is GRAMS)
 *   fmt.qty(line)              -> '3 bags × 25 kg' or '2.5 kg'   (line = {item_kind, grams, bags, bag_size_grams})
 *   fmt.date('2026-11-05')     -> '05 Nov 2026'
 *   fmt.dateTime('2026-11-05 16:30') -> '05 Nov, 4:30 PM'  (year is added only when it is not the current year)
 *   fmt.today()                -> 'YYYY-MM-DD' (shop-local date)
 *   fmt.kgToGrams('0.05')      -> 50  (string maths, no float errors; '' -> 0; invalid -> NaN; '-1.5' -> -1500)
 *   fmt.gramsToKg(2500)        -> 2.5
 *   fmt.num(1234.5)            -> '1,234.5'
 *   fmt.addDays('2026-11-05', -6) -> '2026-10-30'     fmt.monthStart() -> 'YYYY-MM-01'      (extras)
 *
 * App.components
 *   const cp = App.components.customerPicker({value: 3, required: true, allowCreate: true,
 *                                             onChange(customer|null) {}});   // user picks / clears / creates
 *   container.append(App.ui.field({label: 'Customer', input: cp.el, required: true}));
 *   cp.getId() -> int|null   cp.getCustomer() -> object|null   cp.setCustomer(c|null) (does NOT fire onChange)   cp.reload()
 *   const rp = App.components.ricePicker({mode: 'retail'|'wholesale', onChange(value) {}});
 *   rp.getValue() -> string ('' if none)   rp.setValue('Sona Masoori')   rp.getItem() (retail: RiceType|null)   rp.reload()
 *   App.components.stat({label: 'Today', value: '₹1,200', sub: '5 sales', tone: 'green', icon: 'rupee', onClick: fn})
 *   const dr = App.components.dateRange({from, to, onChange({from, to}) {}});   dr.el  dr.get()  dr.set(from, to)
 */
(function () {
  'use strict';
  var App = (window.App = window.App || {});
  var ui = App.ui;
  var h = ui.h;

  // ------------------------------------------------------------------ fmt
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function num(n) {
    if (n === null || n === undefined || n === '' || isNaN(Number(n))) return '—';
    return Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  }

  function money(n) {
    if (n === null || n === undefined || n === '' || isNaN(Number(n))) return '—';
    var v = Number(n);
    var neg = v < 0;
    v = Math.abs(v);
    var frac = Math.abs(v - Math.round(v)) > 0.004;
    var s = v.toLocaleString('en-IN', { minimumFractionDigits: frac ? 2 : 0, maximumFractionDigits: frac ? 2 : 0 });
    return (neg ? '-' : '') + '₹' + s;
  }

  function kg(grams) {
    if (grams === null || grams === undefined || grams === '' || isNaN(Number(grams))) return '—';
    var g = Math.round(Number(grams));
    if (Math.abs(g) < 1000) return g + ' g';
    return (g / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 }) + ' kg';
  }

  function qty(line) {
    if (!line) return '—';
    var isBag = line.item_kind === 'bag' || (line.bags && !line.grams);
    if (isBag && line.bags) {
      var s = line.bags + (Number(line.bags) === 1 ? ' bag' : ' bags');
      if (line.bag_size_grams) s += ' × ' + kg(line.bag_size_grams);
      return s;
    }
    if (line.grams !== null && line.grams !== undefined) return kg(line.grams);
    return line.quantity_label || '—';
  }

  function parseDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  }

  function date(s) {
    var p = parseDate(s);
    if (!p) return s || '—';
    return pad(p.d) + ' ' + MONTHS[p.m - 1] + ' ' + p.y;
  }

  function dateTime(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s || '');
    if (!m) return date(s);
    var hr = +m[4];
    var ap = hr >= 12 ? 'PM' : 'AM';
    var h12 = hr % 12 === 0 ? 12 : hr % 12;
    var yearPart = +m[1] === new Date().getFullYear() ? '' : ' ' + m[1];
    return pad(+m[3]) + ' ' + MONTHS[+m[2] - 1] + yearPart + ', ' + h12 + ':' + m[5] + ' ' + ap;
  }

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function addDays(s, n) {
    var p = parseDate(s) || parseDate(today());
    var d = new Date(p.y, p.m - 1, p.d + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function monthStart() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-01';
  }

  function kgToGrams(x) {
    if (x === null || x === undefined) return 0;
    var s = String(x).trim().replace(',', '.');
    if (s === '') return 0;
    var m = /^([+-]?)(\d*)\.?(\d*)$/.exec(s);
    if (!m || (m[2] === '' && m[3] === '')) return NaN;
    var g = parseInt(m[2] || '0', 10) * 1000 + parseInt((m[3] + '000').slice(0, 3), 10);
    if (m[3].length > 3 && m[3].charAt(3) >= '5') g += 1;   // round half up at the 4th decimal
    return m[1] === '-' ? -g : g;
  }

  function gramsToKg(g) { return Number(g) / 1000; }

  App.fmt = {
    money: money, kg: kg, qty: qty, date: date, dateTime: dateTime, today: today,
    kgToGrams: kgToGrams, gramsToKg: gramsToKg, num: num, addDays: addDays, monthStart: monthStart,
  };

  // ------------------------------------------------------------------ stat card
  var STAT_TONE = {
    default: { value: 'text-stone-900', bar: 'bg-stone-300', ico: 'bg-stone-100 text-stone-500' },
    green: { value: 'text-emerald-700', bar: 'bg-emerald-500', ico: 'bg-emerald-100 text-emerald-700' },
    red: { value: 'text-red-700', bar: 'bg-red-500', ico: 'bg-red-100 text-red-700' },
    amber: { value: 'text-amber-700', bar: 'bg-amber-500', ico: 'bg-amber-100 text-amber-700' },
    blue: { value: 'text-sky-700', bar: 'bg-sky-500', ico: 'bg-sky-100 text-sky-700' },
  };

  function stat(opts) {
    var t = STAT_TONE[opts.tone || 'default'] || STAT_TONE.default;
    var kids = [
      h('div', { class: 'flex items-start justify-between gap-2' },
        h('p', { class: 'text-xs font-medium uppercase tracking-wide text-stone-500' }, opts.label),
        opts.icon ? h('span', { class: 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ' + t.ico }, App.icon(opts.icon, 'h-4 w-4')) : null),
      h('p', { class: 'mt-1 text-2xl font-semibold tabular-nums ' + t.value }, opts.value === null || opts.value === undefined ? '—' : opts.value),
      opts.sub ? h('p', { class: 'mt-0.5 text-xs text-stone-500' }, opts.sub) : null,
    ];
    var cls = 'relative block w-full overflow-hidden rounded-xl border border-stone-200 bg-white p-4 text-left shadow-sm';
    var el;
    if (opts.onClick) {
      el = h('button', { type: 'button', class: cls + ' transition hover:border-stone-300 hover:shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500', on: { click: opts.onClick } }, kids);
    } else {
      el = h('div', { class: cls }, kids);
    }
    el.appendChild(h('span', { class: 'absolute inset-y-0 left-0 w-1 ' + t.bar, 'aria-hidden': 'true' }));
    return el;
  }

  // ------------------------------------------------------------------ dateRange
  function dateRange(opts) {
    opts = opts || {};
    var from = ui.input({ type: 'date', value: opts.from === undefined ? fmtToday() : opts.from, 'aria-label': 'From date' });
    var to = ui.input({ type: 'date', value: opts.to === undefined ? fmtToday() : opts.to, 'aria-label': 'To date' });
    function fmtToday() { return today(); }
    function get() { return { from: from.value, to: to.value }; }
    function fire() { if (opts.onChange) opts.onChange(get()); }
    function set(f, t, silent) { from.value = f || ''; to.value = t || ''; if (!silent) fire(); }
    from.addEventListener('change', function () { if (to.value && from.value > to.value) to.value = from.value; fire(); });
    to.addEventListener('change', function () { if (from.value && to.value < from.value) from.value = to.value; fire(); });
    function quick(label, fn) {
      return ui.btn(label, { kind: 'ghost', small: true, onClick: function () { var r = fn(); set(r[0], r[1]); } });
    }
    var el = h('div', { class: 'flex flex-wrap items-end gap-3' },
      h('label', { class: 'block text-xs font-medium text-stone-600' }, 'From', h('div', { class: 'mt-1' }, from)),
      h('label', { class: 'block text-xs font-medium text-stone-600' }, 'To', h('div', { class: 'mt-1' }, to)),
      h('div', { class: 'flex flex-wrap items-center gap-1 pb-0.5' },
        quick('Today', function () { return [today(), today()]; }),
        quick('7 days', function () { return [addDays(today(), -6), today()]; }),
        quick('30 days', function () { return [addDays(today(), -29), today()]; }),
        quick('This month', function () { return [monthStart(), today()]; })));
    return { el: el, get: get, set: set };
  }

  // ------------------------------------------------------------------ customerPicker
  function customerPicker(opts) {
    opts = opts || {};
    var allowCreate = opts.allowCreate !== false;
    var customers = [];
    var loadError = null;
    var loading = true;
    var selected = null;
    var pendingId = opts.value || null;
    var isOpen = false;
    var creating = false;
    var shown = [];
    var activeIdx = -1;
    var listId = ui.uid('cp-list');

    var search = ui.input({
      type: 'text', autocomplete: 'off', class: 'pl-9',
      placeholder: opts.required ? 'Search or select customer (required)' : 'Search customer by name, phone or place',
      role: 'combobox', 'aria-expanded': 'false', 'aria-controls': listId, 'aria-autocomplete': 'list', 'aria-label': 'Customer',
    });
    var searchWrap = h('div', { class: 'relative' },
      h('span', { class: 'pointer-events-none absolute inset-y-0 left-3 flex items-center text-stone-400' }, App.icon('search', 'h-4 w-4')),
      search);

    var chosenBox = h('div', { class: 'hidden items-center justify-between gap-3 rounded-lg border border-primary-200 bg-primary-50 px-3 py-2.5' });
    var dropdown = h('div', {
      class: 'fixed z-[70] hidden overflow-hidden rounded-xl border border-stone-200 bg-white shadow-xl',
    });
    var el = h('div', { class: 'relative' }, searchWrap, chosenBox, dropdown);

    function matches(c, q) {
      if (!q) return true;
      var hay = ((c.name || '') + ' ' + (c.phone || '') + ' ' + (c.place || '')).toLowerCase();
      return q.toLowerCase().split(/\s+/).every(function (t) { return hay.indexOf(t) >= 0; });
    }

    function balanceHint(c) {
      return c.credit_balance && c.credit_balance > 0 ? h('span', { class: 'shrink-0 text-xs font-medium text-amber-700' }, money(c.credit_balance) + ' due') : null;
    }

    function renderChosen() {
      chosenBox.innerHTML = '';
      if (!selected) {
        chosenBox.classList.add('hidden'); chosenBox.classList.remove('flex');
        searchWrap.classList.remove('hidden');
        return;
      }
      searchWrap.classList.add('hidden');
      chosenBox.classList.remove('hidden'); chosenBox.classList.add('flex');
      var sub = [selected.place, selected.phone].filter(Boolean).join(' · ');
      chosenBox.appendChild(h('div', { class: 'min-w-0' },
        h('p', { class: 'truncate text-sm font-medium text-stone-900' }, selected.name),
        sub ? h('p', { class: 'truncate text-xs text-stone-500' }, sub) : null));
      chosenBox.appendChild(h('div', { class: 'flex shrink-0 items-center gap-2' },
        balanceHint(selected),
        h('button', {
          type: 'button', 'aria-label': 'Change customer',
          class: 'rounded-md p-1.5 text-stone-500 hover:bg-white hover:text-stone-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
          on: { click: function () { choose(null, true); search.focus(); openDropdown(); } },
        }, App.icon('x', 'h-4 w-4'))));
    }

    function position() {
      if (!isOpen) return;
      var r = (searchWrap.offsetParent !== null ? searchWrap : chosenBox).getBoundingClientRect();
      var below = window.innerHeight - r.bottom - 12;
      var above = r.top - 12;
      var up = below < 200 && above > below;
      var maxH = Math.max(140, Math.min(360, up ? above : below));
      dropdown.style.left = r.left + 'px';
      dropdown.style.width = r.width + 'px';
      dropdown.style.maxHeight = maxH + 'px';
      if (up) { dropdown.style.top = ''; dropdown.style.bottom = (window.innerHeight - r.top + 4) + 'px'; }
      else { dropdown.style.bottom = ''; dropdown.style.top = (r.bottom + 4) + 'px'; }
    }

    function openDropdown() {
      if (isOpen) return;
      isOpen = true;
      dropdown.classList.remove('hidden');
      search.setAttribute('aria-expanded', 'true');
      renderDropdown();
      position();
    }
    function closeDropdown() {
      if (!isOpen) return;
      isOpen = false; creating = false;
      dropdown.classList.add('hidden');
      search.setAttribute('aria-expanded', 'false');
      search.removeAttribute('aria-activedescendant');
    }

    function choose(c, fire) {
      selected = c;
      renderChosen();
      closeDropdown();
      search.value = '';
      if (fire && opts.onChange) opts.onChange(c || null);
    }

    function renderDropdown() {
      if (!isOpen) return;
      dropdown.innerHTML = '';
      if (creating) { renderCreateForm(); return; }
      var q = search.value.trim();
      var list = h('div', { id: listId, role: 'listbox', class: 'max-h-64 overflow-y-auto py-1', style: 'max-height:' + Math.max(96, parseInt(dropdown.style.maxHeight || '300', 10) - 52) + 'px' });
      if (loading) {
        list.appendChild(h('p', { class: 'px-3 py-3 text-sm text-stone-500' }, 'Loading customers…'));
      } else if (loadError) {
        list.appendChild(h('p', { class: 'px-3 py-3 text-sm text-red-600' }, loadError));
      } else {
        var all = customers.filter(function (c) { return matches(c, q); });
        shown = all.slice(0, 60);
        if (activeIdx >= shown.length) activeIdx = shown.length - 1;
        if (!shown.length) {
          list.appendChild(h('p', { class: 'px-3 py-3 text-sm text-stone-500' }, q ? 'No customer matches “' + q + '”.' : 'No customers yet.'));
        }
        shown.forEach(function (c, i) {
          var sub = [c.place, c.phone].filter(Boolean).join(' · ');
          var opt = h('div', {
            role: 'option', id: listId + '-' + i, 'aria-selected': i === activeIdx ? 'true' : 'false',
            class: 'flex cursor-pointer items-center justify-between gap-3 px-3 py-2 ' + (i === activeIdx ? 'bg-primary-50' : 'hover:bg-stone-50'),
            on: {
              mousedown: function (e) { e.preventDefault(); choose(c, true); },
              mousemove: function () { if (activeIdx !== i) { activeIdx = i; markActive(); } },
            },
          }, h('div', { class: 'min-w-0' },
            h('p', { class: 'truncate text-sm font-medium text-stone-900' }, c.name),
            sub ? h('p', { class: 'truncate text-xs text-stone-500' }, sub) : null), balanceHint(c));
          list.appendChild(opt);
        });
        if (all.length > shown.length) {
          list.appendChild(h('p', { class: 'px-3 py-2 text-xs text-stone-400' }, 'Showing first ' + shown.length + ' of ' + all.length + ' — type to narrow down.'));
        }
      }
      dropdown.appendChild(list);
      if (allowCreate) {
        dropdown.appendChild(h('button', {
          type: 'button',
          class: 'flex w-full items-center gap-2 border-t border-stone-100 bg-stone-50 px-3 py-2.5 text-left text-sm font-medium text-primary-700 hover:bg-primary-50 focus:outline-none focus-visible:bg-primary-50',
          on: { mousedown: function (e) { e.preventDefault(); }, click: function () { creating = true; renderDropdown(); position(); } },
        }, App.icon('plus', 'h-4 w-4'), 'New customer' + (q ? ': ' + q : '')));
      }
    }

    function markActive() {
      var opts2 = dropdown.querySelectorAll('[role=option]');
      opts2.forEach(function (o, i) {
        var on = i === activeIdx;
        o.setAttribute('aria-selected', on ? 'true' : 'false');
        o.classList.toggle('bg-primary-50', on);
        if (on) { search.setAttribute('aria-activedescendant', o.id); o.scrollIntoView({ block: 'nearest' }); }
      });
    }

    function renderCreateForm() {
      var nameIn = ui.input({ type: 'text', value: search.value.trim(), placeholder: 'Name or nickname', maxlength: 100, 'aria-label': 'New customer name' });
      var phoneIn = ui.input({ type: 'tel', placeholder: 'Phone (optional)', maxlength: 30, 'aria-label': 'Phone' });
      var placeIn = ui.input({ type: 'text', placeholder: 'Place (optional)', maxlength: 100, 'aria-label': 'Place' });
      var msg = h('div', { class: 'hidden rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700', role: 'alert' });
      var saveBtn = ui.btn('Add & select', { kind: 'primary', small: true, icon: 'check' });
      var form = h('div', { class: 'space-y-2 p-3' },
        h('p', { class: 'text-sm font-semibold text-stone-800' }, 'New customer'),
        nameIn, h('div', { class: 'grid grid-cols-2 gap-2' }, phoneIn, placeIn), msg,
        h('div', { class: 'flex justify-end gap-2 pt-1' },
          ui.btn('Back', { kind: 'ghost', small: true, onClick: function () { creating = false; renderDropdown(); search.focus(); } }),
          saveBtn));
      function showConflict(text) {
        msg.classList.remove('hidden');
        msg.innerHTML = '';
        msg.appendChild(h('p', null, text));
        var existing = customers.filter(function (c) { return c.name.toLowerCase() === nameIn.value.trim().toLowerCase(); })[0];
        if (existing) {
          msg.appendChild(h('button', {
            type: 'button', class: 'mt-1 font-semibold underline',
            on: { click: function () { choose(existing, true); } },
          }, 'Use existing “' + existing.name + '”'));
        }
      }
      function submit() {
        var name = nameIn.value.trim();
        if (!name) { msg.classList.remove('hidden'); msg.textContent = 'Please enter a name.'; nameIn.focus(); return; }
        msg.classList.add('hidden');
        saveBtn.setBusy(true);
        App.api.post('/api/customers', { name: name, phone: phoneIn.value.trim() || null, place: placeIn.value.trim() || null }, { silent: true })
          .then(function (c) {
            customers.push(c);
            customers.sort(function (a, b) { return a.name.localeCompare(b.name); });
            ui.toast('Customer “' + c.name + '” added');
            choose(c, true);
          })
          .catch(function (e) {
            saveBtn.setBusy(false);
            if (e.status === 409 || e.code === 'duplicate') showConflict(e.message);
            else { msg.classList.remove('hidden'); msg.textContent = e.message; }
          });
      }
      saveBtn.addEventListener('click', submit);
      form.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); creating = false; renderDropdown(); search.focus(); }
      });
      dropdown.appendChild(form);
      setTimeout(function () { nameIn.focus(); }, 20);
    }

    search.addEventListener('focus', openDropdown);
    search.addEventListener('click', openDropdown);
    search.addEventListener('input', function () { activeIdx = 0; openDropdown(); renderDropdown(); position(); });
    search.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') {
        e.preventDefault(); openDropdown();
        activeIdx = Math.min(shown.length - 1, activeIdx + 1); markActive();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); activeIdx = Math.max(0, activeIdx - 1); markActive();
      } else if (e.key === 'Enter') {
        if (isOpen && shown[activeIdx]) { e.preventDefault(); choose(shown[activeIdx], true); }
        else if (isOpen) e.preventDefault();
      } else if (e.key === 'Escape') {
        if (isOpen) { e.preventDefault(); e.stopPropagation(); closeDropdown(); }
      } else if (e.key === 'Tab') {
        closeDropdown();
      }
    });

    function onDocDown(e) {
      if (!el.isConnected) { document.removeEventListener('mousedown', onDocDown); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); return; }
      if (isOpen && !el.contains(e.target)) closeDropdown();
    }
    document.addEventListener('mousedown', onDocDown);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);

    function applyPending() {
      if (pendingId && !selected) {
        var c = customers.filter(function (x) { return x.id === pendingId; })[0];
        if (c) { selected = c; renderChosen(); }
      }
    }

    function reload() {
      loading = true; loadError = null;
      renderDropdown();
      return App.api.get('/api/customers', null, { silent: true }).then(function (list) {
        customers = list || [];
        loading = false;
        if (selected) {
          var fresh = customers.filter(function (x) { return x.id === selected.id; })[0];
          if (fresh) { selected = fresh; renderChosen(); }
        }
        applyPending();
        renderDropdown();
      }).catch(function (e) {
        loading = false; loadError = e.message || 'Could not load customers.';
        renderDropdown();
      });
    }

    renderChosen();
    reload();

    return {
      el: el,
      getId: function () { return selected ? selected.id : null; },
      getCustomer: function () { return selected; },
      setCustomer: function (c) {
        pendingId = null;
        if (c && typeof c !== 'object') c = customers.filter(function (x) { return x.id === c; })[0] || null;
        selected = c || null;
        renderChosen();
      },
      reload: reload,
    };
  }

  // ------------------------------------------------------------------ ricePicker
  function ricePicker(opts) {
    opts = opts || {};
    var mode = opts.mode === 'wholesale' ? 'wholesale' : 'retail';
    var wanted = opts.value || '';

    if (mode === 'retail') {
      var items = [];
      var sel = ui.select([{ value: '', label: 'Select rice type…' }], { 'aria-label': 'Rice type', class: opts.class, id: opts.id });
      var rebuild = function () {
        var cur = wanted || sel.value;
        sel.innerHTML = '';
        sel.appendChild(h('option', { value: '' }, 'Select rice type…'));
        items.forEach(function (r) { sel.appendChild(h('option', { value: r.type_name }, r.type_name)); });
        if (cur && !items.some(function (r) { return r.type_name === cur; })) sel.appendChild(h('option', { value: cur }, cur));
        sel.value = cur || '';
      };
      var reloadRetail = function () {
        return App.api.get('/api/inventory/rice-types', null, { silent: true }).then(function (list) {
          items = (list || []).filter(function (r) { return r.is_active !== false && r.is_active !== 0; });
          rebuild();
        }).catch(function () { /* leave placeholder */ });
      };
      sel.addEventListener('change', function () { wanted = sel.value; if (opts.onChange) opts.onChange(sel.value); });
      reloadRetail();
      return {
        el: sel,
        getValue: function () { return sel.value || ''; },
        setValue: function (v) { wanted = v || ''; rebuild(); },
        getItem: function () { return items.filter(function (r) { return r.type_name === sel.value; })[0] || null; },
        reload: reloadRetail,
      };
    }

    var listId = ui.uid('rice-names');
    var dl = h('datalist', { id: listId });
    var inp = ui.input({ type: 'text', list: listId, autocomplete: 'off', maxlength: 100, placeholder: 'Rice type (pick or type a new name)', 'aria-label': 'Rice type', class: opts.class, id: opts.id, value: wanted });
    var reloadWhole = function () {
      return App.api.get('/api/sales/wholesale/rice-names', null, { silent: true }).then(function (names) {
        dl.innerHTML = '';
        (names || []).forEach(function (n) { dl.appendChild(h('option', { value: n })); });
      }).catch(function () { /* free typing still works */ });
    };
    inp.addEventListener('input', function () { if (opts.onChange) opts.onChange(inp.value.trim()); });
    reloadWhole();
    return {
      el: h('div', null, inp, dl),
      getValue: function () { return inp.value.trim(); },
      setValue: function (v) { inp.value = v || ''; },
      getItem: function () { return null; },
      reload: reloadWhole,
    };
  }

  App.components = {
    customerPicker: customerPicker,
    ricePicker: ricePicker,
    stat: stat,
    dateRange: dateRange,
  };
})();

/*
 * core/ui.js - DOM helpers and UI building blocks (DESIGN section 6.2: App.ui, App.icon).
 *
 * Everything builds DOM nodes (never innerHTML with data), so dynamic text is always escaped.
 * Styling = Tailwind classes (CDN) + a few helpers in static/css/app.css.
 *
 * Usage examples
 *   const {h, btn, field, input, select, textarea, table, badge} = App.ui;
 *
 *   h('div', {class: 'p-4', on: {click: fn}, dataset: {id: 3}}, 'Hello ', h('b', null, name), [a, b], null)
 *       attrs: class | style (string|object) | on:{event:fn} | onclick:fn | dataset:{} | value | checked |
 *              disabled | aria-* | any attribute. false/null/undefined attrs are skipped, true -> "".
 *
 *   App.ui.toast('Saved', 'success')            // 'success' | 'error' | 'info'
 *   if (await App.ui.confirm({title: 'Delete?', message: 'This cannot be undone.', confirmText: 'Delete', danger: true})) {...}
 *
 *   const m = App.ui.modal({title: 'New thing', size: 'md', body: formNode, footer: footerNode, onClose() {}});
 *       // size 'sm'|'md'|'lg'|'xl'.  m.body (scroll area), m.footer, m.el, m.close(), m.setTitle('x')
 *       // opts.backdropClose=true lets a click outside close it (default false so forms are not lost)
 *   const d = App.ui.drawer({title: 'Details', body: node});   // side panel; d.close()
 *
 *   App.ui.spinner()        App.ui.empty('No sales yet', 'ledger')        App.ui.badge('Overdue', 'red')
 *   App.ui.field({label: 'Phone', input: input({type: 'tel'}), hint: 'Optional', error: '', required: true})
 *       -> node; node.setError('msg') shows/clears the error line.
 *   const b = btn('Save', {kind: 'primary', icon: 'check', onClick: save, type: 'button', small: false});
 *       b.setBusy(true) disables it and shows a spinner (pass `disabled:true`, `title`, `class` too).
 *   input({type: 'number', min: 0, value: 5, placeholder: ''})   select([{value: 'a', label: 'A'}], {value: 'a'})
 *   textarea({rows: 3})
 *   table({columns: [{key: 'name', label: 'Name', align: 'right', class: 'w-24', render: row => row.name}],
 *          rows, empty: 'Nothing here', onRowClick: row => {}, footer: {name: 'Total', amount: '₹10'}})
 *       footer = Node | string (one full-width cell) | {columnKey: Node|string} (one cell per column)
 *   const t = App.ui.tabs({items: [{id: 'today', label: 'Today', badge: 3}], active: 'today', onChange: id => {}});
 *       t.el, t.setActive(id), t.setBadge(id, n)
 *   App.icon('home', 'h-5 w-5')   // names: home shopping truck clock ledger users box eye chart shield bell plus
 *                                 // minus trash edit check x search phone rupee calendar logout refresh send alert
 *                                 // download + extras: eyeoff chevron menu info user key lock history wheat list
 *   App.hydrateIcons(rootEl)      // replaces <span data-icon="home" class="h-5 w-5"> placeholders by SVGs
 */
(function () {
  'use strict';
  var App = (window.App = window.App || {});

  // ------------------------------------------------------------------ icons
  var ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
    shopping: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.7 12.4a1 1 0 0 0 1 .8h9.2a1 1 0 0 0 1-.8L21 7H6"/>',
    truck: '<path d="M1.5 5.5h12.5v11H1.5z"/><path d="M14 9h4l3.5 3.5v4H14"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    ledger: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M4 21.5V4.5"/><path d="M9 7h7M9 11h7"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18 14.3c2.2.7 3.5 2.6 3.5 5.7"/>',
    box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    chart: '<path d="M3 3v18h18"/><path d="M8 17v-5M13 17V8M18 17v-9"/>',
    shield: '<path d="M12 3 4 6v6c0 4.5 3.2 8 8 9 4.8-1 8-4.5 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10.3 21a2 2 0 0 0 3.4 0"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m6 6 1 14h10l1-14"/><path d="M10 10v6M14 10v6"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
    check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
    rupee: '<path d="M6 4h12M6 9h12"/><path d="M9 4c5 0 6 2 6 5s-2 5-6 5h-.5l6.5 6"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14-4L4 9"/><path d="M4 4v5h5"/><path d="M4 13a8 8 0 0 0 14 4l2-2"/><path d="M20 20v-5h-5"/>',
    send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
    alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17.5v.01"/>',
    download: '<path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/>',
    eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 6.1A10 10 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.2 3.9M6.5 7.5C3.8 9.3 2 12 2 12s3.6 7 10 7c1.6 0 3-.4 4.3-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 8v4l3 2"/>',
    wheat: '<path d="M12 22V9"/><path d="M12 9c-2.5 0-4-1.7-4-4 2.500 0 4 1.700 4 4z"/><path d="M12 9c2.500 0 4-1.700 4-4-2.500 0-4 1.700-4 4z"/><path d="M12 15c-2.500 0-4-1.700-4-4 2.500 0 4 1.700 4 4z"/><path d="M12 15c2.500 0 4-1.700 4-4-2.500 0-4 1.700-4 4z"/><path d="M12 9V3"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  };

  function icon(name, cls) {
    var inner = ICONS[name] || '<circle cx="12" cy="12" r="9"/>';
    var tpl = document.createElement('template');
    tpl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + inner + '</svg>';
    var svg = tpl.content.firstChild;
    svg.setAttribute('class', cls || 'h-5 w-5');
    return svg;
  }
  App.icon = icon;
  App.ICON_NAMES = Object.keys(ICONS);

  App.hydrateIcons = function (root) {
    (root || document).querySelectorAll('[data-icon]').forEach(function (el) {
      if (el.firstChild) return;
      el.appendChild(icon(el.getAttribute('data-icon'), el.getAttribute('data-icon-class') || 'h-5 w-5'));
    });
  };

  // ------------------------------------------------------------------ h()
  var BOOL_PROPS = { disabled: 1, checked: 1, selected: 1, readOnly: 1, readonly: 1, required: 1, multiple: 1, autofocus: 1, hidden: 1, indeterminate: 1 };

  function appendChild(el, c) {
    if (c === null || c === undefined || c === false || c === true) return;
    if (Array.isArray(c)) { c.forEach(function (x) { appendChild(el, x); }); return; }
    if (c.nodeType) { el.appendChild(c); return; }
    el.appendChild(document.createTextNode(String(c)));
  }

  function h(tag, attrs) {
    var children = Array.prototype.slice.call(arguments, 2);
    if (attrs !== null && attrs !== undefined &&
        (typeof attrs !== 'object' || attrs.nodeType || Array.isArray(attrs))) {
      children.unshift(attrs);
      attrs = null;
    }
    var el = document.createElement(tag);
    var deferredValue;
    var hasValue = false;
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined) return;
        if (k === 'class' || k === 'className') { if (v) el.className = v; return; }
        if (k === 'on') { Object.keys(v).forEach(function (ev) { if (v[ev]) el.addEventListener(ev, v[ev]); }); return; }
        if (k === 'dataset') { Object.keys(v).forEach(function (dk) { if (v[dk] !== null && v[dk] !== undefined) el.dataset[dk] = v[dk]; }); return; }
        if (k === 'style') { if (typeof v === 'string') el.style.cssText = v; else Object.assign(el.style, v); return; }
        if (k === 'value') { hasValue = true; deferredValue = v; return; }  // after children (selects)
        if (k === 'for') { el.htmlFor = v; return; }
        if (/^on[a-z]+$/.test(k) && typeof v === 'function') { el.addEventListener(k.slice(2), v); return; }
        if (BOOL_PROPS[k]) { if (v) el[k] = true; return; }
        if (v === false) return;
        el.setAttribute(k, v === true ? '' : String(v));
      });
    }
    children.forEach(function (c) { appendChild(el, c); });
    if (hasValue) el.value = deferredValue;
    return el;
  }

  var uidN = 0;
  function uid(prefix) { uidN += 1; return (prefix || 'id') + '-' + uidN; }

  // ------------------------------------------------------------------ controls
  var INPUT_CLS = 'block w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-base sm:text-sm text-stone-900 shadow-sm ' +
    'placeholder:text-stone-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200 ' +
    'disabled:cursor-not-allowed disabled:bg-stone-100 disabled:text-stone-500';

  function withClass(attrs, base) {
    var a = Object.assign({}, attrs || {});
    a.class = base + (a.class ? ' ' + a.class : '');
    return a;
  }

  function input(attrs) {
    var a = withClass(attrs, INPUT_CLS);
    if (!a.type) a.type = 'text';
    if (a.type === 'number' && !a.inputmode && !a.inputMode) a.inputmode = 'decimal';
    return h('input', a);
  }

  function select(options, attrs) {
    var a = withClass(attrs, INPUT_CLS + ' pr-8');
    var kids = (options || []).map(function (o) {
      if (typeof o === 'string') o = { value: o, label: o };
      return h('option', { value: o.value === null || o.value === undefined ? '' : o.value, disabled: !!o.disabled }, o.label);
    });
    return h('select', a, kids);
  }

  function textarea(attrs) {
    var a = withClass(attrs, INPUT_CLS);
    if (!a.rows) a.rows = 3;
    return h('textarea', a);
  }

  var BTN_KIND = {
    primary: 'bg-primary-600 text-white shadow-sm hover:bg-primary-700 active:bg-primary-800 focus-visible:ring-primary-500',
    secondary: 'bg-white text-stone-700 border border-stone-300 shadow-sm hover:bg-stone-50 active:bg-stone-100 focus-visible:ring-stone-400',
    danger: 'bg-red-600 text-white shadow-sm hover:bg-red-700 active:bg-red-800 focus-visible:ring-red-500',
    ghost: 'text-stone-600 hover:bg-stone-100 active:bg-stone-200 focus-visible:ring-stone-400',
  };

  function btn(label, opts) {
    opts = opts || {};
    var kind = opts.kind || 'secondary';
    var cls = 'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition select-none whitespace-nowrap ' +
      'focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ' +
      (opts.small ? 'px-3 py-1.5 text-xs min-h-[2rem] ' : 'px-4 py-2.5 text-sm min-h-[2.75rem] ') +
      (BTN_KIND[kind] || BTN_KIND.secondary) + (opts.class ? ' ' + opts.class : '');
    var iconNode = opts.icon ? icon(opts.icon, opts.small ? 'h-3.5 w-3.5' : 'h-4 w-4') : null;
    var labelNode = (label !== null && label !== undefined && label !== '') ? h('span', null, label) : null;
    var b = h('button', {
      type: opts.type || 'button', class: cls, disabled: !!opts.disabled, title: opts.title,
      'aria-label': opts['aria-label'] || (labelNode ? null : opts.title),
    }, iconNode, labelNode);
    if (opts.onClick) b.addEventListener('click', opts.onClick);
    var spin = null;
    b.setBusy = function (busy) {
      b.disabled = !!busy;
      if (busy && !spin) {
        spin = h('span', { class: 'inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent', 'aria-hidden': 'true' });
        b.insertBefore(spin, b.firstChild);
        if (iconNode) iconNode.style.display = 'none';
      } else if (!busy && spin) {
        spin.remove(); spin = null;
        if (iconNode) iconNode.style.display = '';
      }
      return b;
    };
    return b;
  }

  function field(opts) {
    var ctl = opts.input;
    var control = ctl && ctl.matches && ctl.matches('input,select,textarea') ? ctl
      : (ctl && ctl.querySelector ? ctl.querySelector('input,select,textarea') : null);
    var labelId = uid('lbl');
    var label = h('label', { class: 'block text-sm font-medium text-stone-700', id: labelId },
      opts.label, opts.required ? h('span', { class: 'text-red-600 ml-0.5', 'aria-hidden': 'true' }, '*') : null);
    var describedBy = [];
    if (control) {
      if (!control.id) control.id = uid('f');
      label.htmlFor = control.id;
      if (opts.required) control.setAttribute('aria-required', 'true');
    } else if (ctl && ctl.setAttribute) {
      ctl.setAttribute('role', ctl.getAttribute('role') || 'group');
      ctl.setAttribute('aria-labelledby', labelId);
    }
    var hint = opts.hint ? h('p', { class: 'text-xs text-stone-500', id: uid('hint') }, opts.hint) : null;
    if (hint) describedBy.push(hint.id);
    var err = h('p', { class: 'text-xs text-red-600' + (opts.error ? '' : ' hidden'), id: uid('err'), role: 'alert' }, opts.error || '');
    describedBy.push(err.id);
    if (control) control.setAttribute('aria-describedby', describedBy.join(' '));
    var wrap = h('div', { class: 'space-y-1' + (opts.class ? ' ' + opts.class : '') }, label, ctl, hint, err);
    wrap.setError = function (msg) {
      err.textContent = msg || '';
      err.classList.toggle('hidden', !msg);
      if (control) control.setAttribute('aria-invalid', msg ? 'true' : 'false');
    };
    if (opts.error && control) control.setAttribute('aria-invalid', 'true');
    return wrap;
  }

  // ------------------------------------------------------------------ small display pieces
  function spinner(cls) {
    var svg = h('span', { class: 'inline-block h-7 w-7 animate-spin rounded-full border-[3px] border-primary-600 border-t-transparent', 'aria-hidden': 'true' });
    return h('div', { class: cls || 'flex flex-col items-center justify-center gap-2 py-12 text-stone-500', role: 'status' },
      svg, h('span', { class: 'text-sm' }, 'Loading…'));
  }

  function empty(message, iconName) {
    return h('div', { class: 'flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-stone-300 bg-white/60 px-4 py-12 text-center' },
      h('div', { class: 'flex h-12 w-12 items-center justify-center rounded-full bg-stone-100 text-stone-400' }, icon(iconName || 'box', 'h-6 w-6')),
      h('p', { class: 'max-w-xs text-sm text-stone-500' }, message || 'Nothing to show yet.'));
  }

  var TONE = {
    gray: 'bg-stone-100 text-stone-700',
    green: 'bg-emerald-100 text-emerald-800',
    red: 'bg-red-100 text-red-700',
    amber: 'bg-amber-100 text-amber-800',
    blue: 'bg-sky-100 text-sky-800',
  };
  function badge(text, tone) {
    return h('span', { class: 'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ' + (TONE[tone] || TONE.gray) }, text);
  }

  // ------------------------------------------------------------------ table
  function table(opts) {
    var cols = opts.columns || [];
    var rows = opts.rows || [];
    if (!rows.length) return empty(opts.empty || 'Nothing to show.', opts.emptyIcon);
    function alignCls(c) { return c.align === 'right' ? ' text-right tabular-nums' : (c.align === 'center' ? ' text-center' : ' text-left'); }
    var thead = h('thead', { class: 'bg-stone-50 text-xs uppercase tracking-wide text-stone-500' },
      h('tr', null, cols.map(function (c) {
        return h('th', { scope: 'col', class: 'whitespace-nowrap px-4 py-2.5 font-medium' + alignCls(c) + (c.class ? ' ' + c.class : '') }, c.label);
      })));
    var tbody = h('tbody', { class: 'divide-y divide-stone-100' }, rows.map(function (row) {
      var tr = h('tr', { class: 'transition-colors' + (opts.onRowClick ? ' cursor-pointer hover:bg-stone-50 focus:bg-stone-50 focus:outline-none' : '') + (opts.rowClass ? ' ' + (opts.rowClass(row) || '') : '') },
        cols.map(function (c) {
          var v = c.render ? c.render(row) : row[c.key];
          if (v === null || v === undefined) v = '';
          return h('td', { class: 'px-4 py-3 text-sm text-stone-800 align-middle' + alignCls(c) + (c.class ? ' ' + c.class : '') }, v);
        }));
      if (opts.onRowClick) {
        tr.tabIndex = 0;
        tr.addEventListener('click', function (e) { if (!e.target.closest('button,a,input,select,textarea,label')) opts.onRowClick(row, e); });
        tr.addEventListener('keydown', function (e) {
          if ((e.key === 'Enter' || e.key === ' ') && e.target === tr) { e.preventDefault(); opts.onRowClick(row, e); }
        });
      }
      return tr;
    }));
    var tfoot = null;
    var f = opts.footer;
    if (f !== null && f !== undefined && f !== false) {
      var cells;
      if (f && f.nodeType || typeof f === 'string') {
        cells = [h('td', { colspan: cols.length, class: 'px-4 py-3 text-sm font-semibold' }, f)];
      } else {
        cells = cols.map(function (c) {
          return h('td', { class: 'px-4 py-3 text-sm font-semibold text-stone-900' + alignCls(c) }, f[c.key] === undefined ? '' : f[c.key]);
        });
      }
      tfoot = h('tfoot', { class: 'border-t-2 border-stone-200 bg-stone-50' }, h('tr', null, cells));
    }
    return h('div', { class: 'overflow-x-auto rounded-xl border border-stone-200 bg-white shadow-sm' },
      h('table', { class: 'min-w-full' }, thead, tbody, tfoot));
  }

  // ------------------------------------------------------------------ inner pill tabs
  function tabs(opts) {
    var active = opts.active || (opts.items[0] && opts.items[0].id);
    var buttons = {};
    var badges = {};
    var el = h('div', { class: 'flex gap-1 overflow-x-auto rounded-xl bg-stone-100 p-1', role: 'tablist' });
    function paint() {
      Object.keys(buttons).forEach(function (id) {
        var on = id === active;
        buttons[id].setAttribute('aria-selected', on ? 'true' : 'false');
        buttons[id].tabIndex = on ? 0 : -1;
        buttons[id].className = 'inline-flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition ' +
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ' +
          (on ? 'bg-white text-primary-700 shadow-sm' : 'text-stone-600 hover:text-stone-900');
      });
    }
    opts.items.forEach(function (it) {
      var b = h('button', { type: 'button', role: 'tab' }, it.label);
      if (it.badge !== undefined && it.badge !== null) {
        badges[it.id] = h('span', { class: 'rounded-full bg-stone-200 px-1.5 text-xs text-stone-700' }, String(it.badge));
        b.appendChild(badges[it.id]);
      }
      b.addEventListener('click', function () { setActive(it.id, true); });
      b.addEventListener('keydown', function (e) {
        var ids = opts.items.map(function (x) { return x.id; });
        var i = ids.indexOf(active);
        if (e.key === 'ArrowRight') { setActive(ids[(i + 1) % ids.length], true); buttons[active].focus(); }
        else if (e.key === 'ArrowLeft') { setActive(ids[(i - 1 + ids.length) % ids.length], true); buttons[active].focus(); }
      });
      buttons[it.id] = b;
      el.appendChild(b);
    });
    function setActive(id, fire) {
      if (!buttons[id]) return;
      var changed = id !== active;
      active = id;
      paint();
      if (fire && changed && opts.onChange) opts.onChange(id);
    }
    function setBadge(id, n) {
      if (!buttons[id]) return;
      if (!badges[id]) {
        badges[id] = h('span', { class: 'rounded-full bg-stone-200 px-1.5 text-xs text-stone-700' });
        buttons[id].appendChild(badges[id]);
      }
      badges[id].textContent = String(n);
      badges[id].classList.toggle('hidden', n === null || n === undefined);
    }
    paint();
    return { el: el, setActive: function (id) { setActive(id, false); }, setBadge: setBadge };
  }

  // ------------------------------------------------------------------ toasts
  function toastRoot() {
    var r = document.getElementById('toast-root');
    if (!r) { r = h('div', { id: 'toast-root' }); document.body.appendChild(r); }
    return r;
  }
  var TOAST_TONE = {
    success: { cls: 'border-emerald-200 bg-emerald-50 text-emerald-900', icon: 'check', ic: 'text-emerald-600' },
    error: { cls: 'border-red-200 bg-red-50 text-red-900', icon: 'alert', ic: 'text-red-600' },
    info: { cls: 'border-stone-200 bg-white text-stone-800', icon: 'info', ic: 'text-sky-600' },
  };
  function toast(message, type) {
    var t = TOAST_TONE[type || 'success'] || TOAST_TONE.success;
    var root = toastRoot();
    var el = h('div', {
      role: type === 'error' ? 'alert' : 'status',
      class: 'toast pointer-events-auto flex max-w-md items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg ' + t.cls,
    }, h('span', { class: 'mt-0.5 shrink-0 ' + t.ic }, icon(t.icon, 'h-4 w-4')), h('span', { class: 'min-w-0 break-words' }, String(message)));
    var gone = false;
    function dismiss() {
      if (gone) return; gone = true;
      el.classList.add('toast-out');
      setTimeout(function () { el.remove(); }, 180);
    }
    el.addEventListener('click', dismiss);
    root.appendChild(el);
    while (root.children.length > 4) root.firstChild.remove();
    setTimeout(dismiss, type === 'error' ? 6500 : 3500);
    return { dismiss: dismiss };
  }

  // ------------------------------------------------------------------ layers (modal / drawer / confirm)
  var layers = [];
  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  function lockScroll() {
    layers = layers.filter(function (l) { return l.el.isConnected; });
    document.body.classList.toggle('modal-open', layers.length > 0);
  }

  document.addEventListener('keydown', function (e) {
    layers = layers.filter(function (l) { return l.el.isConnected; });   // drop layers removed from the DOM by other code
    var top = layers[layers.length - 1];
    if (!top) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      top.close();
    } else if (e.key === 'Tab') {
      var items = Array.prototype.filter.call(top.panel.querySelectorAll(FOCUSABLE), function (n) { return n.offsetParent !== null; });
      if (!items.length) { e.preventDefault(); top.panel.focus(); return; }
      var first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === top.panel)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!top.panel.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    }
  });

  function layerRoot(id) {
    var r = document.getElementById(id);
    if (!r) { r = h('div', { id: id }); document.body.appendChild(r); }
    return r;
  }

  var SIZE = { sm: 'sm:max-w-sm', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl', xl: 'sm:max-w-4xl' };

  function closeButton(onClick) {
    return h('button', {
      type: 'button', 'aria-label': 'Close',
      class: 'rounded-lg p-2 text-stone-400 transition hover:bg-stone-100 hover:text-stone-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
      on: { click: onClick },
    }, icon('x', 'h-5 w-5'));
  }

  function openLayer(kind, opts) {
    var prevFocus = document.activeElement;
    var closed = false;
    var titleId = uid('dlg');
    var titleEl = h('h2', { id: titleId, class: 'min-w-0 truncate text-lg font-semibold text-stone-900' }, opts.title || '');
    var bodyEl = h('div', { class: 'min-h-0 flex-1 overflow-y-auto px-5 py-4' });
    appendChild(bodyEl, opts.body);
    var footerEl = h('div', { class: 'flex flex-wrap items-center justify-end gap-2 border-t border-stone-100 bg-stone-50/60 px-5 py-3' + (opts.footer ? '' : ' hidden') });
    appendChild(footerEl, opts.footer);

    var layer = { close: close };
    var header = h('div', { class: 'flex items-center justify-between gap-3 border-b border-stone-100 px-5 py-3' }, titleEl, closeButton(function () { close(); }));
    var panel, wrapper, backdrop;
    if (kind === 'drawer') {
      panel = h('div', {
        role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1',
        class: 'anim-drawer-' + (opts.side === 'left' ? 'left' : 'right') + ' relative flex h-full w-full max-w-md flex-col bg-white shadow-2xl focus:outline-none',
      }, header, bodyEl, footerEl);
      backdrop = h('div', { class: 'anim-fade absolute inset-0 bg-stone-900/40', on: { click: function () { close(); } } });
      wrapper = h('div', { class: 'fixed inset-0 z-50 flex ' + (opts.side === 'left' ? 'justify-start' : 'justify-end') }, backdrop, panel);
    } else {
      panel = h('div', {
        role: opts.role || 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1',
        class: 'anim-modal relative flex max-h-[92vh] w-full flex-col rounded-t-2xl bg-white shadow-2xl focus:outline-none sm:rounded-2xl ' + (SIZE[opts.size] || SIZE.md),
      }, header, bodyEl, footerEl);
      backdrop = h('div', { class: 'anim-fade absolute inset-0 bg-stone-900/50' });
      if (opts.backdropClose) backdrop.addEventListener('click', function () { close(); });
      wrapper = h('div', { class: 'fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4' }, backdrop, panel);
    }
    layer.panel = panel;
    layer.el = wrapper;
    layerRoot(kind === 'drawer' ? 'drawer-root' : 'modal-root').appendChild(wrapper);
    layers.push(layer);
    lockScroll();

    var auto = bodyEl.querySelector('[autofocus]') ||
      Array.prototype.find.call(bodyEl.querySelectorAll('input:not([type=hidden]),select,textarea'), function (n) { return !n.disabled; });
    setTimeout(function () { (auto || panel).focus(); }, 30);

    function close(result) {
      if (closed) return;
      closed = true;
      var i = layers.indexOf(layer);
      if (i >= 0) layers.splice(i, 1);
      wrapper.remove();
      lockScroll();
      if (prevFocus && prevFocus.isConnected && prevFocus.focus) { try { prevFocus.focus(); } catch (e) { /* ignore */ } }
      if (opts.onClose) opts.onClose(result);
    }
    return { el: wrapper, panel: panel, body: bodyEl, footer: footerEl, close: close, setTitle: function (t) { titleEl.textContent = t; } };
  }

  function modal(opts) { return openLayer('modal', opts || {}); }
  function drawer(opts) { opts = opts || {}; opts.side = opts.side || 'right'; return openLayer('drawer', opts); }

  function confirm(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var done = false;
      function finish(v) { if (done) return; done = true; resolve(v); m.close(); }
      var cancel = btn(opts.cancelText || 'Cancel', { kind: 'secondary', onClick: function () { finish(false); } });
      var ok = btn(opts.confirmText || 'Confirm', { kind: opts.danger ? 'danger' : 'primary', onClick: function () { finish(true); } });
      ok.setAttribute('autofocus', '');
      var body = h('div', { class: 'flex gap-3' },
        h('div', { class: 'mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full ' + (opts.danger ? 'bg-red-100 text-red-600' : 'bg-primary-100 text-primary-700') },
          icon(opts.danger ? 'alert' : 'info', 'h-5 w-5')),
        h('p', { class: 'pt-1.5 text-sm text-stone-600' }, opts.message || ''));
      var m = openLayer('modal', {
        title: opts.title || 'Are you sure?', size: 'sm', role: 'alertdialog', backdropClose: true, body: body, footer: [cancel, ok],
        onClose: function () { if (!done) { done = true; resolve(false); } },
      });
      setTimeout(function () { (opts.danger ? cancel : ok).focus(); }, 40);
    });
  }

  App.ui = {
    h: h, uid: uid, toast: toast, confirm: confirm, modal: modal, drawer: drawer,
    spinner: spinner, empty: empty, badge: badge, field: field, btn: btn,
    input: input, select: select, textarea: textarea, table: table, tabs: tabs,
    INPUT_CLS: INPUT_CLS,
  };
})();

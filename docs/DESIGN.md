# Rice Shop Manager — Design & Contract

A small Flask + SQLite + Tailwind web app for one rice shop (retail **and** wholesale, with credit
customers). 2–3 users. This file is the **contract** every module is built against.

> Shared building blocks that already exist and must be used (do not re-implement):
> `app/db.py` (connection, schema, `query_all/query_one/query_value/execute/transaction/audit`),
> `app/utils/calc.py` (all arithmetic), `app/utils/common.py` (`ok/fail/ApiError`, validators),
> `app/auth/permissions.py` (`require`, `require_any`, `can`, `current_user`, `User`).

---------------------------------------------------------------------------------------------------

## 1. Use cases (re-formatted)

### 1.1 Actors and access
| User | Login | Role | Can do |
|---|---|---|---|
| Admin | `admin` / `admin@123` | `admin` | Everything + create users and choose which tabs/actions they get |
| Anand (father, "super user") | `anand` / `anand1970` | `super` | Inventory, retail + wholesale sales, original (exact) sales, credits, customers, reminders, reports |
| Staff ("normal user") | `staff` / `staff@123` *(placeholder — password was not specified)* | `staff` | **View** retail sales (standard prices only, never discounts), **view** credits customer-wise/date-wise, **update** credits (record payments) |

Built-in users are hard-coded in `app/auth/identity.py`. Users the admin creates are stored in table `app_users`.
Access is permission-key based (see `app/auth/permissions.py`); the UI shows only the tabs the user may open.

### 1.2 The business
* Sells rice **retail** (loose or bagged) and **wholesale** (almost always bags), for **cash / UPI / credit**.
* Several rice varieties. Prices change rarely. Cost price per kg differs by variety.
* Bag sizes are 18 / 20 / 25 / 26 kg … decided when stock arrives (stored per rice type).
* "Loose" = from 50–100 g up to ~24 kg. A loose request that reaches a full bag is a **bag** sale.
* Credit customers are remembered by name/nickname. Wholesale price differs by customer.
* Customers sometimes ask for delivery at a particular time → **reminder** → later "mark as sent".

### 1.3 Use cases by area
**UC-INV Inventory (retail only; edit = super user/admin)**
1. List rice types with: type name (primary key), price per kg, bag price (blank = not sold in bags), bag size, bags qty, loose qty.
2. Add a rice type; edit prices; **receive stock** (new bags, with bag size); adjust (stock-take correction); open a bag manually; view stock movement history.
3. Selling loose rice that exceeds open loose stock **opens bags automatically** (bag count ↓, loose ↑, then loose ↓ by the sale).
4. Low-stock warning on dashboard. Wholesale never changes inventory.

**UC-SALE-R Retail sales (daily)**
1. Pick/add customer (optional for cash/UPI; **required for credit**). Search existing customers; add new inline.
2. Add lines: rice type + loose (kg/g) or bags + optional explicit price override (customer-specific reduced price).
3. Payment: **cash**, **UPI**, or **credit** (optional advance paid now; optional due date).
4. Saving: stock is deducted; credit sales create a credit entry for the customer.
5. Day view (defaults to today): **loose sales on top, bag sales below**, totals by mode.
6. Staff see **standard prices only** — the reduced price/discount is never shown to them. Super user sees exact figures.
7. Mistakes: `sales:void` cancels a sale and reverses stock and credit.

**UC-SALE-W Wholesale sales (super user/admin only)**
1. Customer required. Rice type chosen from existing names (no prices shown) or a **new name is added to the list**.
2. Lines are bags (count, bag size kg, price per bag) — loose allowed for samples (kg, price per kg).
3. Optional: date the call was received, date sent (= sale date). Cash / UPI / credit (advance, due date optional).
4. No inventory effect. Visible only with `wholesale:view`.

**UC-REM Reminders / pending deliveries (+ bell icon)**
1. "Send later" on a sale form, or the Reminders tab: customer, items, **date & time** wanted, note, (wholesale) call-received date → creates a **pending order** (no stock/sales change yet).
2. A **bell icon** (static — loaded on page load / after actions, no live push) shows the pending count; clicking lists all pending orders (overdue highlighted).
3. **Mark as sent**: asks date sent, cash/UPI/credit; if credit: credit amount (blank = whole amount) and due date (may be blank). This creates the sale **dated on the sent date** (shows in Retail or Wholesale tab by channel), deducts retail stock, creates credit.
4. Orders can be edited or cancelled while pending.

**UC-CRED Credits**
1. Credit comes from credit sales, or is added manually (old book entries).
2. Views: **by customer** (balances), **by date** (credit given date / due date), and **all credits** with filter yet-to-collect / collected / all, retail / wholesale.
3. Record payments (cash/UPI): against one entry, or a lump sum for a customer that is applied **oldest-first**.
4. Overdue (due date passed, balance > 0) is highlighted. `credits:delete` can undo a payment/entry.

**UC-CUST Customers**: name (unique, case-insensitive), phone, place, notes. Detail page: purchase history + credit summary.

**UC-ORIG Original sales (super/admin)**: every sale with exact charged price, standard price, discount, cost and profit.

**UC-REP Reports (super/admin)**: date range, retail/wholesale/both: totals per day, per rice type, per payment mode, top customers, CSV export.

**UC-USER Users (admin)**: list built-in + custom users; create user (pick preset or individual permissions); edit permissions, deactivate, reset password.

---------------------------------------------------------------------------------------------------

## 2. Conventions

* **Dates** `YYYY-MM-DD`; **date-times** `YYYY-MM-DD HH:MM` (API also accepts `T`). Shop-local time, no time zones.
* **Money** = integer rupees (`amount`, totals, balances). **Unit prices** (per kg / per bag) = float, 2 dp.
* **Quantities**: loose in **integer grams** (`grams`), bags as integer `bags`, bag size in `bag_size_grams`. The UI converts kg ↔ g.
* **Envelope**: success `{"ok":true,"data":…}`; failure `{"ok":false,"error":"msg","code":"…"}`.
  Status codes: 400 validation, 401 not logged in, 403 forbidden/csrf, 404, 409 conflict / insufficient stock.
* **Auth**: Flask session cookie. Session keys: `uid` (username), `csrf` (token). Every `POST/PUT/DELETE` under `/api/`
  needs header `X-CSRF-Token: <session csrf>` (except `/api/auth/login`). The page embeds the token (`window.APP.csrf`).
* **No URL changes**: one page (`/`), tabs switch client-side. All data via `/api/...`.
* **Masking rule (important)**: any code that returns sale amounts decides `exact = can("original:view")`.
  If not exact it must return **list (standard) amounts** and **omit** `list_*`, `discount`, `cost`, `profit` fields.
  Only `app/sales/service.py` serialises sales; other modules (customers, reports, dashboard) call it or follow the same rule.
* **Money-moving operations** run inside `with db.transaction():` (stock + sale + credit succeed or fail together).
* **Audit**: write `db.audit(user, action, entity, id, detail)` for create/void/payment/delete/stock changes.
* **Folder rule**: each feature folder = `routes.py` (Blueprint `bp`, thin) + `service.py` (business logic, validation) + `queries.py` (ALL SQL for that feature, no logic).
  Cross-feature calls go through the other feature's `service.py`, never its `queries.py`.

## 3. Database (see `app/db.py` for DDL — it is authoritative)
`app_users`, `customers`, `rice_types`, `stock_movements`, `sales`, `sale_items`, `wholesale_rice_names`,
`credit_entries`, `credit_payments`, view `v_credit_balance`, `pending_orders`, `pending_order_items`, `audit_log`.

Key rules
* `sales.total_amount` = actual charged; `sales.list_total` = at standard prices; `sale_items` keep both `list_*` and actual.
  Retail list price: per-kg `rice_types.price_per_kg`; per-bag `bag_price` (if NULL → bag not offered unless the line gives an explicit `unit_price`; list price then = that explicit price).
  Wholesale has no standard price: `list_unit_price = unit_price`.
* `sale_items.cost_amount` = purchase cost snapshot (`calc.purchase_cost_for_line`), NULL if unknown. Wholesale cost uses `rice_types.purchase_cost_per_kg` when the name matches a retail type, else NULL.
* Credit sale: `paid_amount` = advance, `credit_entries.amount` = `total_amount − paid_amount` (`calc.credit_part_of_sale`). One credit entry per credit sale (`sale_id` set).
* Voiding a sale: stock restored (retail, via `stock_movements kind='sale_void'`), its credit entry set `status='void'`;
  refused (409) if that credit already has payments (delete payments first).
* Credit "status" is derived: `balance == 0` → `settled`, else `open`.
* A loose line whose grams ≥ bag size and whose type has a `bag_price` is auto-split into bag line(s) + remaining loose line (`calc.split_loose_into_bags`).

## 4. Permissions
Keys and presets: `app/auth/permissions.py`. Tab ↔ permission: dashboard→`dashboard:view`, retail→`retail:view`, wholesale→`wholesale:view`,
reminders→`orders:view`, credits→`credits:view`, customers→`customers:view`, inventory→`inventory:view`, original→`original:view`, reports→`reports:view`, users→`users:manage`.
Helper reads that forms need (customer list, rice catalog) accept any of the related permissions (noted per endpoint).

## 5. REST API

`{…}` bodies are JSON. "perm" = permission needed. Unless stated lists are arrays inside `data`.

### 5.1 Auth & users (`app/auth/routes.py`)
| Method & path | perm | Body → `data` |
|---|---|---|
| `POST /api/auth/login` | – | `{username,password}` → `{user, tabs, csrf}`; sets session. 401 on bad login, 429 when locked |
| `POST /api/auth/logout` | login | → `{}` |
| `GET /api/auth/me` | login | → `{user:{username,display_name,role,permissions:[…]}, tabs:[{id,label,icon}], csrf}` |
| `GET /api/users` | users:manage | → `[{id|null,username,display_name,source:'builtin'|'db',role,permissions,is_active}]` |
| `GET /api/users/catalog` | users:manage | → `{permissions:[{key,group,label}], presets:{admin:[…],super:[…],staff:[…]}}` |
| `POST /api/users` | users:manage | `{username,display_name,password,permissions:[…]}` (or `preset:'staff'`) → user. Username unique (also vs built-ins), password ≥ 6 chars |
| `PUT /api/users/<id>` | users:manage | `{display_name?,permissions?,is_active?}` → user (DB users only; permissions normalised with implications) |
| `POST /api/users/<id>/password` | users:manage | `{password}` → `{}` |

### 5.2 Customers (`app/customers`)
| Method & path | perm | Notes |
|---|---|---|
| `GET /api/customers?q=&include_inactive=0` | any of customers:view, retail:edit, wholesale:edit, orders:edit, credits:edit | → `[{id,name,phone,place,notes,is_active,created_at, credit_balance?}]` (`credit_balance` only if `credits:view`; sorted by name) |
| `POST /api/customers` | any of customers:edit, retail:edit, wholesale:edit, orders:edit, credits:edit | `{name,phone?,place?,notes?}` → customer. 409 `duplicate` if name exists (case-insens.) — message names the existing customer |
| `PUT /api/customers/<id>` | customers:edit | same fields + `is_active?` → customer |
| `GET /api/customers/<id>` | customers:view | → `{customer, purchases:[sale header + items, masked per rule, latest 50, only channels the user may view], credit:{total_credit,total_paid,balance}|null}` |

### 5.3 Inventory (`app/inventory`)  — rice type key = `type_name` (URL-encode; route converter `<path:type_name>`)
RiceType = `{type_name,price_per_kg,bag_price|null,bag_size_grams|null,purchase_cost_per_kg|null,bags_qty,loose_grams,low_stock_bags,is_active,updated_at,updated_by}`.
`purchase_cost_per_kg` is **omitted unless the user has `original:view` or `inventory:edit`**.
| Method & path | perm | Body → `data` |
|---|---|---|
| `GET /api/inventory/rice-types?include_inactive=0` | any of inventory:view, retail:edit, orders:edit | → `[RiceType]` sorted by name |
| `POST /api/inventory/rice-types` | inventory:edit | `{type_name,price_per_kg,bag_price?,bag_size_grams?,purchase_cost_per_kg?,bags_qty?,loose_grams?,low_stock_bags?}` → RiceType. 409 if exists. `bags_qty>0` requires bag size. Logs movement `create` |
| `PUT /api/inventory/rice-types/<name>` | inventory:edit | prices / bag size / low_stock_bags / is_active (not stock) → RiceType. Changing `bag_size_grams` while `bags_qty>0` → 409 |
| `POST …/<name>/receive` | inventory:edit | `{bags?,loose_grams?,bag_size_grams?,price_per_kg?,bag_price?,purchase_cost_per_kg?,note?}` new stock arrived; if `bag_size_grams` differs from the current one and bags are in stock → 409 (tell user to sell/adjust first or use a new type name) |
| `POST …/<name>/adjust` | inventory:edit | `{bags_delta?,loose_grams_delta?,note}` (note required) stock-take correction; result may not go negative |
| `POST …/<name>/open-bag` | inventory:edit | `{count?:1}` bags → loose |
| `GET /api/inventory/movements?type_name=&limit=100` | inventory:view | → `[{id,type_name,moved_at,kind,delta_bags,delta_loose_grams,bags_after,loose_after,sale_id,note,created_by}]` |

**Service functions other modules call** (`app/inventory/service.py`, must be inside the caller's transaction):
* `get_rice_type(name, for_update=False) -> dict | None`
* `deduct_for_sale(type_name, item_kind, grams, bags, sale_id, user) -> dict` — applies `calc.plan_*_deduction`, updates stock, logs `sale` movements (and `open_bag` movement when bags were opened); raises `StockError`.
* `restore_for_sale(sale_id, user)` — reverses all `sale` movements of that sale (movement kind `sale_void`).
* `check_availability(type_name, item_kind, grams, bags) -> {ok, message, bags_opened}` — read-only, used by previews.
* `low_stock_list() -> [RiceType]` — types with `bags_qty <= low_stock_bags` and `low_stock_bags > 0`.

### 5.4 Sales (`app/sales`)
**Line (output row)** — masked view: `amount`/`unit_price` are the *standard* values; exact view adds the `list_*`/discount/cost/profit fields:
```
{sale_id,item_id,channel,sale_date,created_at,customer_id,customer_name,rice_type,item_kind,grams,bags,bag_size_grams,
 quantity_label,payment_mode,status,notes, amount,unit_price,
 /* exact only */ list_amount,list_unit_price,discount,cost_amount,profit}
```
**Sale (header)**: `{id,channel,sale_date,created_at,customer_id,customer_name,payment_mode,total_amount,paid_amount,credit_amount,call_received_on,sent_on,notes,status,created_by,credit_id|null,items:[Line…],view:'masked'|'exact', /* exact only */ list_total,discount_total,cost_total,profit_total}`.
(masked `total_amount` = `list_total`; `paid_amount`/`credit_amount` are always real.)

| Method & path | perm | Notes |
|---|---|---|
| `GET /api/sales/retail?date=YYYY-MM-DD` | retail:view | default today → `{view,date,loose:[Line],bags:[Line],sales:[Sale],totals:{total,count,cash,upi,credit,loose_grams,bags,discount?,profit?}}` (void sales excluded; `totals.cash/upi` = amount of sales by mode, `credit` = credit-mode sales total) |
| `POST /api/sales/retail/preview` | retail:edit | same body as create, writes nothing → `{lines:[{rice_type,item_kind,grams,bags,bag_size_grams,list_unit_price,unit_price,list_amount,amount,auto_split:bool,opens_bags:int}],total,list_total,warnings:[str],stock_ok:bool}` |
| `POST /api/sales/retail` | retail:edit | create (below) → Sale (HTTP 201) |
| `GET /api/sales/wholesale?from=&to=&customer_id=` | wholesale:view | default last 30 days → `{view,sales:[Sale],totals:{total,count,bags,cash,upi,credit}}` |
| `POST /api/sales/wholesale` | wholesale:edit | create (below) → Sale (201) |
| `GET /api/sales/wholesale/rice-names` | any of wholesale:edit, orders:edit | → `["Sona Masoori", …]` union of retail types and previously used wholesale names (names only, no prices) |
| `GET /api/sales/original?from=&to=&channel=&customer_id=&payment_mode=` | original:view | default today-30d..today → `{view:'exact',rows:[Line exact],sales:[Sale exact],totals:{total,list_total,discount,cost,profit,count}}` |
| `GET /api/sales/<id>` | retail:view / wholesale:view by channel | → Sale |
| `POST /api/sales/<id>/void` | sales:void (+ channel view) | `{reason?}` → Sale; 409 if its credit has payments |

**Create retail body**
```
{sale_date?: 'YYYY-MM-DD' (default today), customer_id?: int|null, payment_mode: 'cash'|'upi'|'credit',
 advance_paid?: int (credit only, default 0), due_date?: date (credit only), notes?: str,
 items: [{rice_type, item_kind:'loose'|'bag', grams?: int (loose), bags?: int (bag), unit_price?: number /*explicit override: per kg (loose) / per bag (bag)*/ }]}
```
Rules: ≥1 item; credit needs `customer_id`; rice type must exist & be active; list price from `rice_types`; `unit_price` omitted → equals list price;
auto-split loose→bags; stock deducted per line (all-or-nothing); amounts via `calc`; credit entry created when credit.
**Create wholesale body**
```
{customer_id (required), sent_on?: date (default today; = sale_date), call_received_on?: date, payment_mode, advance_paid?, due_date?, notes?,
 items: [{rice_type: free text, item_kind:'bag'|'loose', bags?, bag_size_grams? (required for bag), grams? (loose), unit_price (required)}]}
```
New `rice_type` names are inserted into `wholesale_rice_names`. No stock change.

### 5.5 Credits (`app/credits`)  — all need `credits:view`; wholesale rows only appear for users with `credits:wholesale` (silently filtered)
Entry = `{id,customer_id,customer_name,customer_phone,channel,sale_id,amount,paid,balance,credit_date,due_date,overdue,notes,status:'open'|'settled',created_by,created_at}`;
Payment = `{id,credit_id,customer_id,customer_name,paid_on,amount,mode,notes,created_by,created_at}`.
| Method & path | perm | Notes |
|---|---|---|
| `GET /api/credits/summary` | credits:view | → `{outstanding_total,outstanding_retail,outstanding_wholesale|null,overdue_total,overdue_count,customers_with_balance,collected_today,collected_this_month}` |
| `GET /api/credits/entries?status=open|settled|all&channel=&customer_id=&from=&to=&date_field=credit_date|due_date` | credits:view | all-credits section. default status `open`, sorted by credit_date desc |
| `GET /api/credits/by-customer?status=open|all&q=` | credits:view | → `[{customer_id,name,phone,place,total_credit,total_paid,balance,open_count,oldest_open_date,next_due_date,last_payment_on,overdue}]` (balance>0 first when status=open) |
| `GET /api/credits/by-date?from=&to=&date_field=credit_date|due_date` | credits:view | → `[{date,total_amount,total_balance,entries:[Entry]}]` newest date first |
| `GET /api/credits/customer/<id>` | credits:view | → `{customer,summary:{total_credit,total_paid,balance},entries:[Entry + payments:[Payment]]}` (oldest first) |
| `GET /api/credits/collections?from=&to=&channel=&customer_id=` | credits:view | payments received → `{total, payments:[Payment + channel,customer_name]}` newest first |
| `POST /api/credits/entries` | credits:edit | manual credit `{customer_id,channel:'retail'|'wholesale',amount,credit_date?,due_date?,notes?}` (wholesale needs `credits:wholesale`) → Entry |
| `PUT /api/credits/entries/<id>` | credits:edit | `{due_date?,notes?}` (null due_date clears) → Entry |
| `POST /api/credits/entries/<id>/payments` | credits:edit | `{amount,mode:'cash'|'upi',paid_on?,notes?}`; amount ≤ balance else 400 → `{payment,entry}` |
| `POST /api/credits/customer/<id>/payments` | credits:edit | lump sum `{amount,mode,paid_on?,notes?,channel?}` allocated oldest first (`calc.allocate_fifo`); > total balance → 400 → `{payments:[Payment],allocated,customer_balance}` |
| `DELETE /api/credits/payments/<id>` | credits:delete | undo payment |
| `DELETE /api/credits/entries/<id>` | credits:delete | only manual entries (no `sale_id`) without payments; otherwise 409 (void the sale instead) |

### 5.6 Reminders / pending orders (`app/orders`) — channel visibility follows `retail:view` / `wholesale:view`
Order = `{id,channel,customer_id,customer_name,customer_phone,customer_place,requested_for,call_received_on,notes,status:'pending'|'sent'|'cancelled',overdue,sale_id,created_by,created_at,closed_at,items:[{id,rice_type,item_kind,grams,bags,bag_size_grams,unit_price|null,quantity_label}]}`.
| Method & path | perm | Notes |
|---|---|---|
| `GET /api/orders/summary` | orders:view | bell badge → `{pending,overdue,next_due|null}` |
| `GET /api/orders?status=pending|sent|cancelled|all&channel=&customer_id=` | orders:view | pending sorted by `requested_for` asc; others newest first (limit 200) |
| `POST /api/orders` | orders:edit | `{channel,customer_id,requested_for,call_received_on?,notes?,items:[{rice_type,item_kind,grams?,bags?,bag_size_grams?,unit_price?}]}` → Order (201). Retail items must reference existing rice types; bag lines default `bag_size_grams` from the type |
| `PUT /api/orders/<id>` | orders:edit | same body, pending only |
| `POST /api/orders/<id>/cancel` | orders:edit | `{}` → Order |
| `POST /api/orders/<id>/fulfill` | orders:edit | **Mark as sent** `{sent_date,payment_mode,credit_amount?,due_date?,notes?,item_prices?:{"<item_id>":price}}` → `{order,sale}`. Creates the sale via `sales.service` on `sent_date` (retail: price = `unit_price` or list price, deducts stock; wholesale: every line needs a price from `unit_price` or `item_prices`, else 400). `payment_mode='credit'`: `credit_amount` blank/null = whole total; otherwise `advance_paid = total − credit_amount` |

### 5.7 Reports & dashboard (`app/reports`)
| Method & path | perm | Notes |
|---|---|---|
| `GET /api/dashboard` | dashboard:view | widgets gated per permission, missing → `null`: `{view, today:{retail:{total,count,cash,upi,credit}|null, wholesale:{…}|null}, credits:{outstanding,overdue_total,overdue_count,due_today}|null, orders:{pending,overdue}|null, low_stock:[RiceType]|null, recent_sales:[Line-like rows]|null}` |
| `GET /api/reports/summary?from=&to=&channel=retail|wholesale|both` | reports:view | → `{view,range,totals:{total,count,cash,upi,credit,bags,loose_grams,discount?,profit?},by_day:[{date,total,count,profit?}],by_rice:[{rice_type,grams,bags,amount,profit?}],by_payment_mode:[{mode,total,count}],top_customers:[{customer_id,name,total,count}]}`; wholesale only counted if the user has `wholesale:view` |
| `GET /api/reports/sales.csv?from=&to=&channel=` | reports:view | CSV download (exact columns only with `original:view`) |

## 6. Front end

Single page `GET /` (`app/web.py`): logged-out → login page; logged-in → shell. Jinja renders the shell, and **includes
only the tab partials the user is allowed** (`templates/tabs/<id>.html`) and their scripts (`static/js/tabs/<id>.js`).
No client-side routing/URL change. Tailwind via CDN (pinned), vanilla JS, no build step.

### 6.1 Shell DOM contract (`templates/index.html`)
* `<script>window.APP = {user:{username,display_name,role,permissions:[…]}, tabs:[{id,label,icon}], csrf:"…"}</script>` (JSON via `|tojson`).
* Sidebar (desktop) / top bar + bottom nav (mobile) with one button per tab: `<button data-tab-btn="retail">`.
* Header: user name, **bell** `<button id="bell-btn">` containing `<span id="bell-badge">` (rendered only if user has `orders:view`), logout button.
* Main: each permitted tab = `<section id="tab-<id>" data-tab-panel="<id>" class="hidden">…</section>` (from `templates/tabs/<id>.html`).
* `<div id="modal-root"></div> <div id="toast-root"></div> <div id="drawer-root"></div>` at body end.
* Scripts order: `core/api.js`, `core/ui.js`, `core/components.js`, `core/app.js`, then `core/bell.js` (only with `orders:view`), then `tabs/<id>.js` for each permitted tab.

### 6.2 JavaScript contract (global namespace `App`) — implemented in `static/js/core/*`
```
App.can(perm) -> bool                       App.user, App.csrf, App.tabs
App.registerTab(id, {init(root), show(root)})   // init once (first time shown), show() every time the tab is opened; root = the section element
App.showTab(id)                             // switches panels, no URL/hash change; remembers last tab in sessionStorage
App.refreshBell()                           // re-fetches /api/orders/summary and updates #bell-badge (defined in core/bell.js, no-op if absent)
App.reload(id)                              // re-run show() of a tab if it has been initialised

App.api.get(url, params?, opts?)  App.api.post(url, body?, opts?)  App.api.put(url, body?, opts?)  App.api.del(url, opts?)
   -> Promise<data> (envelope unwrapped). Rejects with Error {message, code, status}. Adds X-CSRF-Token. Shows an error toast
      unless opts.silent. 401 -> location.reload(). Skips null/''/undefined params. Download helper: App.api.download(url, params).

App.ui.h(tag, attrs?, ...children) -> HTMLElement       // hyperscript; attrs: class, on{click:fn}, dataset{}, value, etc.; children: nodes|strings|arrays|null
App.ui.toast(message, type='success'|'error'|'info')
App.ui.confirm({title, message, confirmText='Confirm', cancelText='Cancel', danger=false}) -> Promise<boolean>
App.ui.modal({title, body:Node|string, size:'sm'|'md'|'lg'|'xl', onClose?}) -> {el, body, close(), setTitle(t)}
App.ui.drawer({title, body:Node, side:'right'}) -> {el, body, close()}
App.ui.spinner() -> Node       App.ui.empty(message, icon?) -> Node     App.ui.badge(text, tone='gray'|'green'|'red'|'amber'|'blue') -> Node
App.ui.field({label, input:Node, hint?, error?}) -> Node               // labelled form row with the app's styling
App.ui.btn(label, {kind:'primary'|'secondary'|'danger'|'ghost', icon?, onClick?, type?, small?}) -> HTMLButtonElement
App.ui.input(attrs) / App.ui.select(options:[{value,label}], attrs) / App.ui.textarea(attrs)   // styled controls
App.ui.table({columns:[{key,label,align?,render?(row)->Node|string,class?}], rows, empty?, onRowClick?, footer?}) -> Node
App.ui.tabs({items:[{id,label,badge?}], active, onChange(id)}) -> {el, setActive(id)}   // inner pill tabs (e.g. Retail: Today/History)
App.icon(name, cls?) -> inline SVG Node   // names: home shopping truck clock ledger users box eye chart shield bell plus minus trash edit
                                         //        check x search phone rupee calendar logout refresh send alert download
App.fmt.money(n) '₹1,250'   App.fmt.kg(grams) '2.5 kg'/'250 g'   App.fmt.qty(line) '3 bags × 25 kg' / '2.5 kg'
App.fmt.date('2026-11-05') '05 Nov 2026'   App.fmt.dateTime('2026-11-05 16:30') '05 Nov, 4:30 PM'   App.fmt.today() 'YYYY-MM-DD'
App.fmt.kgToGrams(x) -> int (decimal-safe string math)   App.fmt.gramsToKg(g) -> number   App.fmt.num(n)

App.components.customerPicker({value?:id, required?:bool, allowCreate=true, onChange?(customer|null)}) -> {el, getId(), getCustomer(), setCustomer(c|null), reload()}
     // searchable dropdown of ALL customers (+ credit balance hint if available) with an inline "+ New customer" mini-form
App.components.ricePicker({mode:'retail'|'wholesale', onChange?}) -> {el, getValue(), setValue(v)}
     // retail: select from /api/inventory/rice-types; wholesale: combobox of /api/sales/wholesale/rice-names that also accepts a NEW typed name
App.components.stat({label, value, sub?, tone?}) -> Node       // KPI card
App.components.dateRange({from, to, onChange}) -> {el, get()}   // two date inputs + quick buttons (Today, 7d, 30d, This month)
```
Tab modules self-register: `App.registerTab('retail', {init(root){…}, show(root){…}})`.

### 6.3 Look & feel
Warm, clean, "shop ledger" feel: stone/amber neutrals with an emerald primary, rounded cards, soft shadows,
large touch-friendly controls (the owner may use a phone/tablet at the counter), readable ₹ numbers (tabular nums),
clear empty states, toasts for every action, confirm dialogs for destructive actions, loading spinners. Fully responsive
(sidebar → bottom nav on mobile). Prefer dark text on light; keep the UI calm — no clutter.

## 7. Testing
`pytest` from the project root (fixtures in `tests/conftest.py`: `admin`, `anand`, `staff` logged-in clients with CSRF set).
Add `tests/test_<feature>.py` per module. `tests/test_calc.py` covers `utils/calc.py`.

## 8. Run
```
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python run.py          # http://127.0.0.1:5000
.venv/bin/python -m pytest
```

## 9. Cross-module service contracts (functions other features may import)
Always import the *service* module, lazily inside the function when it would create an import cycle.

| Module | Function | Returns |
|---|---|---|
| `app.auth.identity` | `load_user_from_session() -> User \| None`, `authenticate(username, password) -> User \| None` | used by `permissions.current_user` and login |
| `app.customers.service` | `get_customer(customer_id) -> dict \| None` · `customer_names(ids) -> {id: name}` · `require_customer(customer_id) -> dict` (404 `ApiError` if missing/inactive) | customer rows |
| `app.inventory.service` | see §5.3 (`get_rice_type`, `deduct_for_sale`, `restore_for_sale`, `check_availability`, `low_stock_list`) | |
| `app.sales.service` | `create_sale(channel, payload, user, *, source_order_id=None) -> Sale` (used by orders → fulfil; runs inside caller's transaction) · `customer_purchases(customer_id, limit=50) -> [Sale]` (masked + channel-permission filtered for the current user) | |
| `app.credits.service` | `create_credit_for_sale(sale_id, customer_id, channel, amount, credit_date, due_date, user) -> int` · `void_credit_for_sale(sale_id, user)` (409 if payments exist) · `customer_summary(customer_id) -> {total_credit,total_paid,balance}` · `balances_by_customer() -> {customer_id: balance}` (retail+wholesale as permitted for the current user) | |
| `app.orders.service` | – (leaf) | |
| `app.reports.service` | – (leaf, reads through other services/queries respecting the masking rule) | |

Ownership of SQL: a feature's `queries.py` may only touch its own tables, EXCEPT read-only JOINs against `customers`
(for names) and `v_credit_balance`. `reports/queries.py` may aggregate over `sales`/`sale_items` (read-only) but must
apply the masking rule (use `list_amount` unless exact).

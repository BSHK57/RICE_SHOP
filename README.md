# Rice Shop Manager

A small web app that runs the rice shop's books on one computer. It records retail sales (loose
rice or bags) and wholesale sales, tracks the stock of each rice type, keeps a ledger of what
credit customers owe and have paid, and keeps a list of reminders for deliveries customers have
asked for. You open it in a web browser; there is nothing to install on the phones or tablets
that use it, only a browser.

---

## Quick start

These steps are for the computer that runs the shop. The app was built and tested with Python 3.12.
Run the commands from the `rice_shop` folder.

1. Create a virtual environment (a private copy of Python for this app):

   ```
   python3 -m venv .venv
   ```

   On Ubuntu/Debian, if this fails, first run `sudo apt install python3-venv`.

2. Install the app's requirements (Flask):

   ```
   .venv/bin/pip install -r requirements.txt
   ```

   On Windows use `.venv\Scripts\pip` and `.venv\Scripts\python` instead of `.venv/bin/...`.

3. Start the app:

   ```
   .venv/bin/python run.py
   ```

4. Open **http://127.0.0.1:5000** in a browser on the same computer and log in (see the
   logins table below).

Stop the app with `Ctrl+C` in the terminal.

### Using phones and tablets on the shop Wi-Fi

1. **Change the default passwords first** (see "Logins" below). Anyone on the Wi-Fi who can reach
   the app can try to log in.
2. Start the app so it accepts connections from other devices:

   ```
   HOST=0.0.0.0 .venv/bin/python run.py
   ```

3. Find the computer's address on the Wi-Fi. On Linux run `hostname -I`; on Windows run
   `ipconfig` and look for the IPv4 address. Suppose it is `192.168.1.20`.
4. On the phone, open **http://192.168.1.20:5000** (use your own address). The phone must be on
   the same Wi-Fi. If it does not load, the computer's firewall may be blocking port 5000; allow
   it for the local network.

The app is served over plain `http`, not `https`, so traffic on the Wi-Fi is not encrypted. Use it
only on the shop's own network.

To use a different port, set `PORT`, for example `PORT=8000 .venv/bin/python run.py`.

---

## Logins

| Username | Password | Who it is for | Notes |
|---|---|---|---|
| `admin` | `admin@123` | Administrator | Can do everything, including the Users tab |
| `anand` | `anand1970` | Anand (the owner, "super user") | Can do everything except manage users |
| `staff` | `staff@123` | Staff | **The staff password is a placeholder. It was not specified, so change it before daily use.** |

**Where to change the built-in logins:** open `app/auth/identity.py` and edit the
`HARDCODED_USERS` dictionary near the top. Then restart the app. Only these three built-in logins
live in the code; users added later from the Users tab are stored in the database, and their
passwords are set there.

---

## Who can see and do what

| Person | Tabs they see | What they can do | What they cannot see |
|---|---|---|---|
| **Admin** | All tabs, including Users | Everything the owner can do, plus add users, choose each user's tabs and actions, deactivate users and reset their passwords | Nothing is hidden |
| **Anand (super user)** | All tabs except Users | Stock and prices, record retail and wholesale sales, cancel (void) a wrong sale, record and undo payments, manage customers and reminders, see reports | Cannot manage users |
| **Staff** | Dashboard, Retail Sales, Credits, Customers | Look at retail sales, look at credits by customer and by date, record payments, add credit and change due dates; view the customer list | Cannot record sales, cannot see wholesale, **never sees discounts** (retail sales show the standard price only), cannot undo payments or delete credit, cannot change stock, prices or customers, no reports |

Staff see standard prices only. The exact price, discounts, purchase cost and profit appear only for
users with the "See exact prices" permission, which the owner and admin have. (See the known
limitations below for one way staff can still work out a discount.)

---

## Tabs overview

- **Dashboard**: today's sales by channel and payment mode, credit outstanding and overdue, pending
  reminders, low-stock warnings and the latest sales.
- **Retail Sales**: record a retail sale (cash, UPI or credit), see today's sales with loose rice
  listed above bags, and look at past days.
- **Wholesale**: record wholesale sales, which are almost always bags. Wholesale does not change
  stock.
- **Reminders**: deliveries a customer has asked for, with a date and time. Shows overdue items
  first. "Mark as sent" turns a reminder into a real sale.
- **Credits**: outstanding balances by customer, credits by date, all credits (open, settled or
  all), and payments received. Record payments here.
- **Customers**: the customer book (name, phone, place, notes), with each customer's purchase
  history and credit summary.
- **Inventory**: rice types with prices, bag size and stock. Receive new stock, correct stock,
  open a bag by hand and see the stock movement history.
- **Original Sales**: every sale with exact prices, discounts, cost and profit. Cancelling a
  wrong sale (voiding it) needs the "Cancel a sale" permission, which the owner and admin have.
- **Reports**: totals for a date range by day, by rice type, by payment mode and top customers,
  with a CSV download.
- **Users** (admin only): create users, pick what each one can do, deactivate, reset passwords.

The bell icon at the top shows how many reminders are pending. Overdue reminders are highlighted
in the list it opens.

---

## How the stock rules work

Each rice type has a price per kg, an optional bag price (leave it blank if the type is not sold in
bags), a bag size (for example 25 kg), the number of full bags in stock, and the loose rice in
stock (in grams).

- **Loose sales come from loose stock first.** If the loose stock is not enough, whole bags are
  opened automatically: the bag count goes down by one per bag opened and the loose stock goes up
  by a bag's weight, and then the sale is taken from the loose stock. Example: 3 bags and 1 kg loose
  in stock, a sale of 5 kg, bags are 25 kg: one bag is opened, leaving 2 bags and 21 kg loose.
- **A loose request that adds up to a full bag becomes a bag sale.** For a type that has a bag
  price, asking for 25 kg is recorded as one bag, and asking for 27 kg is recorded as one bag plus
  2 kg loose. A type without a bag price keeps loose requests as loose.
- **Bag sales take whole bags** from the bags in stock.
- **Wholesale never changes stock.** Wholesale is recorded for the books only.
- **Stock never goes below zero.** If a sale needs more than is in stock, the app refuses it and
  says how much is available. The sale form shows what stock will be used, and any bags that will
  be opened, before you save.
- **Cancelling (voiding) a retail sale puts its stock back.**
- The Inventory tab can receive new stock, make a stock-take correction (a note is required), and
  open bags by hand. A new bag size cannot be mixed with bags of a different size already in stock.

---

## Credits and reminders

1. A **credit sale** (retail or wholesale) creates a credit entry for the customer. Any advance paid
   at the time is not credit; only the rest is.
2. **Payments** are recorded either against one credit entry, or as one lump sum for a customer. A
   lump sum is applied to the oldest credit first.
3. A credit with a **due date** that has passed, and money still owed, is shown as overdue.
4. A **reminder** records the customer, the items, and the date and time they want them. It changes
   no stock and creates no sale until it is marked as sent. The bell icon shows the pending count.
5. **Mark as sent** asks for the date sent and how it was paid. This creates the real sale, dated
   the day it was sent, deducts retail stock, and creates the credit if the payment is on credit.
   A blank credit amount means the whole bill is on credit.

---

## Project structure

```
rice_shop/
  run.py                  starts the app (reads HOST and PORT from the environment)
  requirements.txt        the one library the app needs: Flask
  README.md               this file
  docs/DESIGN.md          the design: rules, permissions, every API route
  app/
    __init__.py           app factory: builds the app and connects every feature's routes
    db.py                 database connection, ALL table definitions, transactions, audit log
    web.py                the single web page: login page or the main screen
    auth/                 logins, users and permissions
      identity.py           built-in logins, DB users, login lock-out, user admin
      permissions.py        who can do what, presets, sidebar tabs
      queries.py            SQL for users
      routes.py             the login and Users-tab web addresses
    customers/            customer book (routes.py -> service.py -> queries.py)
    inventory/            rice types, stock and stock movements (routes -> service -> queries)
    sales/                retail and wholesale sales, prices, the one place sales are shown
    credits/              credit entries, payments and balances
    orders/               reminders (pending orders) and "mark as sent"
    reports/              dashboard and reports (routes -> service -> queries)
    utils/
      calc.py             ALL the maths: grams, bags, money, credit allocation
      common.py           response format and input checks shared by all features
    static/
      css/app.css         the app's own styles
      js/core/            shared front end: API calls, buttons and dialogs, bell, app start-up
      js/shared/          sale form, reminder dialog and sale helpers used by several tabs
      js/tabs/            one script per tab
      js/login.js         the login page
    templates/            HTML: index.html (main screen), login.html, _head.html, tabs/ (one per tab)
  tests/                  automated tests (pytest)
  scripts/seed_demo.py    optional: fills a separate demo database with sample data
  instance/               created when the app runs: rice_shop.db (the shop's data) and secret_key
  .venv/                  the Python environment (not part of the app)
```

**The rule:** in each feature folder, `routes.py` only receives requests and sends answers, and
calls `service.py`; `service.py` holds the rules and checks, and calls `queries.py`; `queries.py`
holds all the SQL. All database tables are defined in `app/db.py`. All arithmetic lives in
`app/utils/calc.py`.

### Optional: demo data

`scripts/seed_demo.py` creates a separate demo database (`instance/demo.db`) with rice types,
customers, sales, reminders and payments, all entered through the app's own routes. It never
touches the real database unless you pass `--force-real`. To try it:

```
.venv/bin/python scripts/seed_demo.py
RICE_SHOP_DB=instance/demo.db .venv/bin/python run.py
```

Delete `instance/demo.db` when you are done. The script refuses to overwrite an existing file.

---

## How to add a new feature or tab

1. **Create the folder** `app/<feature>/` with an empty `__init__.py`, and three files:
   - `queries.py`: only the SQL for this feature.
   - `service.py`: the rules, checks and calculations, calling `queries.py`.
   - `routes.py`: a Flask Blueprint called `bp` that only reads the request, calls `service.py`
     and returns `ok(...)` from `app/utils/common.py`.
2. **Add the tables** to `SCHEMA_SQL` in `app/db.py`, using `CREATE TABLE IF NOT EXISTS`. New
   tables are created the next time the app starts. Changing a table that already exists needs a
   manual SQL change to the database, because the app has no migration system yet.
3. **Register the routes**: add the module name (for example `"app.<feature>.routes"`) to
   `BLUEPRINT_MODULES` in `app/__init__.py`.
4. **Add permissions**: add new keys to `PERMISSION_CATALOG` in `app/auth/permissions.py`. Add them
   to `PRESETS` if the built-in admin, super user or staff should have them, and to `IMPLIES` if one
   key should grant another.
5. **Add the tab**: add an entry to `TABS` in `app/auth/permissions.py` with an `id`, a `label`, an
   `icon` (one of the names in `App.icon` in `app/static/js/core/ui.js`, for example `box`) and the
   permission that shows it in `requires`.
6. **Build the screen**: create `app/templates/tabs/<id>.html` (the content of the tab) and
   `app/static/js/tabs/<id>.js`, which calls `App.registerTab('<id>', { init(root) {...}, show(root) {...} })`.
   Use the helpers listed in `docs/DESIGN.md`, section 6.2.
7. **Money and quantities**: do the arithmetic in `app/utils/calc.py` and add a test there. Grams are
   whole numbers; money is whole rupees.
8. **Sale amounts**: if your feature shows sale amounts, use the serializer in
   `app/sales/service.py`, so staff still see only standard prices.
9. **Changes that move money or stock**: wrap them in `with db.transaction():` and record them with
   `db.audit(...)`.
10. **Tests**: add `tests/test_<feature>.py` and run the test suite (see below).
11. **Restart the app** and reload the browser. The app does not reload code by itself unless it is
    started with `FLASK_DEBUG=1`.

---

## Backup

All the shop's data is in one file, **`instance/rice_shop.db`**. While the app runs, SQLite may
also keep recent changes in two side files, `instance/rice_shop.db-wal` and
`instance/rice_shop.db-shm`. Both are part of the database.

**Simplest backup:** stop the app (`Ctrl+C`), then copy `instance/rice_shop.db` together with any
`rice_shop.db-wal` and `rice_shop.db-shm` files that exist, to a safe place.

**Backup while the app is running:** this command writes a dated copy into a `backups` folder
inside the project. It is safe to run while the app is in use.

```
mkdir -p backups && .venv/bin/python -c "import sqlite3,datetime; s=sqlite3.connect('instance/rice_shop.db'); d=sqlite3.connect('backups/rice_shop-'+str(datetime.date.today())+'.db'); s.backup(d); d.close(); s.close()"
```

**A daily backup at 11:30 pm with cron** (run `crontab -e` and add this line, using the real
path to the `rice_shop` folder in place of `/home/USER/rice_shop`):

```
30 23 * * * cd /home/USER/rice_shop && mkdir -p backups && .venv/bin/python -c "import sqlite3,datetime; s=sqlite3.connect('instance/rice_shop.db'); d=sqlite3.connect('backups/rice_shop-'+str(datetime.date.today())+'.db'); s.backup(d); d.close(); s.close()"
```

Copy the backups to another drive or to cloud storage from time to time. A backup kept only on the
same computer is lost if the computer is lost.

**To restore:** stop the app, rename the damaged `instance/rice_shop.db` as a safety copy, delete
any `instance/rice_shop.db-wal` and `instance/rice_shop.db-shm` files, copy the backup file into
place and name it `instance/rice_shop.db`, then start the app again.

---

## Running the tests

The tests use temporary databases, not the shop's data. The tests need `pytest`, which is listed in
`requirements-dev.txt`, so install it once:

```
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest
```

---

## Known limitations

- **The browser needs internet access for the styling.** The app loads its Tailwind CSS from
  `cdn.tailwindcss.com` (set in `app/templates/_head.html`). Without internet, the pages appear
  without their styling. To remove this dependency later, build the CSS locally with the Tailwind
  standalone command-line tool and point `_head.html` at the local file.
- **Staff can still work out a discount.** Staff see standard prices, but a credit sale's credit
  amount is the real amount owed after the advance, and the credit list shows that real amount. The
  difference from the standard price reveals the discount.
- **Built-in users are hard-coded.** Their logins are in `app/auth/identity.py` as plain text. They
  cannot be deactivated or have their passwords reset from the Users tab; change them in the file
  and restart.
- **The login lock resets on restart.** After 5 wrong passwords for a username from one device,
  that combination is locked for 5 minutes. The record of failed attempts is kept in memory, so
  restarting the app clears it.
- **Plain http on the Wi-Fi.** Passwords and data travel unencrypted on the shop's network (see the
  phones section above).
- **Built for one shop with a few users.** The data is a single SQLite file. It suits one shop with
  two or three people; it is not designed for many shops or many people working at the same moment.
- **No automatic database upgrades.** Adding a column to an existing table needs a manual change to
  the database; see "How to add a new feature".
- **Default server.** `run.py` starts Flask's built-in server. The file mentions a sturdier server,
  waitress, which is not in `requirements.txt`. If you want it, install it with
  `.venv/bin/pip install waitress` and run
  `.venv/bin/waitress-serve --listen=0.0.0.0:5000 --call app:create_app`. This command has not been
  tested with this project.

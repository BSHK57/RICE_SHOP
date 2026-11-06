"""
db.py - the ONE place for all database plumbing.

Contains:
  * SQLite connection management (one connection per request, stored on flask.g)
  * The complete schema (DDL) for every module
  * Tiny query helpers (query_all / query_one / execute / transaction)
  * Audit-log helper

What does NOT live here: business SQL. Each feature folder (customers, inventory,
sales, credits, orders, reports) has its own `queries.py` holding its SQL statements,
and calls the helpers below to run them.

Conventions (see docs/DESIGN.md for the full list)
  * Dates are TEXT 'YYYY-MM-DD'; date-times are TEXT 'YYYY-MM-DD HH:MM:SS' (shop local time).
  * Money amounts are INTEGER rupees. Per-unit prices (per kg / per bag) are REAL.
  * Loose rice quantities are INTEGER grams (never floats), bags are INTEGER counts.
  * The connection runs in autocommit mode; wrap multi-statement writes in
    `with transaction():` so they commit or roll back together.
"""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Iterable, Iterator

from flask import current_app, g, has_app_context

# --------------------------------------------------------------------------- #
# Schema
# --------------------------------------------------------------------------- #
SCHEMA_VERSION = 1

SCHEMA_SQL = """
-- ============================== auth / users ============================== --
-- Built-in users (admin / anand / staff) are hard-coded in app/auth/identity.py.
-- Users created by the admin from the UI live here.
CREATE TABLE IF NOT EXISTS app_users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    permissions   TEXT NOT NULL DEFAULT '[]',      -- JSON list of permission keys
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL
);

-- ================================ customers =============================== --
CREATE TABLE IF NOT EXISTS customers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- the name/nickname the shop uses
    phone      TEXT,
    place      TEXT,
    notes      TEXT,
    is_active  INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    created_by TEXT
);

-- ================================ inventory =============================== --
-- Retail stock only. Wholesale sales never touch this table.
CREATE TABLE IF NOT EXISTS rice_types (
    type_name            TEXT PRIMARY KEY COLLATE NOCASE,
    price_per_kg         REAL    NOT NULL CHECK (price_per_kg >= 0),   -- standard retail price / kg
    bag_price            REAL             CHECK (bag_price IS NULL OR bag_price >= 0), -- NULL = not sold in bags
    bag_size_grams       INTEGER          CHECK (bag_size_grams IS NULL OR bag_size_grams > 0),
    purchase_cost_per_kg REAL,                                         -- what the shop paid (profit calc), optional
    bags_qty             INTEGER NOT NULL DEFAULT 0 CHECK (bags_qty >= 0),
    loose_grams          INTEGER NOT NULL DEFAULT 0 CHECK (loose_grams >= 0),
    low_stock_bags       INTEGER NOT NULL DEFAULT 0,                   -- dashboard warning threshold
    is_active            INTEGER NOT NULL DEFAULT 1,
    updated_at           TEXT NOT NULL,
    updated_by           TEXT
);

CREATE TABLE IF NOT EXISTS stock_movements (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    type_name         TEXT NOT NULL COLLATE NOCASE,
    moved_at          TEXT NOT NULL,
    kind              TEXT NOT NULL CHECK (kind IN
                        ('create','receive','adjust','open_bag','sale','sale_void')),
    delta_bags        INTEGER NOT NULL DEFAULT 0,
    delta_loose_grams INTEGER NOT NULL DEFAULT 0,
    bags_after        INTEGER NOT NULL,
    loose_after       INTEGER NOT NULL,
    sale_id           INTEGER,
    note              TEXT,
    created_by        TEXT
);
CREATE INDEX IF NOT EXISTS ix_stock_mov_type ON stock_movements(type_name, id);

-- ================================== sales ================================= --
CREATE TABLE IF NOT EXISTS sales (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    channel          TEXT NOT NULL CHECK (channel IN ('retail','wholesale')),
    sale_date        TEXT NOT NULL,                 -- the day this sale counts for (sent/sold date)
    customer_id      INTEGER REFERENCES customers(id),   -- optional for retail cash/upi, required otherwise
    payment_mode     TEXT NOT NULL CHECK (payment_mode IN ('cash','upi','credit')),
    total_amount     INTEGER NOT NULL,              -- ACTUAL amount charged
    list_total       INTEGER NOT NULL,              -- amount at standard prices (what staff see)
    cost_total       INTEGER,                       -- purchase cost, NULL when unknown
    paid_amount      INTEGER NOT NULL DEFAULT 0,    -- collected at the time of sale (all of it for cash/upi)
    call_received_on TEXT,                          -- wholesale: date the customer called (optional)
    sent_on          TEXT,                          -- wholesale: date the rice was sent
    notes            TEXT,
    status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
    source_order_id  INTEGER,                       -- set when created from a pending order
    created_by       TEXT,
    created_at       TEXT NOT NULL,
    voided_at        TEXT,
    void_reason      TEXT
);
CREATE INDEX IF NOT EXISTS ix_sales_date    ON sales(channel, sale_date);
CREATE INDEX IF NOT EXISTS ix_sales_cust    ON sales(customer_id);

CREATE TABLE IF NOT EXISTS sale_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id          INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    rice_type        TEXT NOT NULL COLLATE NOCASE,
    item_kind        TEXT NOT NULL CHECK (item_kind IN ('loose','bag')),
    grams            INTEGER NOT NULL DEFAULT 0,    -- loose lines: grams sold
    bags             INTEGER NOT NULL DEFAULT 0,    -- bag lines: number of bags
    bag_size_grams   INTEGER,                       -- bag lines: size snapshot
    list_unit_price  REAL NOT NULL,                 -- standard price (per kg for loose, per bag for bag)
    unit_price       REAL NOT NULL,                 -- price actually charged (same unit)
    list_amount      INTEGER NOT NULL,
    amount           INTEGER NOT NULL,
    cost_amount      INTEGER                        -- NULL when purchase cost unknown
);
CREATE INDEX IF NOT EXISTS ix_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS ix_sale_items_type ON sale_items(rice_type);

-- Names offered in the wholesale form (union with rice_types.type_name).
CREATE TABLE IF NOT EXISTS wholesale_rice_names (
    name       TEXT PRIMARY KEY COLLATE NOCASE,
    created_at TEXT NOT NULL
);

-- ================================== credits =============================== --
CREATE TABLE IF NOT EXISTS credit_entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    sale_id     INTEGER REFERENCES sales(id),       -- NULL for manually entered (old book) credit
    channel     TEXT NOT NULL CHECK (channel IN ('retail','wholesale')),
    amount      INTEGER NOT NULL CHECK (amount > 0),
    credit_date TEXT NOT NULL,
    due_date    TEXT,                               -- when to collect (optional)
    notes       TEXT,
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
    created_by  TEXT,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_credit_cust ON credit_entries(customer_id);
CREATE INDEX IF NOT EXISTS ix_credit_date ON credit_entries(credit_date);

CREATE TABLE IF NOT EXISTS credit_payments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    credit_id   INTEGER NOT NULL REFERENCES credit_entries(id),
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    paid_on     TEXT NOT NULL,
    amount      INTEGER NOT NULL CHECK (amount > 0),
    mode        TEXT NOT NULL CHECK (mode IN ('cash','upi')),
    notes       TEXT,
    created_by  TEXT,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_credit_pay_credit ON credit_payments(credit_id);
CREATE INDEX IF NOT EXISTS ix_credit_pay_date   ON credit_payments(paid_on);

-- credit_entries + paid/balance. Settled <=> balance = 0. Filter status='active' yourself.
CREATE VIEW IF NOT EXISTS v_credit_balance AS
SELECT ce.*,
       COALESCE(SUM(cp.amount), 0)              AS paid,
       ce.amount - COALESCE(SUM(cp.amount), 0)  AS balance
  FROM credit_entries ce
  LEFT JOIN credit_payments cp ON cp.credit_id = ce.id
 GROUP BY ce.id;

-- =========================== pending orders / reminders =================== --
CREATE TABLE IF NOT EXISTS pending_orders (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    channel          TEXT NOT NULL CHECK (channel IN ('retail','wholesale')),
    customer_id      INTEGER NOT NULL REFERENCES customers(id),
    requested_for    TEXT NOT NULL,                 -- 'YYYY-MM-DD HH:MM' when the customer wants it
    call_received_on TEXT,
    notes            TEXT,
    status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','cancelled')),
    sale_id          INTEGER REFERENCES sales(id),  -- filled when marked as sent
    created_by       TEXT,
    created_at       TEXT NOT NULL,
    closed_at        TEXT
);
CREATE INDEX IF NOT EXISTS ix_orders_status ON pending_orders(status, requested_for);

CREATE TABLE IF NOT EXISTS pending_order_items (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id       INTEGER NOT NULL REFERENCES pending_orders(id) ON DELETE CASCADE,
    rice_type      TEXT NOT NULL COLLATE NOCASE,
    item_kind      TEXT NOT NULL CHECK (item_kind IN ('loose','bag')),
    grams          INTEGER NOT NULL DEFAULT 0,
    bags           INTEGER NOT NULL DEFAULT 0,
    bag_size_grams INTEGER,
    unit_price     REAL                              -- optional agreed price, NULL = decide when sent
);

-- ================================== audit ================================= --
CREATE TABLE IF NOT EXISTS audit_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        TEXT NOT NULL,
    user      TEXT,
    action    TEXT NOT NULL,
    entity    TEXT NOT NULL,
    entity_id TEXT,
    detail    TEXT                                    -- JSON
);

CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT);
"""


# --------------------------------------------------------------------------- #
# Connection management
# --------------------------------------------------------------------------- #
def _connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, isolation_level=None, timeout=15)  # autocommit; we BEGIN manually
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 15000")
    return conn


def get_db() -> sqlite3.Connection:
    """Per-request connection (flask.g). Created lazily, closed on app-context teardown."""
    if "db" not in g:
        g.db = _connect(current_app.config["DATABASE"])
        g.tx_depth = 0
    return g.db


def close_db(_exc: BaseException | None = None) -> None:
    conn = g.pop("db", None)
    g.pop("tx_depth", None)
    if conn is not None:
        conn.close()


def init_db(app) -> None:
    """Create all tables/views if missing. Safe to call on every start."""
    conn = _connect(app.config["DATABASE"])
    try:
        conn.executescript(SCHEMA_SQL)
        conn.execute(
            "INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', ?)",
            (str(SCHEMA_VERSION),),
        )
    finally:
        conn.close()


def init_app(app) -> None:
    """Register teardown + create the schema. Called from the app factory."""
    import os

    os.makedirs(os.path.dirname(app.config["DATABASE"]) or ".", exist_ok=True)
    init_db(app)
    app.teardown_appcontext(close_db)


# --------------------------------------------------------------------------- #
# Query helpers
# --------------------------------------------------------------------------- #
def _row_to_dict(row: sqlite3.Row | None) -> dict | None:
    return None if row is None else dict(row)


def query_all(sql: str, params: Iterable[Any] | dict = ()) -> list[dict]:
    return [dict(r) for r in get_db().execute(sql, params).fetchall()]


def query_one(sql: str, params: Iterable[Any] | dict = ()) -> dict | None:
    return _row_to_dict(get_db().execute(sql, params).fetchone())


def query_value(sql: str, params: Iterable[Any] | dict = (), default: Any = None) -> Any:
    row = get_db().execute(sql, params).fetchone()
    return default if row is None or row[0] is None else row[0]


def execute(sql: str, params: Iterable[Any] | dict = ()) -> sqlite3.Cursor:
    """Run a write statement. Use `cursor.lastrowid` / `cursor.rowcount` as needed."""
    return get_db().execute(sql, params)


@contextmanager
def transaction() -> Iterator[sqlite3.Connection]:
    """
    Atomic block. Nested use joins the outer transaction.

        with transaction():
            sale_id = queries.insert_sale(...)
            inventory.service.deduct(...)
    Any exception rolls everything back and is re-raised.
    """
    conn = get_db()
    outermost = g.tx_depth == 0
    if outermost:
        conn.execute("BEGIN IMMEDIATE")  # take the write lock up-front -> no lost stock updates
    g.tx_depth += 1
    try:
        yield conn
    except BaseException:
        g.tx_depth -= 1
        if outermost:
            conn.execute("ROLLBACK")
        raise
    else:
        g.tx_depth -= 1
        if outermost:
            conn.execute("COMMIT")


# --------------------------------------------------------------------------- #
# Time + audit helpers
# --------------------------------------------------------------------------- #
def now_str() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def today_str() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def audit(user: str | None, action: str, entity: str, entity_id: Any = None, detail: dict | None = None) -> None:
    execute(
        "INSERT INTO audit_log(at, user, action, entity, entity_id, detail) VALUES (?,?,?,?,?,?)",
        (now_str(), user, action, entity, None if entity_id is None else str(entity_id),
         json.dumps(detail or {}, default=str)),
    )

"""
sales/queries.py - ALL SQL for sales, sale_items and wholesale_rice_names. No business rules here.

Read-only JOINs against `customers` (for names) are allowed by the design. Filters are passed in
already validated by service.py; column names are never taken from user input.
"""
from __future__ import annotations

from app import db

_SALE_COLS = """
    s.id, s.channel, s.sale_date, s.customer_id, c.name AS customer_name, s.payment_mode,
    s.total_amount, s.list_total, s.cost_total, s.paid_amount, s.call_received_on, s.sent_on,
    s.notes, s.status, s.source_order_id, s.created_by, s.created_at, s.voided_at, s.void_reason
"""


def insert_sale(row: dict) -> int:
    cur = db.execute(
        """INSERT INTO sales(channel, sale_date, customer_id, payment_mode, total_amount, list_total,
                             cost_total, paid_amount, call_received_on, sent_on, notes, status,
                             source_order_id, created_by, created_at)
           VALUES (:channel, :sale_date, :customer_id, :payment_mode, :total_amount, :list_total,
                   :cost_total, :paid_amount, :call_received_on, :sent_on, :notes, 'active',
                   :source_order_id, :created_by, :created_at)""",
        row,
    )
    return cur.lastrowid


def insert_item(sale_id: int, item: dict) -> int:
    cur = db.execute(
        """INSERT INTO sale_items(sale_id, rice_type, item_kind, grams, bags, bag_size_grams,
                                  list_unit_price, unit_price, list_amount, amount, cost_amount)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (sale_id, item["rice_type"], item["item_kind"], item["grams"], item["bags"], item["bag_size_grams"],
         item["list_unit_price"], item["unit_price"], item["list_amount"], item["amount"], item["cost_amount"]),
    )
    return cur.lastrowid


def get_sale(sale_id: int) -> dict | None:
    return db.query_one(
        f"SELECT {_SALE_COLS} FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE s.id = ?",
        (sale_id,),
    )


def list_sales(*, channels: list[str], date_from: str | None = None, date_to: str | None = None,
               customer_id: int | None = None, payment_mode: str | None = None,
               include_void: bool = False, newest_first: bool = False, limit: int | None = None) -> list[dict]:
    if not channels:
        return []
    where = [f"s.channel IN ({','.join('?' * len(channels))})"]
    params: list = list(channels)
    if date_from:
        where.append("s.sale_date >= ?")
        params.append(date_from)
    if date_to:
        where.append("s.sale_date <= ?")
        params.append(date_to)
    if customer_id is not None:
        where.append("s.customer_id = ?")
        params.append(customer_id)
    if payment_mode:
        where.append("s.payment_mode = ?")
        params.append(payment_mode)
    if not include_void:
        where.append("s.status = 'active'")
    order = "s.sale_date DESC, s.id DESC" if newest_first else "s.sale_date ASC, s.id ASC"
    sql = (f"SELECT {_SALE_COLS} FROM sales s LEFT JOIN customers c ON c.id = s.customer_id "
           f"WHERE {' AND '.join(where)} ORDER BY {order}")
    if limit:
        sql += " LIMIT ?"
        params.append(int(limit))
    return db.query_all(sql, params)


def items_for_sales(sale_ids: list[int]) -> list[dict]:
    """All items of many sales in ONE query (no N+1)."""
    if not sale_ids:
        return []
    out: list[dict] = []
    ids = list(sale_ids)
    for i in range(0, len(ids), 500):  # stay well below SQLite's variable limit
        chunk = ids[i:i + 500]
        out.extend(db.query_all(
            f"SELECT * FROM sale_items WHERE sale_id IN ({','.join('?' * len(chunk))}) ORDER BY sale_id, id",
            chunk,
        ))
    return out


def mark_void(sale_id: int, voided_at: str, reason: str | None) -> None:
    db.execute(
        "UPDATE sales SET status = 'void', voided_at = ?, void_reason = ? WHERE id = ? AND status = 'active'",
        (voided_at, reason, sale_id),
    )


def add_wholesale_name(name: str, created_at: str) -> None:
    db.execute("INSERT OR IGNORE INTO wholesale_rice_names(name, created_at) VALUES (?, ?)", (name, created_at))


def wholesale_names() -> list[str]:
    return [r["name"] for r in db.query_all("SELECT name FROM wholesale_rice_names ORDER BY name COLLATE NOCASE")]

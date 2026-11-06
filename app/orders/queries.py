"""orders/queries.py - ALL SQL for pending_orders / pending_order_items (+ read-only join on customers)."""
from __future__ import annotations

from app import db

_COLS = """
    o.id, o.channel, o.customer_id, c.name AS customer_name, c.phone AS customer_phone,
    c.place AS customer_place, o.requested_for, o.call_received_on, o.notes, o.status, o.sale_id,
    o.created_by, o.created_at, o.closed_at
"""
_FROM = "FROM pending_orders o JOIN customers c ON c.id = o.customer_id"


def _in(col, values):
    if not values:
        return "0", []
    return f"{col} IN ({','.join('?' * len(values))})", list(values)


def list_orders(channels, *, status="pending", channel=None, customer_id=None, limit=200) -> list[dict]:
    clause, params = _in("o.channel", channels)
    where = [clause]
    if status != "all":
        where.append("o.status = ?")
        params.append(status)
    if channel:
        where.append("o.channel = ?")
        params.append(channel)
    if customer_id is not None:
        where.append("o.customer_id = ?")
        params.append(customer_id)
    order = "o.requested_for ASC, o.id ASC" if status == "pending" else "o.created_at DESC, o.id DESC"
    params.append(limit)
    return db.query_all(f"SELECT {_COLS} {_FROM} WHERE {' AND '.join(where)} ORDER BY {order} LIMIT ?", params)


def pending_times(channels) -> list[str]:
    clause, params = _in("channel", channels)
    return [r["requested_for"] for r in db.query_all(
        f"SELECT requested_for FROM pending_orders WHERE status = 'pending' AND {clause} ORDER BY requested_for",
        params)]


def get_order(order_id: int) -> dict | None:
    return db.query_one(f"SELECT {_COLS} {_FROM} WHERE o.id = ?", (order_id,))


def items_for_orders(order_ids: list[int]) -> list[dict]:
    if not order_ids:
        return []
    return db.query_all(
        f"SELECT * FROM pending_order_items WHERE order_id IN ({','.join('?' * len(order_ids))}) ORDER BY order_id, id",
        list(order_ids))


def insert_order(row: dict) -> int:
    return db.execute(
        """INSERT INTO pending_orders(channel, customer_id, requested_for, call_received_on, notes, status,
                                      created_by, created_at)
           VALUES (:channel, :customer_id, :requested_for, :call_received_on, :notes, 'pending',
                   :created_by, :created_at)""", row).lastrowid


def update_order(order_id: int, row: dict) -> None:
    db.execute(
        """UPDATE pending_orders SET channel = :channel, customer_id = :customer_id,
                  requested_for = :requested_for, call_received_on = :call_received_on, notes = :notes
            WHERE id = :id AND status = 'pending'""", {**row, "id": order_id})


def replace_items(order_id: int, items: list[dict]) -> None:
    db.execute("DELETE FROM pending_order_items WHERE order_id = ?", (order_id,))
    for it in items:
        db.execute(
            """INSERT INTO pending_order_items(order_id, rice_type, item_kind, grams, bags, bag_size_grams, unit_price)
               VALUES (?,?,?,?,?,?,?)""",
            (order_id, it["rice_type"], it["item_kind"], it["grams"], it["bags"], it["bag_size_grams"],
             it["unit_price"]))


def close_order(order_id: int, status: str, closed_at: str, sale_id: int | None = None) -> None:
    db.execute("UPDATE pending_orders SET status = ?, closed_at = ?, sale_id = ? WHERE id = ? AND status = 'pending'",
               (status, closed_at, sale_id, order_id))

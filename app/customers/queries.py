"""
customers/queries.py - ALL SQL for the `customers` table. No business rules.
"""
from __future__ import annotations

from typing import Sequence

from app import db

_COLS = "id, name, phone, place, notes, is_active, created_at"


def _like(q: str) -> str:
    return "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def list_customers(q: str | None, include_inactive: bool) -> list[dict]:
    sql, params = f"SELECT {_COLS} FROM customers WHERE 1=1", []
    if not include_inactive:
        sql += " AND is_active = 1"
    if q:
        sql += " AND (name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR place LIKE ? ESCAPE '\\')"
        params += [_like(q)] * 3
    return db.query_all(sql + " ORDER BY name COLLATE NOCASE", params)


def get_by_id(customer_id: int) -> dict | None:
    return db.query_one(f"SELECT {_COLS} FROM customers WHERE id = ?", (customer_id,))


def get_by_name(name: str) -> dict | None:
    """Case-insensitive (the column is COLLATE NOCASE)."""
    return db.query_one(f"SELECT {_COLS} FROM customers WHERE name = ?", (name,))


def names_for_ids(ids: Sequence[int]) -> dict[int, str]:
    ids = list({int(i) for i in ids})
    if not ids:
        return {}
    marks = ",".join("?" * len(ids))
    rows = db.query_all(f"SELECT id, name FROM customers WHERE id IN ({marks})", ids)
    return {r["id"]: r["name"] for r in rows}


def insert(name: str, phone: str | None, place: str | None, notes: str | None,
           created_at: str, created_by: str | None) -> int:
    cur = db.execute(
        "INSERT INTO customers(name, phone, place, notes, is_active, created_at, created_by)"
        " VALUES (?,?,?,?,1,?,?)",
        (name, phone, place, notes, created_at, created_by),
    )
    return cur.lastrowid


def update(customer_id: int, name: str, phone: str | None, place: str | None, notes: str | None,
           is_active: bool) -> None:
    db.execute(
        "UPDATE customers SET name = ?, phone = ?, place = ?, notes = ?, is_active = ? WHERE id = ?",
        (name, phone, place, notes, 1 if is_active else 0, customer_id),
    )

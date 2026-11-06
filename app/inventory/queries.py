"""
inventory/queries.py - ALL SQL for `rice_types` and `stock_movements`. No business rules.
"""
from __future__ import annotations

from app import db

_COLS = ("type_name, price_per_kg, bag_price, bag_size_grams, purchase_cost_per_kg, bags_qty, "
         "loose_grams, low_stock_bags, is_active, updated_at, updated_by")
_MOVE_COLS = ("id, type_name, moved_at, kind, delta_bags, delta_loose_grams, bags_after, loose_after, "
              "sale_id, note, created_by")

# Columns update_rice_type() may touch (keeps the dynamic SET clause safe).
_UPDATABLE = {"price_per_kg", "bag_price", "bag_size_grams", "purchase_cost_per_kg", "bags_qty",
              "loose_grams", "low_stock_bags", "is_active"}


def list_rice_types(include_inactive: bool) -> list[dict]:
    where = "" if include_inactive else " WHERE is_active = 1"
    return db.query_all(f"SELECT {_COLS} FROM rice_types{where} ORDER BY type_name COLLATE NOCASE")


def get_rice_type(type_name: str) -> dict | None:
    """Case-insensitive (the key is COLLATE NOCASE)."""
    return db.query_one(f"SELECT {_COLS} FROM rice_types WHERE type_name = ?", (type_name,))


def insert_rice_type(type_name: str, price_per_kg: float, bag_price: float | None,
                     bag_size_grams: int | None, purchase_cost_per_kg: float | None, bags_qty: int,
                     loose_grams: int, low_stock_bags: int, updated_at: str, updated_by: str | None) -> None:
    db.execute(
        "INSERT INTO rice_types(type_name, price_per_kg, bag_price, bag_size_grams, purchase_cost_per_kg,"
        " bags_qty, loose_grams, low_stock_bags, is_active, updated_at, updated_by)"
        " VALUES (?,?,?,?,?,?,?,?,1,?,?)",
        (type_name, price_per_kg, bag_price, bag_size_grams, purchase_cost_per_kg, bags_qty,
         loose_grams, low_stock_bags, updated_at, updated_by),
    )


def update_rice_type(type_name: str, fields: dict, updated_at: str, updated_by: str | None) -> None:
    bad = set(fields) - _UPDATABLE
    if bad:
        raise KeyError(f"not updatable: {sorted(bad)}")
    sets = ", ".join(f"{k} = ?" for k in fields) + (", " if fields else "") + "updated_at = ?, updated_by = ?"
    values = [int(v) if k == "is_active" else v for k, v in fields.items()]
    db.execute(f"UPDATE rice_types SET {sets} WHERE type_name = ?", [*values, updated_at, updated_by, type_name])


def list_low_stock() -> list[dict]:
    return db.query_all(
        f"SELECT {_COLS} FROM rice_types WHERE is_active = 1 AND low_stock_bags > 0"
        " AND bags_qty <= low_stock_bags ORDER BY type_name COLLATE NOCASE")


def insert_movement(type_name: str, moved_at: str, kind: str, delta_bags: int, delta_loose_grams: int,
                    bags_after: int, loose_after: int, sale_id: int | None, note: str | None,
                    created_by: str | None) -> int:
    cur = db.execute(
        "INSERT INTO stock_movements(type_name, moved_at, kind, delta_bags, delta_loose_grams,"
        " bags_after, loose_after, sale_id, note, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (type_name, moved_at, kind, delta_bags, delta_loose_grams, bags_after, loose_after,
         sale_id, note, created_by),
    )
    return cur.lastrowid


def list_movements(type_name: str | None, limit: int) -> list[dict]:
    sql, params = f"SELECT {_MOVE_COLS} FROM stock_movements", []
    if type_name:
        sql += " WHERE type_name = ?"
        params.append(type_name)
    return db.query_all(sql + " ORDER BY id DESC LIMIT ?", [*params, limit])


def movements_for_sale(sale_id: int) -> list[dict]:
    return db.query_all(
        f"SELECT {_MOVE_COLS} FROM stock_movements WHERE sale_id = ? ORDER BY id", (sale_id,))

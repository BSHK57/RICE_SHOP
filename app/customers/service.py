"""
customers/service.py - the customer book: validation, duplicate rules, lookups for other modules.

Other modules import: get_customer, customer_names, require_customer.
Purchase history and credit figures come from sales/credits services, imported lazily so this
module has no import cycle (and works before those modules exist).
"""
from __future__ import annotations

import sqlite3
from typing import Iterable

from app import db
from app.auth.permissions import User, can
from app.customers import queries
from app.utils.common import ApiError, opt_str, req_str


def _clean(row: dict | None) -> dict | None:
    if row is not None:
        row["is_active"] = bool(row["is_active"])
    return row


# --------------------------- lookups for other modules --------------------------- #
def get_customer(customer_id: int) -> dict | None:
    return _clean(queries.get_by_id(customer_id))


def customer_names(ids: Iterable[int]) -> dict[int, str]:
    return queries.names_for_ids([i for i in ids if i is not None])


def require_customer(customer_id: int) -> dict:
    """The active customer, or ApiError 404 (used by sales/credits/orders before saving)."""
    c = get_customer(customer_id) if customer_id is not None else None
    if c is None or not c["is_active"]:
        raise ApiError("Customer not found.", 404, "not_found")
    return c


# ---------------------------------- API logic ---------------------------------- #
def _credit_balances() -> dict[int, int] | None:
    """{customer_id: balance} for users who may see credits; None when not allowed/available."""
    if not can("credits:view"):
        return None
    try:
        from app.credits import service as credits_service
    except ImportError:
        return None
    return credits_service.balances_by_customer()


def list_customers(q: str | None, include_inactive: bool) -> list[dict]:
    rows = [_clean(r) for r in queries.list_customers((q or "").strip() or None, include_inactive)]
    balances = _credit_balances()
    if balances is not None:
        for r in rows:
            r["credit_balance"] = int(balances.get(r["id"], 0))
    return rows


def _duplicate(existing: dict) -> ApiError:
    return ApiError(f"Customer '{existing['name']}' already exists.", 409, "duplicate")


def create_customer(payload: dict, user: User) -> dict:
    name = req_str(payload, "name", "Name", 80)
    phone, place, notes = opt_str(payload, "phone", 30), opt_str(payload, "place", 80), opt_str(payload, "notes", 500)
    with db.transaction():
        existing = queries.get_by_name(name)
        if existing:
            raise _duplicate(existing)
        try:
            cid = queries.insert(name, phone, place, notes, db.now_str(), user.username)
        except sqlite3.IntegrityError:
            raise ApiError(f"Customer '{name}' already exists.", 409, "duplicate")
        db.audit(user.username, "customer.create", "customer", cid, {"name": name})
    return get_customer(cid)


def update_customer(customer_id: int, payload: dict, user: User) -> dict:
    """Partial update: only the keys present in the payload change."""
    cur = get_customer(customer_id)
    if cur is None:
        raise ApiError("Customer not found.", 404, "not_found")
    name = req_str(payload, "name", "Name", 80) if "name" in payload else cur["name"]
    phone = opt_str(payload, "phone", 30) if "phone" in payload else cur["phone"]
    place = opt_str(payload, "place", 80) if "place" in payload else cur["place"]
    notes = opt_str(payload, "notes", 500) if "notes" in payload else cur["notes"]
    active = cur["is_active"]
    if "is_active" in payload:
        if not isinstance(payload["is_active"], bool):
            raise ApiError("is_active must be true or false.")
        active = payload["is_active"]
    with db.transaction():
        other = queries.get_by_name(name)
        if other and other["id"] != customer_id:
            raise _duplicate(other)
        queries.update(customer_id, name, phone, place, notes, active)
        db.audit(user.username, "customer.update", "customer", customer_id,
                 {"name": name, "is_active": active})
    return get_customer(customer_id)


def customer_detail(customer_id: int) -> dict:
    customer = get_customer(customer_id)
    if customer is None:
        raise ApiError("Customer not found.", 404, "not_found")
    # Sibling modules are imported lazily (no cycle) and may not be present yet.
    purchases: list = []
    try:
        from app.sales import service as sales_service
        purchases = sales_service.customer_purchases(customer_id, limit=50)
    except ImportError:
        purchases = []
    credit = None
    if can("credits:view"):
        try:
            from app.credits import service as credits_service
            credit = credits_service.customer_summary(customer_id)
        except ImportError:
            credit = None
    return {"customer": customer, "purchases": purchases, "credit": credit}

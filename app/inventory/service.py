"""
inventory/service.py - retail stock: rice types, receiving/adjusting/opening bags, and the
functions the sales module calls (deduct_for_sale / restore_for_sale / check_availability).

Rules
  * All stock arithmetic comes from app/utils/calc.py (plan_loose_deduction, plan_bag_deduction, open_bags).
  * Every stock change runs in db.transaction() and writes a stock_movements row with the
    resulting bags_after / loose_after. The sale-related functions are meant to be called inside
    the caller's transaction (nested use joins it).
  * `purchase_cost_per_kg` is only shown to users with original:view or inventory:edit (see serialize()).
"""
from __future__ import annotations

from flask import has_request_context

from app import db
from app.auth.permissions import User, can
from app.inventory import queries
from app.utils import calc
from app.utils.calc import StockError
from app.utils.common import ApiError, opt_str, req_str, to_int, to_price

ITEM_KINDS = ("loose", "bag")


# ------------------------------- helpers ------------------------------------ #
def _uname(user: User | str | None) -> str | None:
    return user if isinstance(user, str) or user is None else user.username


def _clean(row: dict | None) -> dict | None:
    if row is not None:
        row["is_active"] = bool(row["is_active"])
    return row


def _can_see_cost() -> bool:
    return has_request_context() and (can("original:view") or can("inventory:edit"))


def serialize(rt: dict) -> dict:
    """RiceType for the API; purchase cost omitted unless the current user may see it."""
    out = dict(rt)
    if not _can_see_cost():
        out.pop("purchase_cost_per_kg", None)
    return out


def get_rice_type(name: str, for_update: bool = False) -> dict | None:
    """Raw row (includes purchase cost) for other modules, or None. `for_update` is accepted for
    clarity: callers inside db.transaction() already hold SQLite's write lock (BEGIN IMMEDIATE)."""
    return _clean(queries.get_rice_type(name)) if isinstance(name, str) and name.strip() else None


def _require(name: str) -> dict:
    rt = get_rice_type(name)
    if rt is None:
        raise ApiError(f"Rice type '{name}' not found.", 404, "not_found")
    return rt


def _write_stock(rt: dict, new_bags: int, new_loose: int, kind: str, *, user, note: str | None = None,
                 sale_id: int | None = None, fields: dict | None = None) -> None:
    """Persist new stock levels (+ optional field changes) and log ONE movement for the net change."""
    now, who = db.now_str(), _uname(user)
    queries.update_rice_type(rt["type_name"], {**(fields or {}), "bags_qty": new_bags, "loose_grams": new_loose},
                             now, who)
    queries.insert_movement(rt["type_name"], now, kind, new_bags - rt["bags_qty"], new_loose - rt["loose_grams"],
                            new_bags, new_loose, sale_id, note, who)


def _check_bag_fields(bag_price: float | None, bag_size: int | None, bags_qty: int) -> None:
    if bag_size is None and bag_price is not None:
        raise ApiError("A bag price needs a bag size.")
    if bag_size is None and bags_qty > 0:
        raise ApiError("Bags in stock need a bag size.")


# ------------------------------ read API ------------------------------------ #
def list_rice_types(include_inactive: bool = False) -> list[dict]:
    return [serialize(_clean(r)) for r in queries.list_rice_types(include_inactive)]


def low_stock_list() -> list[dict]:
    """Active types with bags_qty <= low_stock_bags (and a threshold set), serialized."""
    return [serialize(_clean(r)) for r in queries.list_low_stock()]


def list_movements(type_name: str | None, limit: int) -> list[dict]:
    canonical = None
    if type_name:
        rt = get_rice_type(type_name)
        canonical = rt["type_name"] if rt else type_name
    return queries.list_movements(canonical, limit)


# ------------------------------ write API ----------------------------------- #
def create_rice_type(payload: dict, user: User) -> dict:
    name = req_str(payload, "type_name", "Type name", 60)
    price = to_price(payload.get("price_per_kg"), "Price per kg")
    bag_price = to_price(payload.get("bag_price"), "Bag price", required=False)
    bag_size = to_int(payload.get("bag_size_grams"), "Bag size", 1, required=False)
    cost = to_price(payload.get("purchase_cost_per_kg"), "Purchase cost per kg", required=False)
    bags = to_int(payload.get("bags_qty"), "Bags", 0, required=False) or 0
    loose = to_int(payload.get("loose_grams"), "Loose grams", 0, required=False) or 0
    low = to_int(payload.get("low_stock_bags"), "Low stock bags", 0, required=False) or 0
    _check_bag_fields(bag_price, bag_size, bags)
    with db.transaction():
        existing = queries.get_rice_type(name)
        if existing:
            raise ApiError(f"Rice type '{existing['type_name']}' already exists.", 409, "duplicate")
        now = db.now_str()
        queries.insert_rice_type(name, price, bag_price, bag_size, cost, bags, loose, low, now, user.username)
        queries.insert_movement(name, now, "create", bags, loose, bags, loose, None, "Rice type created",
                                user.username)
        db.audit(user.username, "inventory.create", "rice_type", name,
                 {"price_per_kg": price, "bag_price": bag_price, "bag_size_grams": bag_size,
                  "bags_qty": bags, "loose_grams": loose})
    return serialize(get_rice_type(name))


def update_rice_type(name: str, payload: dict, user: User) -> dict:
    """Prices / bag size / low-stock threshold / active flag. Never touches stock quantities."""
    fields: dict = {}
    if "price_per_kg" in payload:
        fields["price_per_kg"] = to_price(payload["price_per_kg"], "Price per kg")
    if "bag_price" in payload:
        fields["bag_price"] = to_price(payload["bag_price"], "Bag price", required=False)
    if "bag_size_grams" in payload:
        fields["bag_size_grams"] = to_int(payload["bag_size_grams"], "Bag size", 1, required=False)
    if "purchase_cost_per_kg" in payload:
        fields["purchase_cost_per_kg"] = to_price(payload["purchase_cost_per_kg"], "Purchase cost per kg",
                                                   required=False)
    if "low_stock_bags" in payload:
        fields["low_stock_bags"] = to_int(payload["low_stock_bags"], "Low stock bags", 0)
    if "is_active" in payload:
        if not isinstance(payload["is_active"], bool):
            raise ApiError("is_active must be true or false.")
        fields["is_active"] = payload["is_active"]
    if not fields:
        raise ApiError("Nothing to update.")
    with db.transaction():
        rt = _require(name)
        merged = {**rt, **fields}
        if "bag_size_grams" in fields and fields["bag_size_grams"] != rt["bag_size_grams"] and rt["bags_qty"] > 0:
            raise ApiError("Bags are in stock with the current bag size. Sell them or adjust stock first, "
                           "or add a new rice type for the new bag size.", 409, "bag_size_conflict")
        _check_bag_fields(merged["bag_price"], merged["bag_size_grams"], rt["bags_qty"])
        queries.update_rice_type(rt["type_name"], fields, db.now_str(), user.username)
        db.audit(user.username, "inventory.update", "rice_type", rt["type_name"], fields)
        return serialize(get_rice_type(name))


def receive_stock(name: str, payload: dict, user: User) -> dict:
    bags = to_int(payload.get("bags"), "Bags", 0, required=False) or 0
    loose = to_int(payload.get("loose_grams"), "Loose grams", 0, required=False) or 0
    if bags == 0 and loose == 0:
        raise ApiError("Enter the bags or loose quantity received.")
    size = to_int(payload.get("bag_size_grams"), "Bag size", 1, required=False)
    price = to_price(payload.get("price_per_kg"), "Price per kg", required=False)
    bag_price = to_price(payload.get("bag_price"), "Bag price", required=False)
    cost = to_price(payload.get("purchase_cost_per_kg"), "Purchase cost per kg", required=False)
    note = opt_str(payload, "note", 200)
    with db.transaction():
        rt = _require(name)
        fields: dict = {}
        if size is not None and size != rt["bag_size_grams"]:
            if rt["bags_qty"] > 0:
                raise ApiError("This type already has bags of a different size in stock. Sell them or adjust "
                               "stock first, or receive this under a new rice type name.", 409, "bag_size_conflict")
            fields["bag_size_grams"] = size
        for key, val in (("price_per_kg", price), ("bag_price", bag_price), ("purchase_cost_per_kg", cost)):
            if val is not None:
                fields[key] = val
        merged = {**rt, **fields}
        if bags > 0 and not merged["bag_size_grams"]:
            raise ApiError("Enter the bag size for the bags received.")
        _check_bag_fields(merged["bag_price"], merged["bag_size_grams"], rt["bags_qty"] + bags)
        _write_stock(rt, rt["bags_qty"] + bags, rt["loose_grams"] + loose, "receive", user=user, note=note,
                     fields=fields)
        db.audit(user.username, "inventory.receive", "rice_type", rt["type_name"],
                 {"bags": bags, "loose_grams": loose, "note": note, **fields})
        return serialize(get_rice_type(name))


def adjust_stock(name: str, payload: dict, user: User) -> dict:
    d_bags = to_int(payload.get("bags_delta"), "Bags change", None, required=False) or 0
    d_loose = to_int(payload.get("loose_grams_delta"), "Loose change", None, required=False) or 0
    note = req_str(payload, "note", "Note", 200)
    if d_bags == 0 and d_loose == 0:
        raise ApiError("Enter a bags or loose change.")
    with db.transaction():
        rt = _require(name)
        new_bags, new_loose = rt["bags_qty"] + d_bags, rt["loose_grams"] + d_loose
        if new_bags < 0 or new_loose < 0:
            raise StockError(f"Stock cannot go below zero (would leave {new_bags} bags, "
                             f"{calc.format_kg(new_loose)} loose).")
        if d_bags > 0 and not rt["bag_size_grams"]:
            raise ApiError("Set the bag size for this rice type before adding bags.")
        _write_stock(rt, new_bags, new_loose, "adjust", user=user, note=note)
        db.audit(user.username, "inventory.adjust", "rice_type", rt["type_name"],
                 {"bags_delta": d_bags, "loose_grams_delta": d_loose, "note": note})
        return serialize(get_rice_type(name))


def open_bag(name: str, payload: dict, user: User) -> dict:
    count = to_int(payload.get("count"), "Count", 1, required=False) or 1
    with db.transaction():
        rt = _require(name)
        plan = calc.open_bags(rt["bags_qty"], rt["loose_grams"], rt["bag_size_grams"], count)
        _write_stock(rt, plan["new_bags"], plan["new_loose"], "open_bag", user=user, note=f"Opened {count} bag(s)")
        db.audit(user.username, "inventory.open_bag", "rice_type", rt["type_name"], {"count": count})
        return serialize(get_rice_type(name))


# ------------------------- functions the sales module calls ------------------------- #
def _plan(rt: dict, item_kind: str, grams: int, bags: int) -> dict:
    """Pure stock plan for a line -> {new_bags, new_loose, bags_opened}; raises StockError."""
    if item_kind == "loose":
        return calc.plan_loose_deduction(rt["bags_qty"], rt["loose_grams"], rt["bag_size_grams"], grams)
    if item_kind == "bag":
        plan = calc.plan_bag_deduction(rt["bags_qty"], bags)
        return {"new_bags": plan["new_bags"], "new_loose": rt["loose_grams"], "bags_opened": 0}
    raise ApiError("item_kind must be 'loose' or 'bag'.")


def check_availability(type_name: str, item_kind: str, grams: int, bags: int) -> dict:
    """Read-only: can this line be served? -> {ok, message, bags_opened}."""
    rt = get_rice_type(type_name)
    if rt is None:
        return {"ok": False, "message": f"Rice type '{type_name}' not found.", "bags_opened": 0}
    try:
        plan = _plan(rt, item_kind, grams, bags)
    except StockError as exc:
        return {"ok": False, "message": str(exc), "bags_opened": 0}
    return {"ok": True, "message": "", "bags_opened": plan["bags_opened"]}


def deduct_for_sale(type_name: str, item_kind: str, grams: int, bags: int, sale_id: int,
                    user: User | str | None) -> dict:
    """
    Take stock for one sale line (call inside the sale's transaction). A loose line that needs
    bags opened logs TWO movements, both carrying sale_id: `open_bag` then `sale`.
    Raises StockError when stock is insufficient. -> {type_name, bags_opened, bags_after, loose_after}
    """
    with db.transaction():
        rt = _require(type_name)
        plan = _plan(rt, item_kind, grams, bags)
        now, who, name = db.now_str(), _uname(user), rt["type_name"]
        bags_now, loose_now = rt["bags_qty"], rt["loose_grams"]
        if plan["bags_opened"]:
            opened = plan["bags_opened"]
            bags_now -= opened
            loose_now += opened * rt["bag_size_grams"]
            queries.insert_movement(name, now, "open_bag", -opened, opened * rt["bag_size_grams"],
                                    bags_now, loose_now, sale_id, f"Opened {opened} bag(s) for sale", who)
        if item_kind == "loose":
            queries.insert_movement(name, now, "sale", 0, -grams, plan["new_bags"], plan["new_loose"],
                                    sale_id, None, who)
        else:
            queries.insert_movement(name, now, "sale", -bags, 0, plan["new_bags"], plan["new_loose"],
                                    sale_id, None, who)
        queries.update_rice_type(name, {"bags_qty": plan["new_bags"], "loose_grams": plan["new_loose"]}, now, who)
    return {"type_name": name, "bags_opened": plan["bags_opened"],
            "bags_after": plan["new_bags"], "loose_after": plan["new_loose"]}


def restore_for_sale(sale_id: int, user: User | str | None) -> None:
    """
    Undo a sale's stock effect: per rice type, reverse the net of its `sale` and `open_bag`
    movements with a single `sale_void` movement (same sale_id). Idempotent.
    Edge case: if the exact reversal would make loose stock negative (the loose rice from an
    opened bag has since been sold), only the sold quantity is put back as loose rice.
    """
    moves = queries.movements_for_sale(sale_id)
    if any(m["kind"] == "sale_void" for m in moves):
        return
    per_type: dict[str, dict[str, list[int]]] = {}
    for m in moves:
        if m["kind"] in ("sale", "open_bag"):
            acc = per_type.setdefault(m["type_name"], {"all": [0, 0], "sale": [0, 0]})
            for key in (("all", "sale") if m["kind"] == "sale" else ("all",)):
                acc[key][0] += m["delta_bags"]
                acc[key][1] += m["delta_loose_grams"]
    if not per_type:
        return
    with db.transaction():
        now, who = db.now_str(), _uname(user)
        for type_name, acc in per_type.items():
            rt = _require(type_name)
            d_bags, d_loose = (-acc["all"][0], -acc["all"][1])
            if rt["loose_grams"] + d_loose < 0 or rt["bags_qty"] + d_bags < 0:
                d_bags, d_loose = (-acc["sale"][0], -acc["sale"][1])
            new_bags, new_loose = rt["bags_qty"] + d_bags, rt["loose_grams"] + d_loose
            queries.update_rice_type(rt["type_name"], {"bags_qty": new_bags, "loose_grams": new_loose}, now, who)
            queries.insert_movement(rt["type_name"], now, "sale_void", d_bags, d_loose, new_bags, new_loose,
                                    sale_id, "Sale cancelled - stock restored", who)

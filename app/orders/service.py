"""
orders/service.py - reminders / pending deliveries and "mark as sent".

A pending order changes nothing in stock or sales. Fulfilling it creates the sale through
sales.service.create_sale dated on the sent date (retail stock is deducted at that moment), all in
one transaction with the order status change.

Channel visibility: retail orders need `retail:view`, wholesale orders `wholesale:view`.
"""
from __future__ import annotations

from app import db
from app.auth.permissions import current_user
from app.orders import queries as q
from app.utils import calc
from app.utils.common import ApiError, one_of, opt_str, req_date, req_datetime, req_str, to_int, to_price

CHANNELS = ("retail", "wholesale")
STATUSES = ("pending", "sent", "cancelled", "all")
MAX_ITEMS = 50


def _uname(user):
    return getattr(user, "username", user)


def visible_channels(user=None) -> list[str]:
    u = user if user is not None else current_user()
    return [c for c in CHANNELS if u and u.can(f"{c}:view")]


def _require_channel(user, channel: str) -> None:
    if channel not in visible_channels(user):
        raise ApiError("You do not have access to this.", 403, "forbidden")


def _label(it: dict) -> str:
    if it["item_kind"] == "bag":
        size = f" × {calc.format_kg(it['bag_size_grams'])}" if it.get("bag_size_grams") else ""
        return f"{it['bags']} bag{'s' if it['bags'] != 1 else ''}{size}"
    return calc.format_kg(it["grams"])


def _serialize(orders: list[dict]) -> list[dict]:
    u = current_user()
    exact = bool(u and u.can("original:view"))   # masking rule: agreed (maybe discounted) prices are "exact" data
    by_order: dict[int, list] = {}
    for it in q.items_for_orders([o["id"] for o in orders]):
        by_order.setdefault(it["order_id"], []).append({
            "id": it["id"], "rice_type": it["rice_type"], "item_kind": it["item_kind"], "grams": it["grams"],
            "bags": it["bags"], "bag_size_grams": it["bag_size_grams"],
            "unit_price": it["unit_price"] if exact else None,
            "quantity_label": _label(it)})
    out = []
    for o in orders:
        d = dict(o)
        d["overdue"] = o["status"] == "pending" and calc.is_order_overdue(o["requested_for"])
        d["items"] = by_order.get(o["id"], [])
        out.append(d)
    return out


def _load(order_id: int, user) -> dict:
    o = q.get_order(order_id)
    if not o or o["channel"] not in visible_channels(user):
        raise ApiError("Order not found.", 404, "not_found")
    return o


def get_order(order_id: int, user=None) -> dict:
    return _serialize([_load(order_id, user if user is not None else current_user())])[0]


# ---------------------------------- reads ---------------------------------- #
def summary(user=None) -> dict:
    times = q.pending_times(visible_channels(user))
    overdue = [t for t in times if calc.is_order_overdue(t)]
    upcoming = [t for t in times if not calc.is_order_overdue(t)]
    return {"pending": len(times), "overdue": len(overdue), "next_due": upcoming[0] if upcoming else None}


def list_orders(args, user=None) -> list[dict]:
    status = one_of(args.get("status") or "pending", STATUSES, "status")
    channel = one_of(args.get("channel"), CHANNELS, "channel") if args.get("channel") else None
    cust = to_int(args.get("customer_id"), "customer_id", minimum=1, required=False)
    return _serialize(q.list_orders(visible_channels(user), status=status, channel=channel, customer_id=cust))


# ------------------------------- validation -------------------------------- #
def _items(channel: str, raw_items) -> list[dict]:
    if not isinstance(raw_items, list) or not raw_items:
        raise ApiError("Add at least one item.")
    if len(raw_items) > MAX_ITEMS:
        raise ApiError(f"Too many items (max {MAX_ITEMS}).")
    from app.inventory import service as inv
    out = []
    for i, raw in enumerate(raw_items, 1):
        label = f"Item {i}"
        if not isinstance(raw, dict):
            raise ApiError(f"{label} is not valid.")
        name = req_str(raw, "rice_type", f"{label}: rice type", 100)
        kind = one_of(raw.get("item_kind"), ("loose", "bag"), f"{label}: kind")
        price = to_price(raw.get("unit_price"), f"{label}: price", required=False)
        size = to_int(raw.get("bag_size_grams"), f"{label}: bag size", minimum=1, required=False)
        if channel == "retail":
            rt = inv.get_rice_type(name)
            if not rt or not rt.get("is_active", 1):
                raise ApiError(f"{label}: rice type '{name}' does not exist.")
            name = rt["type_name"]
            if kind == "bag":
                size = rt.get("bag_size_grams")  # retail bags are always the stocked size
                if not size:
                    raise ApiError(f"{label}: '{name}' has no bag size set; order it loose.")
        grams = bags = 0
        if kind == "bag":
            bags = to_int(raw.get("bags"), f"{label}: bags", minimum=1)
            if not size:
                raise ApiError(f"{label}: bag size is required.")
        else:
            grams = to_int(raw.get("grams"), f"{label}: quantity (grams)", minimum=1)
            size = None
        out.append({"rice_type": name, "item_kind": kind, "grams": grams, "bags": bags,
                    "bag_size_grams": size, "unit_price": price})
    return out


def _validate(body: dict, user) -> tuple[dict, list[dict]]:
    from app.customers import service as customers
    channel = one_of(body.get("channel"), CHANNELS, "Channel")
    _require_channel(user, channel)
    customer_id = to_int(body.get("customer_id"), "Customer", minimum=1)
    customers.require_customer(customer_id)
    row = {
        "channel": channel, "customer_id": customer_id,
        "requested_for": req_datetime(body.get("requested_for"), "Wanted on (date & time)"),
        "call_received_on": req_date(body.get("call_received_on"), "Call received on", required=False),
        "notes": opt_str(body, "notes", 500),
    }
    return row, _items(channel, body.get("items"))


# ---------------------------------- writes ---------------------------------- #
def create_order(body: dict, user) -> dict:
    row, items = _validate(body, user)
    with db.transaction():
        oid = q.insert_order({**row, "created_by": _uname(user), "created_at": db.now_str()})
        q.replace_items(oid, items)
        db.audit(_uname(user), "create", "order", oid, {"channel": row["channel"], "items": len(items)})
    return get_order(oid, user)


def _load_pending(order_id: int, user) -> dict:
    o = _load(order_id, user)
    if o["status"] != "pending":
        raise ApiError(f"This order is already {o['status']}.", 409, "not_pending")
    return o


def update_order(order_id: int, body: dict, user) -> dict:
    row, items = _validate(body, user)
    with db.transaction():
        _load_pending(order_id, user)
        q.update_order(order_id, row)
        q.replace_items(order_id, items)
        db.audit(_uname(user), "update", "order", order_id, {"items": len(items)})
    return get_order(order_id, user)


def cancel_order(order_id: int, user) -> dict:
    with db.transaction():
        _load_pending(order_id, user)
        q.close_order(order_id, "cancelled", db.now_str())
        db.audit(_uname(user), "cancel", "order", order_id)
    return get_order(order_id, user)


def fulfill_order(order_id: int, body: dict, user) -> dict:
    """Mark as sent: create the sale on `sent_date` and close the order, atomically."""
    from app.sales import service as sales
    sent_date = req_date(body.get("sent_date"), "Sent date", required=False) or db.today_str()
    mode = one_of(body.get("payment_mode"), ("cash", "upi", "credit"), "Payment mode")
    credit_amount = None
    if mode == "credit":
        # blank = the whole total is credit; otherwise advance = total - credit_amount (done in sales)
        credit_amount = to_int(body.get("credit_amount"), "Credit amount", minimum=1, required=False)
    prices = body.get("item_prices") or {}
    if not isinstance(prices, dict):
        raise ApiError("item_prices must be an object.")

    with db.transaction():
        order = _serialize([_load_pending(order_id, user)])[0]
        items = []
        for it in order["items"]:
            given = prices.get(str(it["id"]), prices.get(it["id"]))
            price = to_price(given, f"Price for {it['rice_type']}", required=False)
            if price is None:
                price = it["unit_price"]
            if price is None and order["channel"] == "wholesale":
                raise ApiError(f"Enter a price for {it['rice_type']} ({it['quantity_label']}).")
            items.append({"rice_type": it["rice_type"], "item_kind": it["item_kind"], "grams": it["grams"],
                          "bags": it["bags"], "bag_size_grams": it["bag_size_grams"], "unit_price": price})
        payload = {
            "customer_id": order["customer_id"], "payment_mode": mode,
            "due_date": body.get("due_date") if mode == "credit" else None,
            "notes": opt_str(body, "notes", 500) or order["notes"], "items": items,
        }
        if order["channel"] == "retail":
            payload["sale_date"] = sent_date
        else:
            payload["sent_on"] = sent_date
            payload["call_received_on"] = order["call_received_on"]
        sale = sales.create_sale(order["channel"], payload, user, source_order_id=order_id,
                                 credit_amount=credit_amount)
        q.close_order(order_id, "sent", db.now_str(), sale["id"])
        db.audit(_uname(user), "fulfill", "order", order_id, {"sale_id": sale["id"], "sent_date": sent_date})
    return {"order": get_order(order_id, user), "sale": sale}

"""
sales/service.py - retail + wholesale sales: validation, pricing, stock/credit side effects, and the
ONE serializer every module uses to show a sale.

Masking rule (DESIGN §2): `exact = user.can('original:view')`. A masked view shows the STANDARD
(list) amount as `amount`/`unit_price`/`total_amount` and omits list_*, discount, cost and profit,
so a discount given to a customer is never revealed to staff.

All money is recomputed here from quantities and unit prices via app.utils.calc - client-supplied
amounts are never trusted.
"""
from __future__ import annotations

from datetime import date, timedelta

from app import db
from app.auth.permissions import current_user
from app.sales import queries as q
from app.utils import calc
from app.utils.calc import StockError
from app.utils.common import ApiError, one_of, opt_str, req_date, req_str, to_int, to_price

CHANNELS = ("retail", "wholesale")
MODES = ("cash", "upi", "credit")
KINDS = ("loose", "bag")
MAX_ITEMS = 50


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #
def _inv():
    from app.inventory import service as inv  # lazy: avoids import cycles between features
    return inv


def _uname(user) -> str | None:
    return getattr(user, "username", user)


def is_exact(user=None) -> bool:
    u = user if user is not None else current_user()
    return bool(u and u.can("original:view"))


def visible_channels(user=None) -> list[str]:
    u = user if user is not None else current_user()
    if not u:
        return []
    return [ch for ch in CHANNELS if u.can(f"{ch}:view")]


def days_ago(n: int) -> str:
    return (date.today() - timedelta(days=n)).isoformat()


def quantity_label(item: dict) -> str:
    if item["item_kind"] == "bag":
        n = item["bags"]
        size = f" × {calc.format_kg(item['bag_size_grams'])}" if item.get("bag_size_grams") else ""
        return f"{n} bag{'s' if n != 1 else ''}{size}"
    return calc.format_kg(item["grams"])


# --------------------------------------------------------------------------- #
# serializer (the ONLY place sale amounts are turned into API output)
# --------------------------------------------------------------------------- #
def serialize_line(sale: dict, item: dict, exact: bool) -> dict:
    line = {
        "sale_id": sale["id"], "item_id": item["id"], "channel": sale["channel"],
        "sale_date": sale["sale_date"], "created_at": sale["created_at"],
        "customer_id": sale["customer_id"], "customer_name": sale.get("customer_name"),
        "rice_type": item["rice_type"], "item_kind": item["item_kind"], "grams": item["grams"],
        "bags": item["bags"], "bag_size_grams": item["bag_size_grams"], "quantity_label": quantity_label(item),
        "payment_mode": sale["payment_mode"], "status": sale["status"], "notes": sale["notes"],
    }
    if exact:
        line.update(
            amount=item["amount"], unit_price=item["unit_price"],
            list_amount=item["list_amount"], list_unit_price=item["list_unit_price"],
            discount=calc.discount(item["list_amount"], item["amount"]),
            cost_amount=item["cost_amount"], profit=calc.profit(item["amount"], item["cost_amount"]),
        )
    else:
        # masked: standard price shown as THE price; no hint that anything else was charged
        line.update(amount=item["list_amount"], unit_price=item["list_unit_price"])
    return line


def serialize_sale(sale: dict, items: list[dict], exact: bool, credit_id: int | None = None) -> dict:
    out = {
        "id": sale["id"], "channel": sale["channel"], "sale_date": sale["sale_date"],
        "created_at": sale["created_at"], "customer_id": sale["customer_id"],
        "customer_name": sale.get("customer_name"), "payment_mode": sale["payment_mode"],
        "total_amount": sale["total_amount"] if exact else sale["list_total"],
        "paid_amount": sale["paid_amount"],
        "credit_amount": sale["total_amount"] - sale["paid_amount"],
        "call_received_on": sale["call_received_on"], "sent_on": sale["sent_on"],
        "notes": sale["notes"], "status": sale["status"], "created_by": sale["created_by"],
        "voided_at": sale.get("voided_at"), "void_reason": sale.get("void_reason"),
        "source_order_id": sale.get("source_order_id"),
        "credit_id": credit_id,
        "items": [serialize_line(sale, it, exact) for it in items],
        "view": "exact" if exact else "masked",
    }
    if not exact:
        # Masking: paid + credit must add up to the STANDARD total, otherwise staff could subtract
        # and discover the discount. Credit stays real (it is what the customer owes).
        credit = max(sale["total_amount"] - sale["paid_amount"], 0)
        out["credit_amount"] = credit
        out["paid_amount"] = max(sale["list_total"] - credit, 0)
    if exact:
        out.update(
            list_total=sale["list_total"],
            discount_total=calc.discount(sale["list_total"], sale["total_amount"]),
            cost_total=sale["cost_total"],
            profit_total=calc.profit(sale["total_amount"], sale["cost_total"]),
        )
    return out


def _serialize_many(sales: list[dict], exact: bool) -> list[dict]:
    """Serialise many sales with one items query and one credit-id query."""
    from app.credits import service as credits
    ids = [s["id"] for s in sales]
    by_sale: dict[int, list[dict]] = {}
    for it in q.items_for_sales(ids):
        by_sale.setdefault(it["sale_id"], []).append(it)
    credit_ids = credits.credit_ids_for_sales(ids)
    return [serialize_sale(s, by_sale.get(s["id"], []), exact, credit_ids.get(s["id"])) for s in sales]


def _load_sale(sale_id: int) -> dict:
    sale = q.get_sale(sale_id)
    if not sale:
        raise ApiError("Sale not found.", 404, "not_found")
    return sale


def _require_channel_view(user, channel: str) -> None:
    if not (user and user.can(f"{channel}:view")):
        raise ApiError("You do not have access to this.", 403, "forbidden")


# --------------------------------------------------------------------------- #
# line building (validation + pricing)
# --------------------------------------------------------------------------- #
def _items_list(payload: dict) -> list[dict]:
    items = payload.get("items")
    if not isinstance(items, list) or not items:
        raise ApiError("Add at least one item.")
    if len(items) > MAX_ITEMS:
        raise ApiError(f"Too many items (max {MAX_ITEMS}).")
    for i, raw in enumerate(items, 1):
        if not isinstance(raw, dict):
            raise ApiError(f"Item {i} is not valid.")
    return items


def _line(rice_type, kind, grams, bags, bag_size, list_unit, unit, cost_per_kg, auto_split=False) -> dict:
    if kind == "loose":
        list_amount, amount = calc.loose_amount(list_unit, grams), calc.loose_amount(unit, grams)
    else:
        list_amount, amount = calc.bag_amount(list_unit, bags), calc.bag_amount(unit, bags)
    return {
        "rice_type": rice_type, "item_kind": kind, "grams": grams, "bags": bags,
        "bag_size_grams": bag_size, "list_unit_price": list_unit, "unit_price": unit,
        "list_amount": list_amount, "amount": amount,
        "cost_amount": calc.purchase_cost_for_line(kind, cost_per_kg, grams, bags, bag_size),
        "auto_split": auto_split,
    }


def _retail_type(name: str, label: str) -> dict:
    rt = _inv().get_rice_type(name)
    if not rt:
        raise ApiError(f"{label}: rice type '{name}' does not exist.")
    if not rt.get("is_active", 1):
        raise ApiError(f"{label}: rice type '{rt['type_name']}' is no longer sold.")
    return rt


def build_retail_lines(payload: dict) -> list[dict]:
    lines: list[dict] = []
    for i, raw in enumerate(_items_list(payload), 1):
        label = f"Item {i}"
        rt = _retail_type(req_str(raw, "rice_type", f"{label}: rice type", 100), label)
        name, cost = rt["type_name"], rt.get("purchase_cost_per_kg")
        size, bag_price = rt.get("bag_size_grams"), rt.get("bag_price")
        kind = one_of(raw.get("item_kind"), KINDS, f"{label}: kind")
        override = to_price(raw.get("unit_price"), f"{label}: price", required=False)

        if kind == "bag":
            bags = to_int(raw.get("bags"), f"{label}: bags", minimum=1)
            if not size:
                raise ApiError(f"{label}: '{name}' has no bag size set; sell it loose.")
            if bag_price is None and override is None:
                raise ApiError(f"{label}: '{name}' is not sold in bags; enter a price per bag.")
            # no standard bag price -> the explicit price IS the list price
            list_unit = bag_price if bag_price is not None else override
            unit = override if override is not None else list_unit
            lines.append(_line(name, "bag", 0, bags, size, list_unit, unit, cost))
            continue

        grams = to_int(raw.get("grams"), f"{label}: quantity (grams)", minimum=1)
        # A loose request that reaches a full bag is a bag sale (only when the type is sold in bags).
        full_bags, rest = calc.split_loose_into_bags(grams, size) if bag_price is not None else (0, grams)
        if full_bags:
            # A per-kg override carries over to the bag part as override x bag weight.
            bag_unit = (round(calc.default_bag_price(override, size), 2) if override is not None else bag_price)
            lines.append(_line(name, "bag", 0, full_bags, size, bag_price, bag_unit, cost, auto_split=True))
        if rest:
            per_kg = override if override is not None else rt["price_per_kg"]
            lines.append(_line(name, "loose", rest, 0, None, rt["price_per_kg"], per_kg, cost,
                               auto_split=bool(full_bags)))
    return lines


def build_wholesale_lines(payload: dict) -> list[dict]:
    lines: list[dict] = []
    for i, raw in enumerate(_items_list(payload), 1):
        label = f"Item {i}"
        typed = req_str(raw, "rice_type", f"{label}: rice type", 100)
        kind = one_of(raw.get("item_kind"), KINDS, f"{label}: kind")
        unit = to_price(raw.get("unit_price"), f"{label}: price")
        rt = _inv().get_rice_type(typed)  # only for the cost snapshot and canonical spelling
        name, cost = (rt["type_name"], rt.get("purchase_cost_per_kg")) if rt else (typed, None)
        if kind == "bag":
            bags = to_int(raw.get("bags"), f"{label}: bags", minimum=1)
            size = to_int(raw.get("bag_size_grams"), f"{label}: bag size", minimum=1)
            ln = _line(name, "bag", 0, bags, size, unit, unit, cost)
        else:
            grams = to_int(raw.get("grams"), f"{label}: quantity (grams)", minimum=1)
            ln = _line(name, "loose", grams, 0, None, unit, unit, cost)
        ln["is_retail_type"] = bool(rt)
        lines.append(ln)
    return lines


def _header(channel: str, payload: dict) -> dict:
    mode = one_of(payload.get("payment_mode"), MODES, "Payment mode")
    customer_id = to_int(payload.get("customer_id"), "Customer", minimum=1, required=False)
    if channel == "wholesale" and customer_id is None:
        raise ApiError("Choose a customer for a wholesale sale.")
    if mode == "credit" and customer_id is None:
        raise ApiError("Choose a customer for a credit sale.")
    if customer_id is not None:
        from app.customers import service as customers
        customers.require_customer(customer_id)

    if channel == "retail":
        sale_date = req_date(payload.get("sale_date"), "Sale date", required=False) or db.today_str()
        sent_on = call_received_on = None
    else:
        sale_date = req_date(payload.get("sent_on"), "Sent on", required=False) or db.today_str()
        sent_on = sale_date
        call_received_on = req_date(payload.get("call_received_on"), "Call received on", required=False)
        if call_received_on and call_received_on > sale_date:
            raise ApiError("Call received date cannot be after the sent date.")

    advance = due_date = None
    if mode == "credit":
        advance = to_int(payload.get("advance_paid"), "Advance paid", minimum=0, required=False) or 0
        due_date = req_date(payload.get("due_date"), "Due date", required=False)
        if due_date and due_date < sale_date:
            raise ApiError("Due date cannot be before the sale date.")
    return {
        "payment_mode": mode, "customer_id": customer_id, "sale_date": sale_date, "sent_on": sent_on,
        "call_received_on": call_received_on, "advance_paid": advance or 0, "due_date": due_date,
        "notes": opt_str(payload, "notes", 500),
    }


def _split_payment(total: int, mode: str, advance: int, credit_amount: int | None) -> tuple[int, int]:
    """(paid_now, credit). `credit_amount` (orders → mark as sent) overrides the advance: advance = total − credit."""
    if mode == "credit" and credit_amount is not None:
        if credit_amount < 1 or credit_amount > total:
            raise ApiError(f"Credit amount must be between 1 and the sale total (₹{total}).")
        advance = total - credit_amount
    try:
        return calc.credit_part_of_sale(total, mode, advance)
    except ValueError:
        raise ApiError(f"Advance paid must be less than the sale total (₹{total}) for a credit sale.")


# --------------------------------------------------------------------------- #
# create / preview
# --------------------------------------------------------------------------- #
def create_sale(channel: str, payload: dict, user, *, source_order_id: int | None = None,
                credit_amount: int | None = None) -> dict:
    """
    Shared entry for the retail/wholesale create endpoints and orders → fulfil.
    Runs inside the caller's transaction when there is one (db.transaction nests).
    """
    one_of(channel, CHANNELS, "channel")
    if not isinstance(payload, dict):
        raise ApiError("Request body must be a JSON object.")
    h = _header(channel, payload)
    lines = build_retail_lines(payload) if channel == "retail" else build_wholesale_lines(payload)

    total = calc.sum_amounts(lines, "amount")
    list_total = calc.sum_amounts(lines, "list_amount")
    costs = [ln["cost_amount"] for ln in lines]
    cost_total = None if any(c is None for c in costs) else sum(costs)  # unknown if any line is unknown
    paid, credit = _split_payment(total, h["payment_mode"], h["advance_paid"], credit_amount)
    username, now = _uname(user), db.now_str()

    with db.transaction():
        sale_id = q.insert_sale({
            "channel": channel, "sale_date": h["sale_date"], "customer_id": h["customer_id"],
            "payment_mode": h["payment_mode"], "total_amount": total, "list_total": list_total,
            "cost_total": cost_total, "paid_amount": paid, "call_received_on": h["call_received_on"],
            "sent_on": h["sent_on"], "notes": h["notes"], "source_order_id": source_order_id,
            "created_by": username, "created_at": now,
        })
        for ln in lines:
            q.insert_item(sale_id, ln)
        if channel == "retail":
            inv = _inv()
            for ln in lines:  # all-or-nothing: a StockError rolls back the whole sale
                inv.deduct_for_sale(ln["rice_type"], ln["item_kind"], ln["grams"], ln["bags"], sale_id, username)
        else:
            for ln in lines:
                if not ln["is_retail_type"]:
                    q.add_wholesale_name(ln["rice_type"], now)
        if credit > 0:
            from app.credits import service as credits
            credits.create_credit_for_sale(sale_id, h["customer_id"], channel, credit, h["sale_date"],
                                           h["due_date"], username)
        db.audit(username, "create", "sale", sale_id, {
            "channel": channel, "total": total, "list_total": list_total, "mode": h["payment_mode"],
            "paid": paid, "credit": credit, "items": len(lines), "source_order_id": source_order_id,
        })
    return get_sale(sale_id, user)


def preview_retail(payload: dict) -> dict:
    """Same pricing as create, writes nothing. Stock is simulated per rice type in line order,
    exactly like deduct_for_sale does, so two lines of the same type are checked together."""
    if not isinstance(payload, dict):
        raise ApiError("Request body must be a JSON object.")
    lines = build_retail_lines(payload)
    inv = _inv()
    stock: dict[str, dict] = {}
    warnings: list[str] = []
    stock_ok = True
    out = []
    for ln in lines:
        key = ln["rice_type"].lower()
        if key not in stock:
            rt = inv.get_rice_type(ln["rice_type"]) or {}
            stock[key] = {"bags": rt.get("bags_qty", 0), "loose": rt.get("loose_grams", 0),
                          "size": rt.get("bag_size_grams")}
        st = stock[key]
        opens = 0
        try:
            if ln["item_kind"] == "bag":
                st["bags"] = calc.plan_bag_deduction(st["bags"], ln["bags"])["new_bags"]
            else:
                plan = calc.plan_loose_deduction(st["bags"], st["loose"], st["size"], ln["grams"])
                opens, st["bags"], st["loose"] = plan["bags_opened"], plan["new_bags"], plan["new_loose"]
        except StockError as e:
            stock_ok = False
            warnings.append(f"{ln['rice_type']}: {e}")
        if opens:
            warnings.append(f"{ln['rice_type']}: {opens} bag{'s' if opens > 1 else ''} will be opened for loose rice.")
        out.append({k: ln[k] for k in ("rice_type", "item_kind", "grams", "bags", "bag_size_grams",
                                       "list_unit_price", "unit_price", "list_amount", "amount", "auto_split")}
                   | {"opens_bags": opens})
    return {"lines": out, "total": calc.sum_amounts(lines, "amount"),
            "list_total": calc.sum_amounts(lines, "list_amount"), "warnings": warnings, "stock_ok": stock_ok}


# --------------------------------------------------------------------------- #
# reads
# --------------------------------------------------------------------------- #
def get_sale(sale_id: int, user=None) -> dict:
    user = user if user is not None else current_user()
    sale = _load_sale(sale_id)
    _require_channel_view(user, sale["channel"])
    return _serialize_many([sale], is_exact(user))[0]


def _mode_totals(sales: list[dict]) -> dict:
    t = {"cash": 0, "upi": 0, "credit": 0}
    for s in sales:
        t[s["payment_mode"]] += s["total_amount"]
    return t


def _line_profit(lines: list[dict]) -> int:
    return sum(ln["profit"] for ln in lines if ln.get("profit") is not None)


def retail_day(day: str | None, user=None) -> dict:
    user = user if user is not None else current_user()
    exact = is_exact(user)
    day = req_date(day, "date", required=False) or db.today_str()
    sales = _serialize_many(q.list_sales(channels=["retail"], date_from=day, date_to=day), exact)
    lines = [ln for s in sales for ln in s["items"]]
    totals = {"total": calc.sum_amounts(sales, "total_amount"), "count": len(sales), **_mode_totals(sales),
              "loose_grams": sum(ln["grams"] for ln in lines if ln["item_kind"] == "loose"),
              "bags": sum(ln["bags"] for ln in lines if ln["item_kind"] == "bag")}
    if exact:
        totals["discount"] = sum(s["discount_total"] for s in sales)
        totals["profit"] = _line_profit(lines)
    return {"view": "exact" if exact else "masked", "date": day,
            "loose": [ln for ln in lines if ln["item_kind"] == "loose"],
            "bags": [ln for ln in lines if ln["item_kind"] == "bag"],
            "sales": sales, "totals": totals}


def wholesale_list(args: dict, user=None) -> dict:
    user = user if user is not None else current_user()
    exact = is_exact(user)
    d_from = req_date(args.get("from"), "from", required=False) or days_ago(30)
    d_to = req_date(args.get("to"), "to", required=False) or db.today_str()
    cust = to_int(args.get("customer_id"), "customer_id", minimum=1, required=False)
    sales = _serialize_many(q.list_sales(channels=["wholesale"], date_from=d_from, date_to=d_to,
                                         customer_id=cust, newest_first=True), exact)
    totals = {"total": calc.sum_amounts(sales, "total_amount"), "count": len(sales),
              "bags": sum(ln["bags"] for s in sales for ln in s["items"]), **_mode_totals(sales)}
    return {"view": "exact" if exact else "masked", "from": d_from, "to": d_to, "sales": sales, "totals": totals}


def original_list(args: dict, user=None) -> dict:
    user = user if user is not None else current_user()
    d_from = req_date(args.get("from"), "from", required=False) or days_ago(30)
    d_to = req_date(args.get("to"), "to", required=False) or db.today_str()
    channel = args.get("channel") or None
    if channel:
        one_of(channel, CHANNELS, "channel")
    mode = args.get("payment_mode") or None
    if mode:
        one_of(mode, MODES, "payment_mode")
    cust = to_int(args.get("customer_id"), "customer_id", minimum=1, required=False)
    channels = [c for c in visible_channels(user) if channel in (None, c)]
    sales = _serialize_many(q.list_sales(channels=channels, date_from=d_from, date_to=d_to, customer_id=cust,
                                         payment_mode=mode, newest_first=True), exact=True)
    rows = [ln for s in sales for ln in s["items"]]
    costs = [ln["cost_amount"] for ln in rows if ln["cost_amount"] is not None]
    totals = {"total": calc.sum_amounts(sales, "total_amount"), "list_total": calc.sum_amounts(sales, "list_total"),
              "discount": sum(s["discount_total"] for s in sales), "cost": sum(costs),
              "profit": _line_profit(rows), "count": len(sales)}
    return {"view": "exact", "from": d_from, "to": d_to, "rows": rows, "sales": sales, "totals": totals}


def wholesale_rice_names() -> list[str]:
    names = {n.lower(): n for n in q.wholesale_names()}
    for n in _retail_type_names():
        names[n.lower()] = n  # the retail spelling wins
    return sorted(names.values(), key=str.lower)


def _retail_type_names() -> list[str]:
    inv = _inv()
    return [rt["type_name"] for rt in inv.list_rice_types(include_inactive=True)]


def customer_purchases(customer_id: int, limit: int = 50, user=None) -> list[dict]:
    """Latest purchases of a customer, masked per rule and limited to channels the user may view."""
    user = user if user is not None else current_user()
    sales = q.list_sales(channels=visible_channels(user), customer_id=customer_id, include_void=True,
                         newest_first=True, limit=limit)
    return _serialize_many(sales, is_exact(user))


def recent_lines(limit: int = 10, user=None) -> list[dict] | None:
    """Most recent sale lines across the channels the user may view (dashboard)."""
    user = user if user is not None else current_user()
    channels = visible_channels(user)
    if not channels:
        return None
    sales = _serialize_many(q.list_sales(channels=channels, newest_first=True, limit=limit), is_exact(user))
    return [ln for s in sales for ln in s["items"]][:limit]


def lines_for_range(d_from: str, d_to: str, channels: list[str], exact: bool) -> list[dict]:
    """Serialised lines for reports (CSV). Active sales only, oldest first."""
    sales = _serialize_many(q.list_sales(channels=channels, date_from=d_from, date_to=d_to), exact)
    return [ln for s in sales for ln in s["items"]]


# --------------------------------------------------------------------------- #
# void
# --------------------------------------------------------------------------- #
def void_sale(sale_id: int, payload: dict, user) -> dict:
    if not user.can("sales:void"):
        raise ApiError("You do not have access to this.", 403, "forbidden")
    reason = opt_str(payload or {}, "reason", 300)
    username = _uname(user)
    with db.transaction():
        sale = _load_sale(sale_id)  # re-read under the write lock
        _require_channel_view(user, sale["channel"])
        if sale["status"] == "void":
            raise ApiError("This sale is already cancelled.", 409, "already_void")
        if sale["channel"] == "retail":
            _inv().restore_for_sale(sale_id, username)
        from app.credits import service as credits
        credits.void_credit_for_sale(sale_id, username)  # 409 (and full rollback) if payments exist
        q.mark_void(sale_id, db.now_str(), reason)
        db.audit(username, "void", "sale", sale_id, {"reason": reason, "total": sale["total_amount"]})
    return get_sale(sale_id, user)

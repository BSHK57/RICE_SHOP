"""
credits/service.py - the credit ledger: entries (from credit sales or entered by hand), payments
against one entry, lump-sum payments spread oldest-first, and the read views (summary, by customer,
by date, customer ledger, collections).

Visibility: wholesale credits exist only for users holding `credits:wholesale`. Every query receives
the list of channels the user may see, so hidden rows are filtered in SQL (including totals).
"""
from __future__ import annotations

from datetime import date, timedelta

from app import db
from app.auth.permissions import current_user
from app.credits import queries as q
from app.utils import calc
from app.utils.common import ApiError, one_of, opt_str, req_date, to_int

CHANNELS = ("retail", "wholesale")
PAY_MODES = ("cash", "upi")


def _uname(user) -> str | None:
    return getattr(user, "username", user)


def visible_channels(user=None) -> list[str]:
    u = user if user is not None else current_user()
    if not u or not u.can("credits:view"):
        return []
    return ["retail", "wholesale"] if u.can("credits:wholesale") else ["retail"]


def _today() -> str:
    return db.today_str()


def _not_found(what="Credit entry"):
    return ApiError(f"{what} not found.", 404, "not_found")


# ------------------------------- serializers ------------------------------- #
def serialize_entry(row: dict, today: str | None = None) -> dict:
    today = today or _today()
    out = dict(row)
    out["overdue"] = calc.is_overdue(row["due_date"], row["balance"], today)
    out["status"] = "settled" if row["balance"] <= 0 else "open"
    return out


def serialize_payment(row: dict, with_channel: bool = False) -> dict:
    keys = ["id", "credit_id", "customer_id", "customer_name", "paid_on", "amount", "mode", "notes",
            "created_by", "created_at"]
    if with_channel:
        keys.append("channel")
    return {k: row[k] for k in keys}


def _entry_or_404(entry_id: int, user) -> dict:
    row = q.get_entry(entry_id, visible_channels(user))
    if not row:
        raise _not_found()
    return row


# ------------------------------ §9 contracts -------------------------------- #
def create_credit_for_sale(sale_id, customer_id, channel, amount, credit_date, due_date, user) -> int:
    """Called by sales.create_sale inside its transaction."""
    entry_id = q.insert_entry({
        "customer_id": customer_id, "sale_id": sale_id, "channel": channel, "amount": int(amount),
        "credit_date": credit_date, "due_date": due_date, "notes": None,
        "created_by": _uname(user), "created_at": db.now_str(),
    })
    db.audit(_uname(user), "create", "credit", entry_id, {"sale_id": sale_id, "amount": amount})
    return entry_id


def void_credit_for_sale(sale_id, user) -> None:
    """Void the credit of a sale being voided. Refused (409) once payments exist, so the caller's
    transaction rolls the whole void back."""
    for e in q.active_entries_for_sale(sale_id):
        if q.payment_count(e["id"]):
            raise ApiError(
                f"₹{e['paid']} has already been paid against this sale's credit. "
                "Delete those payments first, then cancel the sale.", 409, "has_payments")
        q.void_entry(e["id"])
        db.audit(_uname(user), "void", "credit", e["id"], {"sale_id": sale_id, "amount": e["amount"]})


def customer_summary(customer_id: int, user=None) -> dict:
    t = q.totals(visible_channels(user), customer_id)
    return {"total_credit": t["total_credit"], "total_paid": t["total_paid"], "balance": t["balance"]}


def balances_by_customer(user=None) -> dict[int, int]:
    return q.balances_by_customer(visible_channels(user))


def credit_ids_for_sales(sale_ids: list[int]) -> dict[int, int]:
    return q.credit_ids_for_sales(sale_ids)


# ---------------------------------- reads ---------------------------------- #
def summary(user=None) -> dict:
    u = user if user is not None else current_user()
    today = _today()
    n = q.summary_numbers(visible_channels(u), today, today[:8] + "01")
    return {
        "outstanding_total": n["outstanding_total"], "outstanding_retail": n["outstanding_retail"],
        "outstanding_wholesale": n["outstanding_wholesale"] if u.can("credits:wholesale") else None,
        "overdue_total": n["overdue_total"], "overdue_count": n["overdue_count"],
        "due_today": n["due_today"], "due_today_count": n["due_today_count"],
        "customers_with_balance": n["customers_with_balance"],
        "collected_today": n["collected_today"], "collected_this_month": n["collected_this_month"],
    }


def _channel_arg(v) -> str | None:
    return one_of(v, CHANNELS, "channel") if v else None


def _date_field(v) -> str:
    return one_of(v or "credit_date", ("credit_date", "due_date"), "date_field")


def list_entries(args, user=None) -> list[dict]:
    status = one_of(args.get("status") or "open", ("open", "settled", "all"), "status")
    date_field = _date_field(args.get("date_field"))
    rows = q.list_entries(
        visible_channels(user), status=status, channel=_channel_arg(args.get("channel")),
        customer_id=to_int(args.get("customer_id"), "customer_id", minimum=1, required=False),
        date_from=req_date(args.get("from"), "from", required=False),
        date_to=req_date(args.get("to"), "to", required=False), date_field=date_field,
        order="cb.due_date DESC, cb.id DESC" if date_field == "due_date" else "cb.credit_date DESC, cb.id DESC",
    )
    today = _today()
    return [serialize_entry(r, today) for r in rows]


def by_customer(args, user=None) -> list[dict]:
    status = one_of(args.get("status") or "open", ("open", "all"), "status")
    qtext = (args.get("q") or "").strip()[:100] or None
    today = _today()
    out = []
    for r in q.by_customer(visible_channels(user), open_only=status == "open", q=qtext):
        r = dict(r)
        # the earliest due date among open entries decides whether the customer is overdue
        r["overdue"] = calc.is_overdue(r["next_due_date"], r["balance"], today)
        out.append(r)
    return out


def by_date(args, user=None) -> list[dict]:
    date_field = _date_field(args.get("date_field"))
    status = one_of(args.get("status") or "all", ("open", "settled", "all"), "status")
    rows = q.list_entries(
        visible_channels(user), status=status, date_field=date_field,
        date_from=req_date(args.get("from"), "from", required=False),
        date_to=req_date(args.get("to"), "to", required=False),
        order="cb.due_date DESC, cb.id DESC" if date_field == "due_date" else "cb.credit_date DESC, cb.id DESC",
    )
    today = _today()
    groups: dict[str, dict] = {}
    for r in rows:
        key = r[date_field]
        if key is None:
            continue  # no due date -> not on a due-date calendar
        g = groups.setdefault(key, {"date": key, "total_amount": 0, "total_balance": 0, "entries": []})
        g["total_amount"] += r["amount"]
        g["total_balance"] += r["balance"]
        g["entries"].append(serialize_entry(r, today))
    return sorted(groups.values(), key=lambda g: g["date"], reverse=True)


def customer_ledger(customer_id: int, user=None) -> dict:
    from app.customers import service as customers
    customer = customers.get_customer(customer_id)
    if not customer:
        raise _not_found("Customer")
    rows = q.list_entries(visible_channels(user), status="all", customer_id=customer_id,
                          order="cb.credit_date ASC, cb.id ASC")
    pays: dict[int, list] = {}
    for p in q.payments_for_entries([r["id"] for r in rows]):
        pays.setdefault(p["credit_id"], []).append(serialize_payment(p))
    today = _today()
    entries = [serialize_entry(r, today) | {"payments": pays.get(r["id"], [])} for r in rows]
    return {"customer": customer, "summary": customer_summary(customer_id, user), "entries": entries}


def collections(args, user=None) -> dict:
    d_from = req_date(args.get("from"), "from", required=False)
    d_to = req_date(args.get("to"), "to", required=False)
    if not d_from and not d_to:
        d_from = (date.today() - timedelta(days=30)).isoformat()
    rows = q.list_payments(visible_channels(user), date_from=d_from, date_to=d_to,
                           channel=_channel_arg(args.get("channel")),
                           customer_id=to_int(args.get("customer_id"), "customer_id", minimum=1, required=False))
    payments = [serialize_payment(r, with_channel=True) for r in rows]
    return {"total": calc.sum_amounts(payments), "payments": payments}


# ---------------------------------- writes ---------------------------------- #
def create_manual_entry(body: dict, user) -> dict:
    from app.customers import service as customers
    customer_id = to_int(body.get("customer_id"), "Customer", minimum=1)
    channel = one_of(body.get("channel") or "retail", CHANNELS, "Channel")
    if channel == "wholesale" and not user.can("credits:wholesale"):
        raise ApiError("You do not have access to wholesale credits.", 403, "forbidden")
    amount = to_int(body.get("amount"), "Amount", minimum=1)
    credit_date = req_date(body.get("credit_date"), "Credit date", required=False) or _today()
    due_date = req_date(body.get("due_date"), "Due date", required=False)
    if due_date and due_date < credit_date:
        raise ApiError("Due date cannot be before the credit date.")
    notes = opt_str(body, "notes", 500)
    with db.transaction():
        customers.require_customer(customer_id)
        entry_id = q.insert_entry({
            "customer_id": customer_id, "sale_id": None, "channel": channel, "amount": amount,
            "credit_date": credit_date, "due_date": due_date, "notes": notes,
            "created_by": _uname(user), "created_at": db.now_str(),
        })
        db.audit(_uname(user), "create", "credit", entry_id, {"manual": True, "amount": amount, "channel": channel})
    return serialize_entry(_entry_or_404(entry_id, user))


def update_entry(entry_id: int, body: dict, user) -> dict:
    fields = {}
    if "due_date" in body:
        fields["due_date"] = req_date(body.get("due_date"), "Due date", required=False)  # null clears
    if "notes" in body:
        fields["notes"] = opt_str(body, "notes", 500)
    with db.transaction():
        entry = _entry_or_404(entry_id, user)
        if fields.get("due_date") and fields["due_date"] < entry["credit_date"]:
            raise ApiError("Due date cannot be before the credit date.")
        q.update_entry(entry_id, fields)
        db.audit(_uname(user), "update", "credit", entry_id, fields)
    return serialize_entry(_entry_or_404(entry_id, user))


def _payment_fields(body: dict) -> dict:
    return {
        "mode": one_of(body.get("mode"), PAY_MODES, "Payment mode"),
        "paid_on": req_date(body.get("paid_on"), "Paid on", required=False) or _today(),
        "notes": opt_str(body, "notes", 300),
    }


def pay_entry(entry_id: int, body: dict, user) -> dict:
    amount = to_int(body.get("amount"), "Amount", minimum=1)
    f = _payment_fields(body)
    with db.transaction():
        entry = _entry_or_404(entry_id, user)  # re-read under the write lock -> balance is current
        if entry["balance"] <= 0:
            raise ApiError("This credit is already fully paid.")
        if amount > entry["balance"]:
            raise ApiError(f"Amount cannot be more than the balance of ₹{entry['balance']}.")
        pid = q.insert_payment({"credit_id": entry_id, "customer_id": entry["customer_id"], "amount": amount,
                                **f, "created_by": _uname(user), "created_at": db.now_str()})
        db.audit(_uname(user), "payment", "credit", entry_id, {"payment_id": pid, "amount": amount, "mode": f["mode"]})
        payment = q.get_payment(pid, visible_channels(user))
        entry = _entry_or_404(entry_id, user)
    return {"payment": serialize_payment(payment), "entry": serialize_entry(entry)}


def pay_customer_lump_sum(customer_id: int, body: dict, user) -> dict:
    from app.customers import service as customers
    amount = to_int(body.get("amount"), "Amount", minimum=1)
    f = _payment_fields(body)
    channel = _channel_arg(body.get("channel"))
    channels = visible_channels(user)
    with db.transaction():
        if not customers.get_customer(customer_id):
            raise _not_found("Customer")
        # oldest first: credit_date, then id (entry order) - what allocate_fifo expects
        open_entries = q.list_entries(channels, status="open", channel=channel, customer_id=customer_id,
                                      order="cb.credit_date ASC, cb.id ASC")
        total_balance = calc.sum_amounts(open_entries, "balance")
        if total_balance <= 0:
            raise ApiError("This customer has nothing to pay.")
        if amount > total_balance:
            raise ApiError(f"Amount cannot be more than the total balance of ₹{total_balance}.")
        allocations, _left = calc.allocate_fifo(amount, open_entries)
        now, payments = db.now_str(), []
        for a in allocations:
            pid = q.insert_payment({"credit_id": a["credit_id"], "customer_id": customer_id, "amount": a["amount"],
                                    **f, "created_by": _uname(user), "created_at": now})
            payments.append(pid)
        db.audit(_uname(user), "payment", "customer_credit", customer_id,
                 {"amount": amount, "mode": f["mode"], "allocations": allocations})
        rows = [q.get_payment(pid, channels) for pid in payments]
    return {"payments": [serialize_payment(r) for r in rows], "allocated": amount,
            "customer_balance": customer_summary(customer_id, user)["balance"]}


def delete_payment(payment_id: int, user) -> dict:
    with db.transaction():
        p = q.get_payment(payment_id, visible_channels(user))
        if not p:
            raise _not_found("Payment")
        q.delete_payment(payment_id)
        db.audit(_uname(user), "delete_payment", "credit", p["credit_id"],
                 {"payment_id": payment_id, "amount": p["amount"], "paid_on": p["paid_on"], "mode": p["mode"]})
        entry = _entry_or_404(p["credit_id"], user)
    return {"entry": serialize_entry(entry)}


def delete_entry(entry_id: int, user) -> dict:
    with db.transaction():
        entry = _entry_or_404(entry_id, user)
        if entry["sale_id"] is not None:
            raise ApiError("This credit came from a sale. Cancel (void) the sale instead.", 409, "from_sale")
        if q.payment_count(entry_id):
            raise ApiError("This credit has payments. Delete the payments first.", 409, "has_payments")
        q.void_entry(entry_id)  # soft delete: the row stays for the audit trail
        db.audit(_uname(user), "delete", "credit", entry_id, {"amount": entry["amount"]})
    return {}

"""
reports/service.py - dashboard widgets, the reports summary and the CSV export.

Rules: amounts follow the masking rule (exact only with `original:view`; discount/profit keys appear
only then); wholesale is counted only with `wholesale:view`; each dashboard widget is null when the
user lacks the permission behind it.
"""
from __future__ import annotations

import csv
import io
from datetime import date, timedelta

from app import db
from app.auth.permissions import current_user
from app.reports import queries as q
from app.utils.common import ApiError, one_of, req_date

CHANNELS = ("retail", "wholesale")


def _exact(u) -> bool:
    return u.can("original:view")


def _channels(u, wanted: str | None) -> list[str]:
    wanted = one_of(wanted or "both", ("retail", "wholesale", "both"), "channel")
    out = []
    if wanted in ("retail", "both") and u.can("retail:view"):
        out.append("retail")
    if wanted in ("wholesale", "both") and u.can("wholesale:view"):
        out.append("wholesale")
    return out


def _range(args) -> tuple[str, str]:
    d_to = req_date(args.get("to"), "to", required=False) or db.today_str()
    d_from = req_date(args.get("from"), "from", required=False) or (date.today() - timedelta(days=30)).isoformat()
    if d_from > d_to:
        raise ApiError("'from' must be on or before 'to'.")
    return d_from, d_to


# --------------------------------- dashboard -------------------------------- #
def _today_widget(channel: str, exact: bool) -> dict:
    today = db.today_str()
    t = q.sale_totals([channel], today, today, exact)
    return {k: t[k] for k in ("total", "count", "cash", "upi", "credit")}


def dashboard(user=None) -> dict:
    u = user if user is not None else current_user()
    exact = _exact(u)

    credits_w = None
    if u.can("credits:view"):
        from app.credits import service as credits
        s = credits.summary(u)
        credits_w = {"outstanding": s["outstanding_total"], "overdue_total": s["overdue_total"],
                     "overdue_count": s["overdue_count"], "due_today": s["due_today"],
                     "due_today_count": s["due_today_count"]}

    orders_w = None
    if u.can("orders:view"):
        from app.orders import service as orders
        s = orders.summary(u)
        orders_w = {"pending": s["pending"], "overdue": s["overdue"], "next_due": s["next_due"]}

    low_stock = None
    if u.can("inventory:view"):
        from app.inventory import service as inv
        show_cost = u.can("original:view") or u.can("inventory:edit")
        low_stock = [rt if show_cost else {k: v for k, v in rt.items() if k != "purchase_cost_per_kg"}
                     for rt in inv.low_stock_list()]

    from app.sales import service as sales
    return {
        "view": "exact" if exact else "masked",
        "today": {
            "retail": _today_widget("retail", exact) if u.can("retail:view") else None,
            "wholesale": _today_widget("wholesale", exact) if u.can("wholesale:view") else None,
        },
        "credits": credits_w,
        "orders": orders_w,
        "low_stock": low_stock,
        "recent_sales": sales.recent_lines(10, u),  # None when no sales channel is visible
    }


# ---------------------------------- summary --------------------------------- #
def summary(args, user=None) -> dict:
    u = user if user is not None else current_user()
    exact = _exact(u)
    d_from, d_to = _range(args)
    ch = _channels(u, args.get("channel"))
    st = q.sale_totals(ch, d_from, d_to, exact)
    it = q.item_totals(ch, d_from, d_to, exact)
    totals = {k: st[k] for k in ("total", "count", "cash", "upi", "credit")}
    totals.update(bags=it["bags"], loose_grams=it["loose_grams"])
    by_day = q.by_day(ch, d_from, d_to, exact)
    by_rice = q.by_rice(ch, d_from, d_to, exact)
    if exact:
        totals.update(discount=st["discount"], profit=it["profit"])
    else:  # masked: no discount / profit anywhere
        for r in by_day + by_rice:
            r.pop("profit", None)
    return {
        "view": "exact" if exact else "masked",
        "range": {"from": d_from, "to": d_to, "channels": ch},
        "totals": totals, "by_day": by_day, "by_rice": by_rice,
        "by_payment_mode": q.by_payment_mode(ch, d_from, d_to, exact),
        "top_customers": q.top_customers(ch, d_from, d_to, exact),
    }


# ------------------------------------ CSV ----------------------------------- #
_BASE_COLS = [("sale_id", "Sale #"), ("sale_date", "Date"), ("channel", "Channel"), ("customer_name", "Customer"),
              ("rice_type", "Rice type"), ("item_kind", "Kind"), ("quantity_label", "Quantity"),
              ("grams", "Loose grams"), ("bags", "Bags"), ("bag_size_grams", "Bag size (g)"),
              ("payment_mode", "Payment"), ("unit_price", "Unit price"), ("amount", "Amount")]
_EXACT_COLS = [("list_unit_price", "List unit price"), ("list_amount", "List amount"), ("discount", "Discount"),
               ("cost_amount", "Cost"), ("profit", "Profit")]


def _cell(v):
    """Spreadsheet-injection guard: text starting with = + - @ is prefixed with a quote."""
    if v is None:
        return ""
    if isinstance(v, str) and v[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + v
    return v


def sales_csv(args, user=None) -> tuple[str, str]:
    """-> (csv text, filename)."""
    u = user if user is not None else current_user()
    exact = _exact(u)
    d_from, d_to = _range(args)
    from app.sales import service as sales
    lines = sales.lines_for_range(d_from, d_to, _channels(u, args.get("channel")), exact)
    cols = _BASE_COLS + (_EXACT_COLS if exact else [])
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow([label for _, label in cols])
    for ln in lines:
        w.writerow([_cell(ln.get(key)) for key, _ in cols])
    return buf.getvalue(), f"sales_{d_from}_to_{d_to}.csv"

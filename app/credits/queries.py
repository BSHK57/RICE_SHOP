"""
credits/queries.py - ALL SQL for credit_entries / credit_payments (+ read-only joins on customers and
the v_credit_balance view). No business rules: the service passes `channels` (the channels the
current user may see) and every query filters on them, so hidden wholesale rows never leave SQL.
"""
from __future__ import annotations

from app import db

_ENTRY_COLS = """
    cb.id, cb.customer_id, c.name AS customer_name, c.phone AS customer_phone, cb.channel, cb.sale_id,
    cb.amount, cb.paid, cb.balance, cb.credit_date, cb.due_date, cb.notes, cb.created_by, cb.created_at
"""
_ENTRY_FROM = "FROM v_credit_balance cb JOIN customers c ON c.id = cb.customer_id"

_PAYMENT_COLS = """
    cp.id, cp.credit_id, cp.customer_id, c.name AS customer_name, cp.paid_on, cp.amount, cp.mode,
    cp.notes, cp.created_by, cp.created_at, ce.channel
"""
_PAYMENT_FROM = ("FROM credit_payments cp JOIN credit_entries ce ON ce.id = cp.credit_id "
                 "JOIN customers c ON c.id = cp.customer_id")

DATE_FIELDS = {"credit_date": "cb.credit_date", "due_date": "cb.due_date"}  # whitelist


def _in(col: str, values: list) -> tuple[str, list]:
    if not values:
        return "0", []
    return f"{col} IN ({','.join('?' * len(values))})", list(values)


def _entry_where(channels, *, status="all", channel=None, customer_id=None, date_from=None, date_to=None,
                 date_field="credit_date", q=None, sale_ids=None) -> tuple[str, list]:
    clause, params = _in("cb.channel", channels)
    where = ["cb.status = 'active'", clause]
    if status == "open":
        where.append("cb.balance > 0")
    elif status == "settled":
        where.append("cb.balance <= 0")
    if channel:
        where.append("cb.channel = ?")
        params.append(channel)
    if customer_id is not None:
        where.append("cb.customer_id = ?")
        params.append(customer_id)
    col = DATE_FIELDS[date_field]
    if date_from:
        where.append(f"{col} >= ?")
        params.append(date_from)
    if date_to:
        where.append(f"{col} <= ?")
        params.append(date_to)
    if date_field == "due_date" and (date_from or date_to):
        where.append("cb.due_date IS NOT NULL")
    if q:
        where.append("c.name LIKE ?")
        params.append(f"%{q}%")
    return " AND ".join(where), params


def list_entries(channels, *, order="cb.credit_date DESC, cb.id DESC", **filters) -> list[dict]:
    assert order in ("cb.credit_date DESC, cb.id DESC", "cb.credit_date ASC, cb.id ASC",
                     "cb.due_date DESC, cb.id DESC")
    where, params = _entry_where(channels, **filters)
    return db.query_all(f"SELECT {_ENTRY_COLS} {_ENTRY_FROM} WHERE {where} ORDER BY {order}", params)


def get_entry(entry_id: int, channels) -> dict | None:
    clause, params = _in("cb.channel", channels)
    return db.query_one(
        f"SELECT {_ENTRY_COLS} {_ENTRY_FROM} WHERE cb.id = ? AND cb.status = 'active' AND {clause}",
        [entry_id, *params],
    )


def by_customer(channels, *, open_only: bool, q: str | None) -> list[dict]:
    clause, params = _in("cb.channel", channels)
    where = ["cb.status = 'active'", clause]
    if q:
        where.append("c.name LIKE ?")
        params.append(f"%{q}%")
    pay_clause, pay_params = _in("ce.channel", channels)
    sql = f"""
        SELECT cb.customer_id, c.name, c.phone, c.place,
               SUM(cb.amount) AS total_credit, SUM(cb.paid) AS total_paid, SUM(cb.balance) AS balance,
               SUM(CASE WHEN cb.balance > 0 THEN 1 ELSE 0 END) AS open_count,
               MIN(CASE WHEN cb.balance > 0 THEN cb.credit_date END) AS oldest_open_date,
               MIN(CASE WHEN cb.balance > 0 THEN cb.due_date END) AS next_due_date,
               (SELECT MAX(cp.paid_on) FROM credit_payments cp
                  JOIN credit_entries ce ON ce.id = cp.credit_id
                 WHERE cp.customer_id = cb.customer_id AND ce.status = 'active' AND {pay_clause}) AS last_payment_on
          {_ENTRY_FROM}
         WHERE {' AND '.join(where)}
         GROUP BY cb.customer_id
         {'HAVING SUM(cb.balance) > 0' if open_only else ''}
         ORDER BY (SUM(cb.balance) > 0) DESC, c.name COLLATE NOCASE
    """
    # the correlated sub-query's params come first in the SELECT list
    return db.query_all(sql, [*pay_params, *params])


def totals(channels, customer_id: int | None = None) -> dict:
    clause, params = _in("cb.channel", channels)
    where = ["cb.status = 'active'", clause]
    if customer_id is not None:
        where.append("cb.customer_id = ?")
        params.append(customer_id)
    return db.query_one(
        f"""SELECT COALESCE(SUM(cb.amount),0) AS total_credit, COALESCE(SUM(cb.paid),0) AS total_paid,
                   COALESCE(SUM(cb.balance),0) AS balance
              FROM v_credit_balance cb WHERE {' AND '.join(where)}""", params)


def summary_numbers(channels, today: str, month_start: str) -> dict:
    clause, params = _in("cb.channel", channels)
    pclause, pparams = _in("ce.channel", channels)
    row = db.query_one(
        f"""SELECT COALESCE(SUM(cb.balance),0) AS outstanding_total,
                   COALESCE(SUM(CASE WHEN cb.channel='retail' THEN cb.balance END),0) AS outstanding_retail,
                   COALESCE(SUM(CASE WHEN cb.channel='wholesale' THEN cb.balance END),0) AS outstanding_wholesale,
                   COALESCE(SUM(CASE WHEN cb.balance > 0 AND cb.due_date IS NOT NULL AND cb.due_date < ?
                                     THEN cb.balance END),0) AS overdue_total,
                   COALESCE(SUM(CASE WHEN cb.balance > 0 AND cb.due_date IS NOT NULL AND cb.due_date < ?
                                     THEN 1 ELSE 0 END),0) AS overdue_count,
                   COALESCE(SUM(CASE WHEN cb.balance > 0 AND cb.due_date = ? THEN cb.balance END),0) AS due_today,
                   COALESCE(SUM(CASE WHEN cb.balance > 0 AND cb.due_date = ? THEN 1 ELSE 0 END),0) AS due_today_count,
                   COUNT(DISTINCT CASE WHEN cb.balance > 0 THEN cb.customer_id END) AS customers_with_balance
              FROM v_credit_balance cb WHERE cb.status = 'active' AND {clause}""",
        [today, today, today, today, *params])
    pay = db.query_one(
        f"""SELECT COALESCE(SUM(CASE WHEN cp.paid_on = ? THEN cp.amount END),0) AS collected_today,
                   COALESCE(SUM(CASE WHEN cp.paid_on >= ? AND cp.paid_on <= ? THEN cp.amount END),0)
                       AS collected_this_month
              FROM credit_payments cp JOIN credit_entries ce ON ce.id = cp.credit_id
             WHERE ce.status = 'active' AND {pclause}""",
        [today, month_start, today, *pparams])
    return {**row, **pay}


def payments_for_entries(entry_ids: list[int]) -> list[dict]:
    if not entry_ids:
        return []
    return db.query_all(
        f"SELECT {_PAYMENT_COLS} {_PAYMENT_FROM} WHERE cp.credit_id IN ({','.join('?' * len(entry_ids))}) "
        "ORDER BY cp.paid_on, cp.id", entry_ids)


def list_payments(channels, *, date_from=None, date_to=None, channel=None, customer_id=None) -> list[dict]:
    clause, params = _in("ce.channel", channels)
    where = ["ce.status = 'active'", clause]
    if date_from:
        where.append("cp.paid_on >= ?")
        params.append(date_from)
    if date_to:
        where.append("cp.paid_on <= ?")
        params.append(date_to)
    if channel:
        where.append("ce.channel = ?")
        params.append(channel)
    if customer_id is not None:
        where.append("cp.customer_id = ?")
        params.append(customer_id)
    return db.query_all(
        f"SELECT {_PAYMENT_COLS} {_PAYMENT_FROM} WHERE {' AND '.join(where)} ORDER BY cp.paid_on DESC, cp.id DESC",
        params)


def get_payment(payment_id: int, channels) -> dict | None:
    clause, params = _in("ce.channel", channels)
    return db.query_one(
        f"SELECT {_PAYMENT_COLS} {_PAYMENT_FROM} WHERE cp.id = ? AND ce.status = 'active' AND {clause}",
        [payment_id, *params])


def insert_entry(row: dict) -> int:
    return db.execute(
        """INSERT INTO credit_entries(customer_id, sale_id, channel, amount, credit_date, due_date, notes,
                                      status, created_by, created_at)
           VALUES (:customer_id, :sale_id, :channel, :amount, :credit_date, :due_date, :notes, 'active',
                   :created_by, :created_at)""", row).lastrowid


def update_entry(entry_id: int, fields: dict) -> None:
    allowed = {"due_date", "notes"}
    sets = [f"{k} = ?" for k in fields if k in allowed]
    if not sets:
        return
    db.execute(f"UPDATE credit_entries SET {', '.join(sets)} WHERE id = ?",
               [fields[k] for k in fields if k in allowed] + [entry_id])


def void_entry(entry_id: int) -> None:
    db.execute("UPDATE credit_entries SET status = 'void' WHERE id = ?", (entry_id,))


def insert_payment(row: dict) -> int:
    return db.execute(
        """INSERT INTO credit_payments(credit_id, customer_id, paid_on, amount, mode, notes, created_by, created_at)
           VALUES (:credit_id, :customer_id, :paid_on, :amount, :mode, :notes, :created_by, :created_at)""",
        row).lastrowid


def delete_payment(payment_id: int) -> None:
    db.execute("DELETE FROM credit_payments WHERE id = ?", (payment_id,))


def payment_count(entry_id: int) -> int:
    return db.query_value("SELECT COUNT(*) FROM credit_payments WHERE credit_id = ?", (entry_id,), 0)


def active_entries_for_sale(sale_id: int) -> list[dict]:
    return db.query_all(
        "SELECT id, amount, paid, balance FROM v_credit_balance WHERE sale_id = ? AND status = 'active'", (sale_id,))


def credit_ids_for_sales(sale_ids: list[int]) -> dict[int, int]:
    if not sale_ids:
        return {}
    out: dict[int, int] = {}
    ids = list(sale_ids)
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        # prefer the active entry; a voided sale still links to its (void) entry
        for r in db.query_all(
                f"""SELECT sale_id, id FROM credit_entries WHERE sale_id IN ({','.join('?' * len(chunk))})
                    ORDER BY (status = 'active') ASC, id ASC""", chunk):
            out[r["sale_id"]] = r["id"]
    return out


def balances_by_customer(channels) -> dict[int, int]:
    clause, params = _in("cb.channel", channels)
    return {r["customer_id"]: r["balance"] for r in db.query_all(
        f"SELECT customer_id, SUM(balance) AS balance FROM v_credit_balance cb "
        f"WHERE cb.status = 'active' AND {clause} GROUP BY customer_id", params)}

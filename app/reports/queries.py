"""
reports/queries.py - read-only aggregates over sales / sale_items for the reports tab.

Masking: callers pass `exact`; when False every amount comes from the list (standard) columns
(`list_total` / `list_amount`). Only fixed column names are interpolated - never user input.
"""
from __future__ import annotations

from app import db


def _cols(exact: bool) -> tuple[str, str]:
    return ("s.total_amount", "i.amount") if exact else ("s.list_total", "i.list_amount")


def _where(channels, d_from, d_to) -> tuple[str, list]:
    if not channels:
        return "0", []
    return (f"s.status = 'active' AND s.channel IN ({','.join('?' * len(channels))}) "
            "AND s.sale_date >= ? AND s.sale_date <= ?", [*channels, d_from, d_to])


def sale_totals(channels, d_from, d_to, exact) -> dict:
    tot, _ = _cols(exact)
    where, p = _where(channels, d_from, d_to)
    return db.query_one(
        f"""SELECT COUNT(*) AS count, COALESCE(SUM({tot}),0) AS total,
                   COALESCE(SUM(CASE WHEN s.payment_mode='cash' THEN {tot} END),0) AS cash,
                   COALESCE(SUM(CASE WHEN s.payment_mode='upi' THEN {tot} END),0) AS upi,
                   COALESCE(SUM(CASE WHEN s.payment_mode='credit' THEN {tot} END),0) AS credit,
                   COALESCE(SUM(s.list_total - s.total_amount),0) AS discount
              FROM sales s WHERE {where}""", p)


def item_totals(channels, d_from, d_to, exact) -> dict:
    _, amt = _cols(exact)
    where, p = _where(channels, d_from, d_to)
    return db.query_one(
        f"""SELECT COALESCE(SUM(CASE WHEN i.item_kind='bag' THEN i.bags END),0) AS bags,
                   COALESCE(SUM(CASE WHEN i.item_kind='loose' THEN i.grams END),0) AS loose_grams,
                   COALESCE(SUM(CASE WHEN i.cost_amount IS NOT NULL THEN {amt} - i.cost_amount END),0) AS profit
              FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE {where}""", p)


def by_day(channels, d_from, d_to, exact) -> list[dict]:
    tot, amt = _cols(exact)
    where, p = _where(channels, d_from, d_to)
    days = db.query_all(
        f"""SELECT s.sale_date AS date, COALESCE(SUM({tot}),0) AS total, COUNT(*) AS count
              FROM sales s WHERE {where} GROUP BY s.sale_date ORDER BY s.sale_date""", p)
    profits = {r["date"]: r["profit"] for r in db.query_all(
        f"""SELECT s.sale_date AS date,
                   COALESCE(SUM(CASE WHEN i.cost_amount IS NOT NULL THEN {amt} - i.cost_amount END),0) AS profit
              FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE {where} GROUP BY s.sale_date""", p)}
    for d in days:
        d["profit"] = profits.get(d["date"], 0)
    return days


def by_rice(channels, d_from, d_to, exact) -> list[dict]:
    _, amt = _cols(exact)
    where, p = _where(channels, d_from, d_to)
    return db.query_all(
        f"""SELECT i.rice_type,
                   COALESCE(SUM(CASE WHEN i.item_kind='loose' THEN i.grams END),0) AS grams,
                   COALESCE(SUM(CASE WHEN i.item_kind='bag' THEN i.bags END),0) AS bags,
                   COALESCE(SUM({amt}),0) AS amount,
                   COALESCE(SUM(CASE WHEN i.cost_amount IS NOT NULL THEN {amt} - i.cost_amount END),0) AS profit
              FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE {where}
             GROUP BY i.rice_type COLLATE NOCASE ORDER BY amount DESC""", p)


def by_payment_mode(channels, d_from, d_to, exact) -> list[dict]:
    tot, _ = _cols(exact)
    where, p = _where(channels, d_from, d_to)
    return db.query_all(
        f"""SELECT s.payment_mode AS mode, COALESCE(SUM({tot}),0) AS total, COUNT(*) AS count
              FROM sales s WHERE {where} GROUP BY s.payment_mode ORDER BY total DESC""", p)


def top_customers(channels, d_from, d_to, exact, limit=10) -> list[dict]:
    tot, _ = _cols(exact)
    where, p = _where(channels, d_from, d_to)
    return db.query_all(
        f"""SELECT s.customer_id, c.name, COALESCE(SUM({tot}),0) AS total, COUNT(*) AS count
              FROM sales s JOIN customers c ON c.id = s.customer_id WHERE {where}
             GROUP BY s.customer_id ORDER BY total DESC, c.name COLLATE NOCASE LIMIT ?""", [*p, limit])

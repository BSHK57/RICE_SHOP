"""Dashboard + reports: totals, masking, permission-gated widgets, CSV export."""
import csv
import io

import pytest

from app import db


def api(client, method, url, body=None, status=None):
    r = client.get(url) if method == "get" else getattr(client, method)(url, json=body)
    js = r.get_json()
    if status is not None:
        assert r.status_code == status, js
    return js["data"] if js and js.get("ok") else js


@pytest.fixture
def shop(anand):
    api(anand, "post", "/api/inventory/rice-types",
        {"type_name": "Ponni", "price_per_kg": 60, "bag_price": 1450, "bag_size_grams": 25000,
         "purchase_cost_per_kg": 50, "bags_qty": 5, "loose_grams": 10000, "low_stock_bags": 10}, 201)
    cid = api(anand, "post", "/api/customers", {"name": "=HYPERLINK(evil)"}, 201)["id"]
    today = db.today_str()
    api(anand, "post", "/api/sales/retail", {"payment_mode": "cash", "items": [
        {"rice_type": "Ponni", "item_kind": "loose", "grams": 2000, "unit_price": 50}]}, 201)        # 100 / list 120
    api(anand, "post", "/api/sales/retail", {"payment_mode": "upi", "customer_id": cid, "items": [
        {"rice_type": "Ponni", "item_kind": "bag", "bags": 1}]}, 201)                                 # 1450
    api(anand, "post", "/api/sales/wholesale", {"customer_id": cid, "payment_mode": "credit", "sent_on": today,
                                                "items": [{"rice_type": "Kolam", "item_kind": "bag", "bags": 2,
                                                           "bag_size_grams": 26000, "unit_price": 1000}]}, 201)
    return anand


def test_summary_exact_totals(shop):
    s = api(shop, "get", "/api/reports/summary", status=200)
    t = s["totals"]
    assert s["view"] == "exact"
    assert (t["total"], t["count"], t["cash"], t["upi"], t["credit"]) == (3550, 3, 100, 1450, 2000)
    assert (t["bags"], t["loose_grams"], t["discount"]) == (3, 2000, 20)
    assert t["profit"] == (100 - 100) + (1450 - 1250)  # wholesale Kolam has no known cost
    assert sum(d["total"] for d in s["by_day"]) == 3550
    rice = {r["rice_type"]: r for r in s["by_rice"]}
    assert rice["Ponni"]["amount"] == 1550 and rice["Kolam"]["bags"] == 2
    assert {m["mode"]: m["total"] for m in s["by_payment_mode"]} == {"cash": 100, "upi": 1450, "credit": 2000}
    assert s["top_customers"][0]["total"] == 3450
    retail_only = api(shop, "get", "/api/reports/summary?channel=retail")["totals"]
    assert retail_only["total"] == 1550 and retail_only["count"] == 2


def test_summary_masked_without_original_view(app, shop, make_client):
    # a reports user without original:view / wholesale:view
    with app.app_context():
        db.execute("INSERT INTO app_users(username, display_name, password_hash, permissions, created_at) "
                   "VALUES ('rep','Rep','x','[\"reports:view\",\"dashboard:view\",\"retail:view\"]','2026-01-01')")
    rep = make_client("rep")
    s = api(rep, "get", "/api/reports/summary", status=200)
    assert s["view"] == "masked" and s["totals"]["total"] == 120 + 1450 and s["totals"]["count"] == 2
    assert "discount" not in s["totals"] and "profit" not in s["totals"]
    assert all("profit" not in r for r in s["by_day"] + s["by_rice"])
    body = rep.get("/api/reports/sales.csv").get_data(as_text=True)
    assert "Profit" not in body and "Discount" not in body


def test_csv_export(shop):
    r = shop.get("/api/reports/sales.csv")
    assert r.status_code == 200 and r.mimetype == "text/csv"
    assert "attachment" in r.headers["Content-Disposition"]
    rows = list(csv.reader(io.StringIO(r.get_data(as_text=True).lstrip("﻿"))))
    assert rows[0][0] == "Sale #" and "Profit" in rows[0] and len(rows) == 4
    customers = [row[3] for row in rows[1:] if row[3]]
    assert customers and all(c.startswith("'=") for c in customers)  # injection guard


def test_dashboard_widgets(shop, staff):
    d = api(shop, "get", "/api/dashboard", status=200)
    assert d["today"]["retail"]["total"] == 1550 and d["today"]["wholesale"]["total"] == 2000
    assert d["credits"]["outstanding"] == 2000 and d["orders"]["pending"] == 0
    assert d["low_stock"][0]["type_name"] == "Ponni" and len(d["recent_sales"]) == 3

    s = api(staff, "get", "/api/dashboard", status=200)
    assert s["view"] == "masked"
    assert s["today"]["retail"]["total"] == 1570 and s["today"]["wholesale"] is None
    assert s["orders"] is None and s["low_stock"] is None
    assert s["credits"]["outstanding"] == 0  # wholesale credit hidden from staff
    assert all(ln["channel"] == "retail" and "discount" not in ln for ln in s["recent_sales"])


def test_reports_forbidden_for_staff(staff):
    api(staff, "get", "/api/reports/summary", status=403)
    assert staff.get("/api/reports/sales.csv").status_code == 403

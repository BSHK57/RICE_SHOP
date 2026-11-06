"""Credits: manual entries, payment bounds, FIFO lump sum, visibility, delete rules, overdue."""
import pytest

from app import db


def api(client, method, url, body=None, status=None):
    r = client.get(url) if method == "get" else getattr(client, method)(url, json=body)
    js = r.get_json()
    if status is not None:
        assert r.status_code == status, js
    return js["data"] if js and js.get("ok") else js


def customer(c, name="Ravi"):
    return api(c, "post", "/api/customers", {"name": name}, 201)["id"]


def manual(c, cid, amount, credit_date, channel="retail", **kw):
    return api(c, "post", "/api/credits/entries",
               {"customer_id": cid, "channel": channel, "amount": amount, "credit_date": credit_date, **kw}, 201)


@pytest.fixture
def cid(anand):
    return customer(anand)


def test_payment_bounds(anand, cid):
    e = manual(anand, cid, 500, "2026-10-01")
    assert e["status"] == "open" and e["balance"] == 500
    url = f"/api/credits/entries/{e['id']}/payments"
    assert "500" in api(anand, "post", url, {"amount": 501, "mode": "cash"}, 400)["error"]
    api(anand, "post", url, {"amount": 0, "mode": "cash"}, 400)
    api(anand, "post", url, {"amount": 10, "mode": "card"}, 400)
    r = api(anand, "post", url, {"amount": 200, "mode": "upi", "paid_on": "2026-10-05"}, 201)
    assert r["payment"]["amount"] == 200 and r["entry"]["balance"] == 300
    r = api(anand, "post", url, {"amount": 300, "mode": "cash"}, 201)
    assert r["entry"]["status"] == "settled"
    api(anand, "post", url, {"amount": 1, "mode": "cash"}, 400)
    assert api(anand, "get", "/api/credits/entries") == []
    assert len(api(anand, "get", "/api/credits/entries?status=settled")) == 1


def test_fifo_lump_sum(anand, cid):
    old = manual(anand, cid, 300, "2026-09-01")
    mid = manual(anand, cid, 400, "2026-09-15")
    new = manual(anand, cid, 500, "2026-10-01")
    url = f"/api/credits/customer/{cid}/payments"
    api(anand, "post", url, {"amount": 1201, "mode": "cash"}, 400)
    r = api(anand, "post", url, {"amount": 500, "mode": "cash"}, 201)
    assert [(p["credit_id"], p["amount"]) for p in r["payments"]] == [(old["id"], 300), (mid["id"], 200)]
    assert r["allocated"] == 500 and r["customer_balance"] == 700
    led = api(anand, "get", f"/api/credits/customer/{cid}", status=200)
    assert [e["balance"] for e in led["entries"]] == [0, 200, 500]
    assert led["summary"] == {"total_credit": 1200, "total_paid": 500, "balance": 700}
    assert len(led["entries"][1]["payments"]) == 1 and led["entries"][2]["id"] == new["id"]
    col = api(anand, "get", "/api/credits/collections", status=200)
    assert col["total"] == 500 and col["payments"][0]["channel"] == "retail"


def test_staff_records_payment_but_cannot_delete(anand, staff, cid):
    e = manual(anand, cid, 500, "2026-10-01")
    r = api(staff, "post", f"/api/credits/entries/{e['id']}/payments", {"amount": 100, "mode": "cash"}, 201)
    pid = r["payment"]["id"]
    api(staff, "delete", f"/api/credits/payments/{pid}", status=403)
    api(staff, "delete", f"/api/credits/entries/{e['id']}", status=403)
    r = api(anand, "delete", f"/api/credits/payments/{pid}", status=200)
    assert r["entry"]["balance"] == 500


def test_delete_entry_rules(anand, cid):
    e = manual(anand, cid, 500, "2026-10-01")
    p = api(anand, "post", f"/api/credits/entries/{e['id']}/payments", {"amount": 100, "mode": "cash"}, 201)
    api(anand, "delete", f"/api/credits/entries/{e['id']}", status=409)
    api(anand, "delete", f"/api/credits/payments/{p['payment']['id']}", status=200)
    api(anand, "delete", f"/api/credits/entries/{e['id']}", status=200)
    assert api(anand, "get", "/api/credits/entries?status=all") == []


def test_sale_credit_cannot_be_deleted_directly(anand, cid):
    api(anand, "post", "/api/inventory/rice-types",
        {"type_name": "Ponni", "price_per_kg": 60, "loose_grams": 10000}, 201)
    s = api(anand, "post", "/api/sales/retail", {"payment_mode": "credit", "customer_id": cid,
                                                 "items": [{"rice_type": "Ponni", "item_kind": "loose",
                                                            "grams": 1000}]}, 201)
    api(anand, "delete", f"/api/credits/entries/{s['credit_id']}", status=409)


def test_overdue_flag_and_summary(anand, cid):
    manual(anand, cid, 500, "2026-01-01", due_date="2026-01-31")
    manual(anand, cid, 200, "2026-02-01", due_date="2999-01-01")
    entries = api(anand, "get", "/api/credits/entries")
    assert {e["amount"]: e["overdue"] for e in entries} == {500: True, 200: False}
    bc = api(anand, "get", "/api/credits/by-customer", status=200)
    assert bc[0]["overdue"] is True and bc[0]["balance"] == 700 and bc[0]["next_due_date"] == "2026-01-31"
    s = api(anand, "get", "/api/credits/summary", status=200)
    assert s["outstanding_total"] == 700 and s["overdue_total"] == 500 and s["overdue_count"] == 1
    assert s["customers_with_balance"] == 1
    bd = api(anand, "get", "/api/credits/by-date?date_field=due_date", status=200)
    assert [g["date"] for g in bd] == ["2999-01-01", "2026-01-31"]


def test_edit_entry(anand, cid):
    e = manual(anand, cid, 500, "2026-10-01", due_date="2026-10-10")
    r = api(anand, "put", f"/api/credits/entries/{e['id']}", {"due_date": None, "notes": "old book"}, 200)
    assert r["due_date"] is None and r["notes"] == "old book"


def test_wholesale_credit_hidden_from_staff(anand, staff, cid):
    manual(anand, cid, 1000, "2026-10-01", channel="wholesale")
    manual(anand, cid, 300, "2026-10-02")
    assert len(api(anand, "get", "/api/credits/entries")) == 2
    rows = api(staff, "get", "/api/credits/entries", status=200)
    assert [r["channel"] for r in rows] == ["retail"]
    s = api(staff, "get", "/api/credits/summary", status=200)
    assert s["outstanding_total"] == 300 and s["outstanding_wholesale"] is None
    assert api(staff, "get", "/api/credits/by-customer")[0]["balance"] == 300
    assert api(staff, "get", f"/api/credits/customer/{cid}")["summary"]["balance"] == 300
    # staff cannot add wholesale credit, and a lump sum only touches visible (retail) entries
    api(staff, "post", "/api/credits/entries", {"customer_id": cid, "channel": "wholesale", "amount": 5}, 403)
    api(staff, "post", f"/api/credits/customer/{cid}/payments", {"amount": 301, "mode": "cash"}, 400)
    r = api(staff, "post", f"/api/credits/customer/{cid}/payments", {"amount": 300, "mode": "cash"}, 201)
    assert r["customer_balance"] == 0
    assert api(anand, "get", f"/api/credits/customer/{cid}")["summary"]["balance"] == 1000


def test_payment_written_with_audit(app, anand, cid):
    e = manual(anand, cid, 500, "2026-10-01")
    api(anand, "post", f"/api/credits/entries/{e['id']}/payments", {"amount": 100, "mode": "cash"}, 201)
    with app.app_context():
        assert db.query_value("SELECT COUNT(*) FROM audit_log WHERE action='payment'", default=0) == 1

"""Sales: retail pricing/stock/credit, masking, wholesale, void. Data is prepared through the real API."""
import pytest

from app import db


def api(client, method, url, body=None, status=None):
    r = getattr(client, method)(url, json=body) if body is not None or method != "get" else client.get(url)
    js = r.get_json()
    if status is not None:
        assert r.status_code == status, js
    return js["data"] if js and js.get("ok") else js


def add_type(c, name="Ponni", **kw):
    body = {"type_name": name, "price_per_kg": 60, "bag_price": 1450, "bag_size_grams": 25000,
            "purchase_cost_per_kg": 50, "bags_qty": 3, "loose_grams": 1000, **kw}
    return api(c, "post", "/api/inventory/rice-types", body, 201)


def add_customer(c, name="Ravi"):
    return api(c, "post", "/api/customers", {"name": name}, 201)["id"]


def stock(c, name="Ponni"):
    return next(t for t in api(c, "get", "/api/inventory/rice-types?include_inactive=1") if t["type_name"] == name)


def sale_count(app):
    with app.app_context():
        return db.query_value("SELECT COUNT(*) FROM sales", default=0)


def retail(c, items, status=201, **kw):
    return api(c, "post", "/api/sales/retail", {"payment_mode": "cash", "items": items, **kw}, status)


@pytest.fixture
def shop(anand):
    add_type(anand)
    return anand


# ------------------------------------------------------------------------- #
def test_cash_sale_deducts_stock(shop):
    s = retail(shop, [{"rice_type": "Ponni", "item_kind": "loose", "grams": 500}])
    assert s["total_amount"] == 30 and s["paid_amount"] == 30 and s["credit_amount"] == 0
    st = stock(shop)
    assert (st["bags_qty"], st["loose_grams"]) == (3, 500)
    retail(shop, [{"rice_type": "Ponni", "item_kind": "bag", "bags": 2}])
    assert stock(shop)["bags_qty"] == 1


def test_loose_sale_opens_bag_automatically(shop):
    retail(shop, [{"rice_type": "Ponni", "item_kind": "loose", "grams": 5000}])
    st = stock(shop)
    assert (st["bags_qty"], st["loose_grams"]) == (2, 21000)


def test_full_bag_quantity_becomes_bag_line(shop):
    s = retail(shop, [{"rice_type": "Ponni", "item_kind": "loose", "grams": 25000}])
    assert len(s["items"]) == 1
    line = s["items"][0]
    assert line["item_kind"] == "bag" and line["bags"] == 1 and line["amount"] == 1450
    st = stock(shop)
    assert (st["bags_qty"], st["loose_grams"]) == (2, 1000)


def test_split_with_override_carries_per_kg_price(shop):
    s = retail(shop, [{"rice_type": "Ponni", "item_kind": "loose", "grams": 27000, "unit_price": 55}])
    bag, loose = s["items"]
    assert bag["item_kind"] == "bag" and bag["unit_price"] == 1375 and bag["list_amount"] == 1450
    assert loose["grams"] == 2000 and loose["amount"] == 110 and loose["list_amount"] == 120
    assert s["total_amount"] == 1485 and s["list_total"] == 1570 and s["discount_total"] == 85
    assert s["cost_total"] == 1350 and s["profit_total"] == 135


def test_no_split_when_type_has_no_bag_price(anand):
    add_type(anand, "Raw", bag_price=None)
    s = retail(anand, [{"rice_type": "Raw", "item_kind": "loose", "grams": 26000}])
    assert [i["item_kind"] for i in s["items"]] == ["loose"] and s["total_amount"] == 1560


def test_insufficient_stock_is_409_and_nothing_written(app, shop):
    before = stock(shop)
    n = sale_count(app)
    # first line is fine, second impossible -> the whole sale must roll back
    r = retail(shop, [{"rice_type": "Ponni", "item_kind": "loose", "grams": 1000},
                      {"rice_type": "Ponni", "item_kind": "bag", "bags": 9}], status=409)
    assert r["code"] == "insufficient_stock"
    assert sale_count(app) == n
    after = stock(shop)
    assert (after["bags_qty"], after["loose_grams"]) == (before["bags_qty"], before["loose_grams"])
    with app.app_context():
        assert db.query_value("SELECT COUNT(*) FROM sale_items", default=0) == 0


def test_validation_errors(shop):
    assert retail(shop, [], status=400)["ok"] is False
    retail(shop, [{"rice_type": "Nope", "item_kind": "loose", "grams": 100}], status=400)
    retail(shop, [{"rice_type": "Ponni", "item_kind": "loose", "grams": 0}], status=400)
    retail(shop, [{"rice_type": "Ponni", "item_kind": "loose", "grams": 100}], status=400, payment_mode="card")


def test_credit_sale_creates_credit_entry_with_advance(shop):
    cid = add_customer(shop)
    s = retail(shop, [{"rice_type": "Ponni", "item_kind": "bag", "bags": 1}], payment_mode="credit",
               customer_id=cid, advance_paid=450, due_date="2099-01-01")
    assert s["paid_amount"] == 450 and s["credit_amount"] == 1000 and s["credit_id"]
    entries = api(shop, "get", f"/api/credits/entries?customer_id={cid}")
    assert len(entries) == 1 and entries[0]["amount"] == 1000 and entries[0]["sale_id"] == s["id"]
    assert entries[0]["due_date"] == "2099-01-01"


def test_credit_without_customer_is_400(shop):
    r = retail(shop, [{"rice_type": "Ponni", "item_kind": "bag", "bags": 1}], status=400, payment_mode="credit")
    assert "customer" in r["error"].lower()


def test_advance_must_be_below_total(shop):
    cid = add_customer(shop)
    retail(shop, [{"rice_type": "Ponni", "item_kind": "bag", "bags": 1}], status=400, payment_mode="credit",
           customer_id=cid, advance_paid=1450)


def test_masking_staff_sees_list_prices_only(shop, staff):
    retail(shop, [{"rice_type": "Ponni", "item_kind": "loose", "grams": 2000, "unit_price": 50}])
    exact = api(shop, "get", "/api/sales/retail")
    assert exact["view"] == "exact"
    assert exact["loose"][0]["amount"] == 100 and exact["loose"][0]["discount"] == 20
    assert exact["totals"]["total"] == 100 and exact["totals"]["discount"] == 20

    masked = api(staff, "get", "/api/sales/retail", status=200)
    assert masked["view"] == "masked"
    line = masked["loose"][0]
    assert line["amount"] == 120 and line["unit_price"] == 60
    for k in ("list_amount", "list_unit_price", "discount", "cost_amount", "profit"):
        assert k not in line
    sale = masked["sales"][0]
    assert sale["total_amount"] == 120
    for k in ("list_total", "discount_total", "cost_total", "profit_total"):
        assert k not in sale
    assert "discount" not in masked["totals"] and "profit" not in masked["totals"]
    assert masked["totals"]["total"] == 120 and masked["totals"]["cash"] == 120
    one = api(staff, "get", f"/api/sales/{sale['id']}", status=200)
    assert one["total_amount"] == 120 and "discount_total" not in one


def test_staff_forbidden(staff):
    api(staff, "post", "/api/sales/retail", {"payment_mode": "cash", "items": []}, 403)
    api(staff, "post", "/api/sales/retail/preview", {"items": []}, 403)
    api(staff, "get", "/api/sales/wholesale", status=403)
    api(staff, "post", "/api/sales/wholesale", {}, 403)
    api(staff, "get", "/api/sales/original", status=403)
    api(staff, "get", "/api/sales/wholesale/rice-names", status=403)


def test_preview_accumulates_stock_per_type(app, shop):
    n = sale_count(app)
    body = {"items": [{"rice_type": "Ponni", "item_kind": "bag", "bags": 2},
                      {"rice_type": "Ponni", "item_kind": "loose", "grams": 5000}]}
    p = api(shop, "post", "/api/sales/retail/preview", body, 200)
    assert p["stock_ok"] is True and p["total"] == 2 * 1450 + 300
    assert p["lines"][1]["opens_bags"] == 1
    body["items"][1]["grams"] = 30000  # 25 kg -> bag + 5 kg loose; now 3 bags + loose need 4 bags
    p = api(shop, "post", "/api/sales/retail/preview", body, 200)
    assert p["stock_ok"] is False and p["warnings"]
    assert p["lines"][1]["auto_split"] is True
    assert sale_count(app) == n and stock(shop)["bags_qty"] == 3


def test_wholesale_sale_new_name_no_stock_change(shop, staff):
    cid = add_customer(shop, "Hotel Saravana")
    before = stock(shop)
    s = api(shop, "post", "/api/sales/wholesale", {
        "customer_id": cid, "payment_mode": "cash", "sent_on": "2026-11-01", "call_received_on": "2026-10-30",
        "items": [{"rice_type": "Kolam Special", "item_kind": "bag", "bags": 10, "bag_size_grams": 26000,
                   "unit_price": 1300},
                  {"rice_type": "ponni", "item_kind": "loose", "grams": 2000, "unit_price": 55}]}, 201)
    assert s["channel"] == "wholesale" and s["sale_date"] == "2026-11-01" and s["total_amount"] == 13110
    assert s["items"][0]["cost_amount"] is None and s["items"][1]["cost_amount"] == 100
    assert s["items"][1]["rice_type"] == "Ponni"
    names = api(shop, "get", "/api/sales/wholesale/rice-names", status=200)
    assert "Kolam Special" in names and "Ponni" in names
    after = stock(shop)
    assert (after["bags_qty"], after["loose_grams"]) == (before["bags_qty"], before["loose_grams"])
    lst = api(shop, "get", "/api/sales/wholesale?from=2026-10-01&to=2026-11-30", status=200)
    assert lst["totals"]["count"] == 1 and lst["totals"]["bags"] == 10
    api(staff, "get", f"/api/sales/{s['id']}", status=403)


def test_wholesale_requires_customer_and_price(shop):
    item = {"rice_type": "X", "item_kind": "bag", "bags": 1, "bag_size_grams": 25000, "unit_price": 1000}
    api(shop, "post", "/api/sales/wholesale", {"payment_mode": "cash", "items": [item]}, 400)
    cid = add_customer(shop)
    api(shop, "post", "/api/sales/wholesale",
        {"customer_id": cid, "payment_mode": "cash", "items": [{**item, "unit_price": None}]}, 400)


def test_void_restores_stock_and_voids_credit(shop):
    cid = add_customer(shop)
    s = retail(shop, [{"rice_type": "Ponni", "item_kind": "loose", "grams": 5000}], payment_mode="credit",
               customer_id=cid)
    assert stock(shop)["bags_qty"] == 2
    v = api(shop, "post", f"/api/sales/{s['id']}/void", {"reason": "wrong entry"}, 200)
    assert v["status"] == "void" and v["void_reason"] == "wrong entry"
    st = stock(shop)
    assert (st["bags_qty"], st["loose_grams"]) == (3, 1000)
    assert api(shop, "get", "/api/credits/entries?status=all") == []
    assert api(shop, "get", "/api/sales/retail")["totals"]["count"] == 0
    api(shop, "post", f"/api/sales/{s['id']}/void", {}, 409)


def test_void_blocked_when_credit_has_payments(app, shop):
    cid = add_customer(shop)
    s = retail(shop, [{"rice_type": "Ponni", "item_kind": "bag", "bags": 1}], payment_mode="credit", customer_id=cid)
    api(shop, "post", f"/api/credits/entries/{s['credit_id']}/payments", {"amount": 100, "mode": "cash"}, 201)
    r = api(shop, "post", f"/api/sales/{s['id']}/void", {}, 409)
    assert "payment" in r["error"].lower()
    # rolled back: stock not restored, sale still active, credit still active
    assert stock(shop)["bags_qty"] == 2
    assert api(shop, "get", f"/api/sales/{s['id']}")["status"] == "active"
    assert api(shop, "get", "/api/credits/entries")[0]["balance"] == 1350
    with app.app_context():
        assert db.query_value("SELECT COUNT(*) FROM stock_movements WHERE kind='sale_void'", default=0) == 0


def test_staff_cannot_void(shop, staff):
    s = retail(shop, [{"rice_type": "Ponni", "item_kind": "loose", "grams": 100}])
    api(staff, "post", f"/api/sales/{s['id']}/void", {}, 403)


def test_original_sales_exact(shop):
    retail(shop, [{"rice_type": "Ponni", "item_kind": "loose", "grams": 2000, "unit_price": 50}])
    o = api(shop, "get", "/api/sales/original", status=200)
    assert o["view"] == "exact" and o["rows"][0]["discount"] == 20 and o["rows"][0]["profit"] == 0
    assert o["totals"] == {"total": 100, "list_total": 120, "discount": 20, "cost": 100, "profit": 0, "count": 1}


def test_customer_detail_purchases_masked(shop, staff):
    cid = add_customer(shop)
    retail(shop, [{"rice_type": "Ponni", "item_kind": "loose", "grams": 2000, "unit_price": 50}], customer_id=cid)
    d = api(staff, "get", f"/api/customers/{cid}", status=200)
    assert d["purchases"][0]["total_amount"] == 120 and "discount_total" not in d["purchases"][0]

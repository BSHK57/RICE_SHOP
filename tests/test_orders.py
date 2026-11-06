"""Reminders / pending orders: create, edit, cancel, fulfil into retail and wholesale sales."""
import pytest


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
         "bags_qty": 3, "loose_grams": 1000}, 201)
    cid = api(anand, "post", "/api/customers", {"name": "Ravi"}, 201)["id"]
    return anand, cid


def order(c, cid, channel="retail", items=None, requested_for="2026-11-06T10:30", status=201):
    items = items or [{"rice_type": "Ponni", "item_kind": "bag", "bags": 1},
                      {"rice_type": "Ponni", "item_kind": "loose", "grams": 2000}]
    return api(c, "post", "/api/orders", {"channel": channel, "customer_id": cid, "requested_for": requested_for,
                                          "items": items}, status)


def test_create_retail_order_no_stock_change(shop):
    c, cid = shop
    o = order(c, cid)
    assert o["status"] == "pending" and o["requested_for"] == "2026-11-06 10:30"
    assert o["items"][0]["bag_size_grams"] == 25000 and o["items"][0]["quantity_label"] == "1 bag × 25 kg"
    assert api(c, "get", "/api/inventory/rice-types")[0]["bags_qty"] == 3
    order(c, cid, items=[{"rice_type": "Nope", "item_kind": "bag", "bags": 1}], status=400)
    order(c, cid, requested_for="tomorrow", status=400)


def test_fulfill_retail_credit_blank_amount(shop):
    c, cid = shop
    o = order(c, cid)
    r = api(c, "post", f"/api/orders/{o['id']}/fulfill",
            {"sent_date": "2026-11-04", "payment_mode": "credit", "credit_amount": None}, 200)
    sale = r["sale"]
    assert r["order"]["status"] == "sent" and r["order"]["sale_id"] == sale["id"] and r["order"]["closed_at"]
    assert sale["sale_date"] == "2026-11-04" and sale["total_amount"] == 1570
    assert sale["paid_amount"] == 0 and sale["credit_amount"] == 1570 and sale["source_order_id"] == o["id"]
    day = api(c, "get", "/api/sales/retail?date=2026-11-04")
    assert day["totals"]["count"] == 1 and day["totals"]["credit"] == 1570
    st = api(c, "get", "/api/inventory/rice-types")[0]
    assert (st["bags_qty"], st["loose_grams"]) == (1, 24000)  # 1 bag sold + 1 opened for 2 kg loose
    assert api(c, "get", "/api/credits/entries")[0]["amount"] == 1570
    api(c, "post", f"/api/orders/{o['id']}/fulfill", {"payment_mode": "cash"}, 409)


def test_fulfill_credit_amount_sets_advance(shop):
    c, cid = shop
    o = order(c, cid)
    sale = api(c, "post", f"/api/orders/{o['id']}/fulfill",
               {"sent_date": "2026-11-05", "payment_mode": "credit", "credit_amount": 1000}, 200)["sale"]
    assert sale["paid_amount"] == 570 and sale["credit_amount"] == 1000


def test_fulfill_insufficient_stock_rolls_back(shop):
    c, cid = shop
    o = order(c, cid, items=[{"rice_type": "Ponni", "item_kind": "bag", "bags": 9}])
    api(c, "post", f"/api/orders/{o['id']}/fulfill", {"sent_date": "2026-11-05", "payment_mode": "cash"}, 409)
    assert api(c, "get", "/api/orders")[0]["status"] == "pending"
    assert api(c, "get", "/api/sales/retail")["totals"]["count"] == 0


def test_fulfill_wholesale_needs_prices(shop):
    c, cid = shop
    o = order(c, cid, channel="wholesale", items=[
        {"rice_type": "Kolam", "item_kind": "bag", "bags": 5, "bag_size_grams": 26000},
        {"rice_type": "Kolam", "item_kind": "bag", "bags": 1, "bag_size_grams": 26000, "unit_price": 1200}])
    url = f"/api/orders/{o['id']}/fulfill"
    api(c, "post", url, {"sent_date": "2026-11-03", "payment_mode": "cash"}, 400)
    first = o["items"][0]["id"]
    r = api(c, "post", url, {"sent_date": "2026-11-03", "payment_mode": "upi",
                             "item_prices": {str(first): 1250}}, 200)
    assert r["sale"]["channel"] == "wholesale" and r["sale"]["sale_date"] == "2026-11-03"
    assert r["sale"]["total_amount"] == 5 * 1250 + 1200
    ws = api(c, "get", "/api/sales/wholesale?from=2026-11-01&to=2026-11-05")
    assert ws["totals"]["count"] == 1 and ws["totals"]["upi"] == 7450
    assert api(c, "get", "/api/sales/retail?date=2026-11-03")["totals"]["count"] == 0
    assert api(c, "get", "/api/inventory/rice-types")[0]["bags_qty"] == 3


def test_update_cancel_and_summary(shop):
    c, cid = shop
    o = order(c, cid, requested_for="2020-01-01 09:00")
    later = order(c, cid, requested_for="2999-01-01 09:00")
    s = api(c, "get", "/api/orders/summary", status=200)
    assert s == {"pending": 2, "overdue": 1, "next_due": "2999-01-01 09:00"}
    assert [x["id"] for x in api(c, "get", "/api/orders")] == [o["id"], later["id"]]
    assert api(c, "get", "/api/orders")[0]["overdue"] is True
    u = api(c, "put", f"/api/orders/{o['id']}", {"channel": "retail", "customer_id": cid,
                                                 "requested_for": "2999-02-01 09:00",
                                                 "items": [{"rice_type": "Ponni", "item_kind": "loose",
                                                            "grams": 500}]}, 200)
    assert len(u["items"]) == 1 and u["overdue"] is False
    assert api(c, "post", f"/api/orders/{o['id']}/cancel", {}, 200)["status"] == "cancelled"
    api(c, "put", f"/api/orders/{o['id']}", {"channel": "retail", "customer_id": cid,
                                             "requested_for": "2999-02-01 09:00",
                                             "items": [{"rice_type": "Ponni", "item_kind": "loose", "grams": 1}]},
        409)
    assert api(c, "get", "/api/orders/summary")["pending"] == 1
    assert len(api(c, "get", "/api/orders?status=all")) == 2


def test_staff_has_no_orders_access(shop, staff):
    c, cid = shop
    order(c, cid, channel="wholesale", items=[{"rice_type": "Kolam", "item_kind": "bag", "bags": 1,
                                               "bag_size_grams": 26000}])
    api(staff, "get", "/api/orders/summary", status=403)
    api(staff, "post", "/api/orders", {}, 403)

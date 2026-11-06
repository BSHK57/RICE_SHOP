"""Regression tests for issues found in the security audit."""
import pytest


def _seed(anand):
    anand.post("/api/customers", json={"name": "Ravi"})
    anand.post("/api/inventory/rice-types", json={"type_name": "Sona", "price_per_kg": 60, "bag_price": 1500,
                                                  "bag_size_grams": 25000, "bags_qty": 4, "loose_grams": 10000})


def test_staff_cannot_infer_discount_from_paid_amount(anand, staff):
    _seed(anand)
    r = anand.post("/api/sales/retail", json={"payment_mode": "cash",
                   "items": [{"rice_type": "Sona", "item_kind": "loose", "grams": 10000, "unit_price": 50}]})
    assert r.status_code == 201
    sale = staff.get("/api/sales/retail").get_json()["data"]["sales"][0]
    assert sale["total_amount"] == 600 and sale["paid_amount"] == 600 and sale["credit_amount"] == 0
    exact = anand.get("/api/sales/retail").get_json()["data"]["sales"][0]
    assert exact["total_amount"] == 500 and exact["discount_total"] == 100


def test_masked_credit_sale_adds_up_to_list_total(anand, staff):
    _seed(anand)
    cid = anand.get("/api/customers").get_json()["data"][0]["id"]
    anand.post("/api/sales/retail", json={"payment_mode": "credit", "customer_id": cid, "advance_paid": 100,
               "items": [{"rice_type": "Sona", "item_kind": "loose", "grams": 10000, "unit_price": 50}]})
    s = staff.get("/api/sales/retail").get_json()["data"]["sales"][0]
    assert s["credit_amount"] == 400 and s["paid_amount"] + s["credit_amount"] == s["total_amount"] == 600


@pytest.mark.parametrize("bad", [float("inf"), 1e30, "inf", "1e999", float("nan"), 10**12])
def test_absurd_numbers_are_400_not_500(anand, bad):
    _seed(anand)
    for path, body in [
        ("/api/inventory/rice-types", {"type_name": "X", "price_per_kg": bad}),
        ("/api/inventory/rice-types/Sona/receive", {"bags": bad}),
        ("/api/sales/retail", {"payment_mode": "cash", "items": [{"rice_type": "Sona", "item_kind": "bag", "bags": bad}]}),
    ]:
        r = anand.post(path, json=body) if bad == bad else anand.post(path, data=str(body).replace("nan", "NaN"),
                                                                       content_type="application/json")
        assert r.status_code in (400, 409), (path, bad, r.status_code)


def test_huge_url_id_is_not_500(anand):
    assert anand.get("/api/customers/99999999999999999999").status_code in (400, 404)


def test_anonymous_write_is_401(app):
    assert app.test_client().post("/api/customers", json={"name": "x"}).status_code == 401


def test_unicode_digit_date_rejected(anand):
    assert anand.get("/api/sales/retail?date=２０２６-01-01").status_code == 400


def test_reports_need_retail_view(make_client, admin):
    admin.post("/api/users", json={"username": "repo", "display_name": "Repo", "password": "secret1",
                                   "permissions": ["reports:view"]})
    c = make_client("repo")
    data = c.get("/api/reports/summary").get_json()["data"]
    assert data["totals"]["count"] == 0


def test_order_agreed_price_hidden_without_original_view(make_client, admin, anand):
    _seed(anand)
    cid = anand.get("/api/customers").get_json()["data"][0]["id"]
    anand.post("/api/orders", json={"channel": "retail", "customer_id": cid, "requested_for": "2030-01-01 10:00",
               "items": [{"rice_type": "Sona", "item_kind": "loose", "grams": 1000, "unit_price": 40}]})
    admin.post("/api/users", json={"username": "ord", "display_name": "Ord", "password": "secret1",
                                   "permissions": ["orders:view", "retail:view"]})
    item = make_client("ord").get("/api/orders").get_json()["data"][0]["items"][0]
    assert item["unit_price"] is None
    assert anand.get("/api/orders").get_json()["data"][0]["items"][0]["unit_price"] == 40.0

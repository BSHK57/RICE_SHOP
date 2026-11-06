"""Retail stock (app/inventory): API behaviour and the service functions sales relies on."""
from urllib.parse import quote

import pytest

from app import db
from app.auth.permissions import User
from app.inventory import service
from app.utils.calc import StockError

BASE = "/api/inventory/rice-types"
SONA = {"type_name": "Sona Masoori", "price_per_kg": 62.5, "bag_price": 1500, "bag_size_grams": 25000,
        "purchase_cost_per_kg": 50, "bags_qty": 3, "loose_grams": 1000, "low_stock_bags": 2}


def url(name, tail=""):
    return f"{BASE}/{quote(name)}{tail}"


def create(client, **over):
    return client.post(BASE, json={**SONA, **over})


def get_type(client, name="Sona Masoori"):
    return [r for r in client.get(BASE).get_json()["data"] if r["type_name"] == name][0]


def movements(client, **params):
    return client.get("/api/inventory/movements", query_string=params).get_json()["data"]


# -------------------------------- API ------------------------------------- #
def test_create_and_list(anand):
    r = create(anand)
    assert r.status_code == 201
    rt = r.get_json()["data"]
    assert rt["bags_qty"] == 3 and rt["loose_grams"] == 1000 and rt["is_active"] is True
    assert rt["purchase_cost_per_kg"] == 50 and rt["updated_by"] == "anand"
    create(anand, type_name="Basmati", bag_price=None, bag_size_grams=None, bags_qty=0, loose_grams=0)
    names = [x["type_name"] for x in anand.get(BASE).get_json()["data"]]
    assert names == ["Basmati", "Sona Masoori"]
    m = movements(anand, type_name="sona masoori")
    assert len(m) == 1 and m[0]["kind"] == "create" and (m[0]["bags_after"], m[0]["loose_after"]) == (3, 1000)


def test_create_duplicate_case_insensitive(anand):
    create(anand)
    r = create(anand, type_name="sona MASOORI")
    assert r.status_code == 409 and "Sona Masoori" in r.get_json()["error"]


@pytest.mark.parametrize("over,fragment", [
    ({"type_name": ""}, "Type name"),
    ({"type_name": "x" * 61}, "too long"),
    ({"price_per_kg": None}, "Price per kg"),
    ({"price_per_kg": -1}, "negative"),
    ({"bag_price": -5}, "negative"),
    ({"bag_size_grams": 0}, "at least 1"),
    ({"bag_size_grams": None}, "bag size"),            # bag_price + bags_qty need a size
    ({"bag_size_grams": None, "bag_price": None}, "bag size"),   # bags_qty > 0 needs a size
    ({"bags_qty": -1}, "at least 0"),
    ({"loose_grams": 1.5}, "whole number"),
])
def test_create_validation(anand, over, fragment):
    r = create(anand, **over)
    assert r.status_code == 400 and fragment in r.get_json()["error"], r.get_json()


def test_create_without_bags_needs_no_bag_size(anand):
    assert create(anand, bag_size_grams=None, bag_price=None, bags_qty=0).status_code == 201


def test_purchase_cost_visibility(app, admin, anand):
    create(anand)
    assert get_type(anand)["purchase_cost_per_kg"] == 50
    # inventory:view without edit/original -> hidden
    admin.post("/api/users", json={"username": "viewer", "password": "secret1", "permissions": ["inventory:view"]})
    c = app.test_client()
    c.post("/api/auth/login", json={"username": "viewer", "password": "secret1"})
    assert "purchase_cost_per_kg" not in get_type(c)
    # original:view alone (no inventory perms) cannot list; plus inventory:view -> visible
    admin.post("/api/users", json={"username": "owner2", "password": "secret1",
                                   "permissions": ["inventory:view", "original:view"]})
    c2 = app.test_client()
    c2.post("/api/auth/login", json={"username": "owner2", "password": "secret1"})
    assert get_type(c2)["purchase_cost_per_kg"] == 50


def test_staff_cannot_use_inventory(staff, anand):
    create(anand)
    assert staff.get(BASE).status_code == 403              # staff preset has no inventory/retail:edit
    assert staff.get("/api/inventory/movements").status_code == 403
    assert staff.post(BASE, json=SONA).status_code == 403
    assert staff.put(url("Sona Masoori"), json={"price_per_kg": 1}).status_code == 403
    assert staff.post(url("Sona Masoori", "/receive"), json={"bags": 1}).status_code == 403
    assert staff.post(url("Sona Masoori", "/adjust"), json={"bags_delta": 1, "note": "x"}).status_code == 403
    assert staff.post(url("Sona Masoori", "/open-bag"), json={}).status_code == 403


def test_not_logged_in(app):
    assert app.test_client().get(BASE).status_code == 401


def test_retail_editor_can_list_but_not_write(app, admin, anand):
    create(anand)
    admin.post("/api/users", json={"username": "cashier", "password": "secret1", "permissions": ["retail:edit"]})
    c = app.test_client()
    tok = c.post("/api/auth/login", json={"username": "cashier", "password": "secret1"}).get_json()["data"]["csrf"]
    assert c.get(BASE).status_code == 200
    assert c.post(BASE, json=SONA, headers={"X-CSRF-Token": tok}).status_code == 403


def test_update_prices_not_stock(anand):
    create(anand)
    r = anand.put(url("Sona Masoori"), json={"price_per_kg": 65, "bag_price": None, "low_stock_bags": 1,
                                             "bags_qty": 99})
    assert r.status_code == 200
    rt = r.get_json()["data"]
    assert rt["price_per_kg"] == 65 and rt["bag_price"] is None and rt["low_stock_bags"] == 1
    assert rt["bags_qty"] == 3                                   # stock fields ignored
    assert anand.put(url("Sona Masoori"), json={}).status_code == 400
    assert anand.put(url("Nope"), json={"price_per_kg": 1}).status_code == 404
    assert anand.put(url("Sona Masoori"), json={"price_per_kg": -1}).status_code == 400
    off = anand.put(url("Sona Masoori"), json={"is_active": False}).get_json()["data"]
    assert off["is_active"] is False
    assert [r["type_name"] for r in anand.get(BASE).get_json()["data"]] == []
    assert len(anand.get(BASE + "?include_inactive=1").get_json()["data"]) == 1


def test_update_bag_size_conflict(anand):
    create(anand)
    r = anand.put(url("Sona Masoori"), json={"bag_size_grams": 26000})
    assert r.status_code == 409
    assert anand.put(url("Sona Masoori"), json={"bag_size_grams": 25000}).status_code == 200   # unchanged is fine
    create(anand, type_name="Empty", bags_qty=0)
    assert anand.put(url("Empty"), json={"bag_size_grams": 26000}).get_json()["data"]["bag_size_grams"] == 26000


def test_receive_stock(anand):
    create(anand)
    r = anand.post(url("Sona Masoori", "/receive"),
                   json={"bags": 4, "loose_grams": 500, "price_per_kg": 66, "purchase_cost_per_kg": 52, "note": "lorry 1"})
    assert r.status_code == 200
    rt = r.get_json()["data"]
    assert (rt["bags_qty"], rt["loose_grams"], rt["price_per_kg"], rt["purchase_cost_per_kg"]) == (7, 1500, 66, 52)
    m = movements(anand)[0]
    assert (m["kind"], m["delta_bags"], m["delta_loose_grams"], m["bags_after"], m["loose_after"], m["note"]) == \
           ("receive", 4, 500, 7, 1500, "lorry 1")


def test_receive_errors(anand):
    create(anand)
    p = url("Sona Masoori", "/receive")
    assert anand.post(p, json={}).status_code == 400
    assert anand.post(p, json={"bags": -1}).status_code == 400
    bad = anand.post(p, json={"bags": 1, "bag_size_grams": 26000})
    assert bad.status_code == 409 and bad.get_json()["code"] == "bag_size_conflict"
    assert anand.post(p, json={"bags": 1, "bag_size_grams": 25000}).status_code == 200      # same size ok
    assert anand.post(url("Nope", "/receive"), json={"bags": 1}).status_code == 404


def test_receive_new_bag_size_allowed_when_no_bags(anand):
    create(anand, bags_qty=0)
    r = anand.post(url("Sona Masoori", "/receive"), json={"bags": 2, "bag_size_grams": 26000})
    assert r.status_code == 200 and r.get_json()["data"]["bag_size_grams"] == 26000
    create(anand, type_name="Loose Only", bag_size_grams=None, bag_price=None, bags_qty=0)
    assert anand.post(url("Loose Only", "/receive"), json={"bags": 1}).status_code == 400   # needs size
    assert anand.post(url("Loose Only", "/receive"), json={"loose_grams": 5000}).status_code == 200


def test_adjust(anand):
    create(anand)
    p = url("Sona Masoori", "/adjust")
    r = anand.post(p, json={"bags_delta": -1, "loose_grams_delta": 250, "note": "stock take"})
    rt = r.get_json()["data"]
    assert (rt["bags_qty"], rt["loose_grams"]) == (2, 1250)
    m = movements(anand)[0]
    assert m["kind"] == "adjust" and m["note"] == "stock take" and (m["bags_after"], m["loose_after"]) == (2, 1250)
    assert anand.post(p, json={"bags_delta": 1}).status_code == 400                       # note required
    assert anand.post(p, json={"note": "x"}).status_code == 400                           # nothing changed
    neg = anand.post(p, json={"bags_delta": -5, "note": "x"})
    assert neg.status_code == 409 and neg.get_json()["code"] == "insufficient_stock"
    assert anand.post(p, json={"loose_grams_delta": -5000, "note": "x"}).status_code == 409
    assert get_type(anand)["bags_qty"] == 2                                               # unchanged after refusals


def test_open_bag(anand):
    create(anand)
    p = url("Sona Masoori", "/open-bag")
    rt = anand.post(p, json={}).get_json()["data"]
    assert (rt["bags_qty"], rt["loose_grams"]) == (2, 26000)
    rt = anand.post(p, json={"count": 2}).get_json()["data"]
    assert (rt["bags_qty"], rt["loose_grams"]) == (0, 76000)
    assert anand.post(p, json={}).status_code == 409                                      # none left
    m = movements(anand)[0]
    assert (m["kind"], m["delta_bags"], m["delta_loose_grams"]) == ("open_bag", -2, 50000)
    create(anand, type_name="NoSize", bag_size_grams=None, bag_price=None, bags_qty=0)
    assert anand.post(url("NoSize", "/open-bag"), json={}).status_code == 409


def test_movements_filter_limit(anand):
    create(anand)
    create(anand, type_name="Basmati")
    for _ in range(3):
        anand.post(url("Basmati", "/open-bag"), json={})
    assert len(movements(anand)) == 5
    assert len(movements(anand, type_name="Basmati")) == 4
    assert len(movements(anand, limit=2)) == 2
    assert movements(anand)[0]["id"] > movements(anand)[-1]["id"]                         # newest first
    assert anand.get("/api/inventory/movements?limit=abc").status_code == 400


def test_low_stock_list(app, anand):
    create(anand)                                         # 3 bags, threshold 2 -> not low
    create(anand, type_name="Ponni", bags_qty=2, low_stock_bags=2)
    create(anand, type_name="Idli", bags_qty=0, low_stock_bags=0)       # no threshold -> never listed
    with app.app_context():
        assert [r["type_name"] for r in service.low_stock_list()] == ["Ponni"]
        assert "purchase_cost_per_kg" not in service.low_stock_list()[0]   # no request context -> hidden


# ----------------------- service functions used by sales -------------------- #
@pytest.fixture
def stocked(app, anand):
    """Sona Masoori: 3 bags of 25 kg + 1 kg loose."""
    create(anand)
    return app


USER = User(username="anand", display_name="Anand", permissions=frozenset())


def stock(name="Sona Masoori"):
    rt = service.get_rice_type(name)
    return rt["bags_qty"], rt["loose_grams"]


def moves(sale_id):
    return db.query_all("SELECT kind, delta_bags, delta_loose_grams, bags_after, loose_after, sale_id "
                        "FROM stock_movements WHERE sale_id = ? ORDER BY id", (sale_id,))


def test_get_rice_type_raw(stocked):
    with stocked.app_context():
        rt = service.get_rice_type("sona masoori")
        assert rt["type_name"] == "Sona Masoori" and rt["purchase_cost_per_kg"] == 50
        assert service.get_rice_type("Nope") is None
        assert service.get_rice_type("Sona Masoori", for_update=True)["bags_qty"] == 3


def test_deduct_loose_from_open_stock_logs_one_movement(stocked):
    with stocked.app_context(), db.transaction():
        res = service.deduct_for_sale("Sona Masoori", "loose", 400, 0, 11, USER)
        assert res["bags_opened"] == 0 and stock() == (3, 600)
        assert [m["kind"] for m in moves(11)] == ["sale"]


def test_deduct_loose_opens_bags_automatically(stocked):
    with stocked.app_context(), db.transaction():
        res = service.deduct_for_sale("Sona Masoori", "loose", 5000, 0, 12, USER)
        assert res == {"type_name": "Sona Masoori", "bags_opened": 1, "bags_after": 2, "loose_after": 21000}
        assert stock() == (2, 21000)
        m = moves(12)
        assert [x["kind"] for x in m] == ["open_bag", "sale"]
        assert (m[0]["delta_bags"], m[0]["delta_loose_grams"], m[0]["bags_after"], m[0]["loose_after"]) == (-1, 25000, 2, 26000)
        assert (m[1]["delta_bags"], m[1]["delta_loose_grams"], m[1]["bags_after"], m[1]["loose_after"]) == (0, -5000, 2, 21000)


def test_deduct_opens_several_bags(stocked):
    with stocked.app_context(), db.transaction():
        service.deduct_for_sale("Sona Masoori", "loose", 60000, 0, 13, USER)
        assert stock() == (0, 16000)
        assert moves(13)[0]["delta_bags"] == -3


def test_deduct_bags(stocked):
    with stocked.app_context(), db.transaction():
        service.deduct_for_sale("Sona Masoori", "bag", 0, 2, 14, "anand")
        assert stock() == (1, 1000)
        m = moves(14)
        assert [(x["kind"], x["delta_bags"], x["delta_loose_grams"]) for x in m] == [("sale", -2, 0)]


def test_insufficient_stock_raises_and_changes_nothing(stocked):
    with stocked.app_context():
        with pytest.raises(StockError):
            with db.transaction():
                service.deduct_for_sale("Sona Masoori", "bag", 0, 4, 15, USER)
        with pytest.raises(StockError):
            with db.transaction():
                service.deduct_for_sale("Sona Masoori", "loose", 76001, 0, 15, USER)
        with pytest.raises(StockError):                               # first line fine, second fails -> rollback
            with db.transaction():
                service.deduct_for_sale("Sona Masoori", "bag", 0, 1, 16, USER)
                service.deduct_for_sale("Sona Masoori", "bag", 0, 5, 16, USER)
        assert stock() == (3, 1000) and moves(15) == [] and moves(16) == []


def test_deduct_loose_needs_bag_size_to_open(app, anand):
    create(anand, type_name="Raw", bag_size_grams=None, bag_price=None, bags_qty=0, loose_grams=500)
    with app.app_context(), pytest.raises(StockError):
        with db.transaction():
            service.deduct_for_sale("Raw", "loose", 600, 0, 17, USER)


def test_deduct_unknown_type(stocked):
    from app.utils.common import ApiError
    with stocked.app_context(), pytest.raises(ApiError):
        with db.transaction():
            service.deduct_for_sale("Nope", "bag", 0, 1, 18, USER)


def test_restore_reverses_exactly(stocked):
    with stocked.app_context():
        with db.transaction():
            service.deduct_for_sale("Sona Masoori", "loose", 5000, 0, 20, USER)      # opens 1 bag
            service.deduct_for_sale("Sona Masoori", "bag", 0, 1, 20, USER)
            service.deduct_for_sale("Sona Masoori", "loose", 100, 0, 21, USER)       # another sale, untouched
        assert stock() == (1, 20900)
        with db.transaction():
            service.restore_for_sale(20, USER)
        assert stock() == (3, 1000 - 100)                                             # sale 21's 100 g still gone
        void = [m for m in moves(20) if m["kind"] == "sale_void"]
        assert len(void) == 1 and void[0]["sale_id"] == 20
        assert (void[0]["delta_bags"], void[0]["delta_loose_grams"]) == (2, -20000)
        assert (void[0]["bags_after"], void[0]["loose_after"]) == (3, 900)
        with db.transaction():
            service.restore_for_sale(20, USER)                                        # idempotent
        assert stock() == (3, 900)
        with db.transaction():
            service.restore_for_sale(999, USER)                                       # unknown sale: no-op
        assert stock() == (3, 900)


def test_restore_when_opened_loose_was_sold_since(stocked):
    """Exact reversal would need negative loose stock -> the sold grams go back as loose instead."""
    with stocked.app_context(), db.transaction():
        service.deduct_for_sale("Sona Masoori", "loose", 5000, 0, 30, USER)          # (2, 21000)
        service.deduct_for_sale("Sona Masoori", "loose", 20000, 0, 31, USER)         # (2, 1000)
        service.restore_for_sale(30, USER)
        assert stock() == (2, 6000)
        assert all(v >= 0 for v in stock())


def test_check_availability(stocked):
    with stocked.app_context():
        chk = service.check_availability
        assert chk("Sona Masoori", "loose", 500, 0) == {"ok": True, "message": "", "bags_opened": 0}
        assert chk("Sona Masoori", "loose", 5000, 0)["bags_opened"] == 1
        assert chk("Sona Masoori", "bag", 0, 3)["ok"] is True
        bad = chk("Sona Masoori", "bag", 0, 4)
        assert bad["ok"] is False and "Not enough bags" in bad["message"]
        assert chk("Sona Masoori", "loose", 90000, 0)["ok"] is False
        assert chk("Nope", "bag", 0, 1)["ok"] is False
        assert stock() == (3, 1000)                                                   # read-only


def test_audit_entries_for_stock_changes(app, anand):
    create(anand)
    anand.post(url("Sona Masoori", "/receive"), json={"bags": 1})
    anand.post(url("Sona Masoori", "/adjust"), json={"bags_delta": -1, "note": "recount"})
    anand.post(url("Sona Masoori", "/open-bag"), json={})
    with app.app_context():
        actions = [r["action"] for r in db.query_all("SELECT action FROM audit_log ORDER BY id")]
        assert actions == ["inventory.create", "inventory.receive", "inventory.adjust", "inventory.open_bag"]

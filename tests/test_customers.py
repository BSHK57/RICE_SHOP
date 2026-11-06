"""Customer book (app/customers)."""
import pytest

from app import db
from app.auth import permissions
from app.customers import service
from app.utils.common import ApiError


def add(client, name, **extra):
    return client.post("/api/customers", json={"name": name, **extra})


def test_create_and_list_sorted(anand):
    r = add(anand, "  Ravi  ", phone="99999", place="Market", notes="pays Fridays")
    assert r.status_code == 201
    c = r.get_json()["data"]
    assert c["name"] == "Ravi" and c["phone"] == "99999" and c["is_active"] is True and c["id"]
    add(anand, "anil")
    add(anand, "Zubair")
    names = [x["name"] for x in anand.get("/api/customers").get_json()["data"]]
    assert names == ["anil", "Ravi", "Zubair"]


def test_duplicate_is_case_insensitive_and_names_existing(anand):
    add(anand, "Ravi")
    r = add(anand, " rAVI ")
    assert r.status_code == 409
    body = r.get_json()
    assert body["code"] == "duplicate" and body["error"] == "Customer 'Ravi' already exists."


@pytest.mark.parametrize("body", [{}, {"name": "   "}, {"name": 5}, {"name": "x" * 81}])
def test_name_validation(anand, body):
    assert anand.post("/api/customers", json=body).status_code == 400


def test_name_length_boundary(anand):
    assert add(anand, "x" * 80).status_code == 201


def test_search_and_inactive_filter(anand):
    for n, p in (("Ravi", "111"), ("Ramesh", "222"), ("Sita", "111")):
        add(anand, n, phone=p, place="Town_1")
    get = lambda q: [c["name"] for c in anand.get(f"/api/customers{q}").get_json()["data"]]
    assert get("?q=ra") == ["Ramesh", "Ravi"]
    assert get("?q=111") == ["Ravi", "Sita"]
    assert get("?q=%25") == []                       # wildcard characters are escaped
    assert get("?q=n_1") == ["Ramesh", "Ravi", "Sita"]
    cid = [c for c in anand.get("/api/customers").get_json()["data"] if c["name"] == "Sita"][0]["id"]
    anand.put(f"/api/customers/{cid}", json={"is_active": False})
    assert get("") == ["Ramesh", "Ravi"]
    assert get("?include_inactive=1") == ["Ramesh", "Ravi", "Sita"]


def test_update_partial_and_duplicate(anand):
    a = add(anand, "Ravi", phone="1", place="X").get_json()["data"]
    b = add(anand, "Sita").get_json()["data"]
    r = anand.put(f"/api/customers/{a['id']}", json={"phone": "2"})
    assert r.status_code == 200 and r.get_json()["data"]["phone"] == "2" and r.get_json()["data"]["place"] == "X"
    assert anand.put(f"/api/customers/{a['id']}", json={"place": None}).get_json()["data"]["place"] is None
    assert anand.put(f"/api/customers/{a['id']}", json={"name": "RAVI"}).status_code == 200   # own name, new case
    clash = anand.put(f"/api/customers/{b['id']}", json={"name": "ravi"})
    assert clash.status_code == 409 and "'RAVI'" in clash.get_json()["error"]
    assert anand.put("/api/customers/999", json={"phone": "1"}).status_code == 404
    assert anand.put(f"/api/customers/{a['id']}", json={"is_active": "x"}).status_code == 400


def test_permissions(staff, anand, app, make_client):
    add(anand, "Ravi")
    assert staff.get("/api/customers").status_code == 200           # staff can view
    assert staff.get("/api/customers/1").status_code == 200
    assert add(staff, "New").status_code == 201                      # credits:edit may add (per DESIGN 5.2)
    assert staff.put("/api/customers/1", json={"phone": "1"}).status_code == 403   # but not edit
    assert app.test_client().get("/api/customers").status_code == 401


def test_form_users_can_pick_and_add_without_customers_permission(app, admin):
    """A user with only retail:edit (sales form) can list + add customers but not open the detail page."""
    admin.post("/api/users", json={"username": "cashier", "password": "secret1", "permissions": ["retail:edit"]})
    c = app.test_client()
    tok = c.post("/api/auth/login", json={"username": "cashier", "password": "secret1"}).get_json()["data"]["csrf"]
    h = {"X-CSRF-Token": tok}
    assert c.get("/api/customers").status_code == 200
    assert c.post("/api/customers", json={"name": "Walk-in"}, headers=h).status_code == 201
    assert c.get("/api/customers/1").status_code == 403
    assert c.put("/api/customers/1", json={"phone": "1"}, headers=h).status_code == 403


def test_detail_works_without_sales_and_credits_modules(anand):
    cid = add(anand, "Ravi").get_json()["data"]["id"]
    d = anand.get(f"/api/customers/{cid}").get_json()["data"]
    assert d["customer"]["name"] == "Ravi" and isinstance(d["purchases"], list)
    assert d["credit"] is None or set(d["credit"]) >= {"balance"}
    assert anand.get("/api/customers/999").status_code == 404


def test_service_helpers(app, anand):
    ids = [add(anand, n).get_json()["data"]["id"] for n in ("Ravi", "Sita")]
    with app.app_context():
        assert service.get_customer(ids[0])["name"] == "Ravi"
        assert service.get_customer(999) is None
        assert service.customer_names([ids[0], ids[1], 999, None]) == {ids[0]: "Ravi", ids[1]: "Sita"}
        assert service.customer_names([]) == {}
        assert service.require_customer(ids[0])["id"] == ids[0]
        with pytest.raises(ApiError) as e:
            service.require_customer(999)
        assert e.value.status == 404
        with db.transaction():
            db.execute("UPDATE customers SET is_active = 0 WHERE id = ?", (ids[1],))
        with pytest.raises(ApiError):
            service.require_customer(ids[1])


def test_audit_written(app, anand):
    add(anand, "Ravi")
    with app.app_context():
        row = db.query_one("SELECT user, action FROM audit_log WHERE entity = 'customer'")
        assert (row["user"], row["action"]) == ("anand", "customer.create")

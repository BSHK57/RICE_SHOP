"""Login, CSRF, permission checks and user administration (app/auth)."""
import pytest

from app import db
from app.auth import identity


@pytest.fixture(autouse=True)
def _fresh_throttle():
    identity.reset_throttle()
    yield
    identity.reset_throttle()


def login(client, username, password):
    return client.post("/api/auth/login", json={"username": username, "password": password})


def authed(app, username, password):
    """A client that really logged in, with the CSRF header set from the login response."""
    c = app.test_client()
    r = login(c, username, password)
    assert r.status_code == 200, r.get_json()
    c.environ_base["HTTP_X_CSRF_TOKEN"] = r.get_json()["data"]["csrf"]
    return c


# ------------------------------- login ------------------------------------ #
@pytest.mark.parametrize("user,pw,role", [("admin", "admin@123", "admin"), ("anand", "anand1970", "super"),
                                          ("staff", "staff@123", "staff"), ("ANAND", "anand1970", "super")])
def test_login_success(app, user, pw, role):
    c = app.test_client()
    r = login(c, user, pw)
    assert r.status_code == 200
    data = r.get_json()["data"]
    assert data["user"]["role"] == role and data["csrf"]
    assert data["user"]["username"] == user.lower()
    assert all(set(t) == {"id", "label", "icon"} for t in data["tabs"])
    me = c.get("/api/auth/me").get_json()["data"]
    assert me["user"]["username"] == user.lower() and me["csrf"] == data["csrf"]


def test_staff_tabs_exclude_inventory_and_users(app):
    tabs = {t["id"] for t in login(app.test_client(), "staff", "staff@123").get_json()["data"]["tabs"]}
    assert {"retail", "credits"} <= tabs and not tabs & {"inventory", "users", "original", "wholesale"}


@pytest.mark.parametrize("user,pw", [("admin", "wrong"), ("nobody", "x"), ("admin", ""), ("", "")])
def test_login_failure(app, user, pw):
    r = login(app.test_client(), user, pw)
    assert r.status_code == 401 and r.get_json()["ok"] is False and r.get_json()["code"] == "invalid_credentials"


def test_login_bad_body(app):
    c = app.test_client()
    assert c.post("/api/auth/login", data="nope").status_code == 400
    assert c.post("/api/auth/login", json={"username": 5, "password": ["x"]}).status_code == 401


def test_login_lockout_and_reset_on_success(app):
    app.config.update(LOGIN_MAX_ATTEMPTS=3, LOGIN_LOCK_SECONDS=60)
    c = app.test_client()
    for _ in range(2):
        assert login(c, "staff", "bad").status_code == 401
    assert login(c, "staff", "staff@123").status_code == 200       # success resets the counter
    for _ in range(3):
        assert login(c, "staff", "bad").status_code == 401
    r = login(c, "staff", "staff@123")                             # correct password but locked
    assert r.status_code == 429 and r.get_json()["code"] == "locked"
    assert login(c, "STAFF", "staff@123").status_code == 429       # case-insensitive key
    assert login(c, "admin", "admin@123").status_code == 200       # other usernames unaffected


def test_lock_expires(app, monkeypatch):
    app.config.update(LOGIN_MAX_ATTEMPTS=2, LOGIN_LOCK_SECONDS=60)
    c = app.test_client()
    t = [1000.0]
    monkeypatch.setattr(identity.time, "time", lambda: t[0])
    login(c, "staff", "bad"), login(c, "staff", "bad")
    assert login(c, "staff", "staff@123").status_code == 429
    t[0] += 61
    assert login(c, "staff", "staff@123").status_code == 200


def test_logout_ends_session(app):
    c = authed(app, "staff", "staff@123")
    assert c.post("/api/auth/logout").status_code == 200
    r = c.get("/api/auth/me")
    assert r.status_code == 401 and r.get_json()["code"] == "unauthorized"


def test_me_requires_login(app):
    assert app.test_client().get("/api/auth/me").status_code == 401


# --------------------------------- csrf ------------------------------------ #
def test_csrf_required_on_post(app):
    c = app.test_client()
    r = login(c, "admin", "admin@123")
    token = r.get_json()["data"]["csrf"]
    body = {"username": "bob", "password": "secret1", "preset": "staff"}
    no_token = c.post("/api/users", json=body)
    assert no_token.status_code == 403 and no_token.get_json()["code"] == "csrf"
    bad = c.post("/api/users", json=body, headers={"X-CSRF-Token": "wrong"})
    assert bad.status_code == 403
    good = c.post("/api/users", json=body, headers={"X-CSRF-Token": token})
    assert good.status_code == 201


# ------------------------------ permissions -------------------------------- #
def test_staff_cannot_manage_users(staff):
    assert staff.get("/api/users").status_code == 403
    assert staff.get("/api/users/catalog").status_code == 403
    assert staff.post("/api/users", json={"username": "x1x", "password": "secret1", "preset": "staff"}).status_code == 403
    assert staff.put("/api/users/1", json={"is_active": False}).status_code == 403
    assert staff.post("/api/users/1/password", json={"password": "secret1"}).status_code == 403


def test_anand_cannot_manage_users(anand):
    assert anand.get("/api/users").status_code == 403


def test_not_logged_in_is_401(app):
    assert app.test_client().get("/api/users").status_code == 401


# ------------------------------ user admin --------------------------------- #
def test_list_includes_builtins_readonly(admin):
    rows = admin.get("/api/users").get_json()["data"]
    builtin = {r["username"]: r for r in rows if r["source"] == "builtin"}
    assert set(builtin) == {"admin", "anand", "staff"}
    assert all(r["id"] is None and r["is_active"] for r in builtin.values())
    assert "users:manage" in builtin["admin"]["permissions"] and "users:manage" not in builtin["anand"]["permissions"]
    assert all("password" not in r and "password_hash" not in r for r in rows)


def test_catalog(admin):
    data = admin.get("/api/users/catalog").get_json()["data"]
    assert {"key": "retail:view", "group": "Retail sales", "label": "View retail sales"} in data["permissions"]
    assert set(data["presets"]) == {"admin", "super", "staff"}


def test_create_user_and_login(app, admin):
    r = admin.post("/api/users", json={"username": "Meena", "display_name": "Meena K", "password": "secret1",
                                       "permissions": ["credits:edit", "retail:edit", "bogus:key"]})
    assert r.status_code == 201
    u = r.get_json()["data"]
    assert u["source"] == "db" and u["id"] and u["is_active"] and u["display_name"] == "Meena K"
    assert "password_hash" not in u
    # edit implies view; unknown keys dropped
    assert u["permissions"] == ["credits:edit", "credits:view", "retail:edit", "retail:view"]
    listed = [x for x in admin.get("/api/users").get_json()["data"] if x["source"] == "db"]
    assert [x["username"] for x in listed] == ["Meena"]
    c = authed(app, "meena", "secret1")                               # username case-insensitive
    me = c.get("/api/auth/me").get_json()["data"]
    assert me["user"]["permissions"] == u["permissions"] and me["user"]["role"] is None
    assert c.get("/api/users").status_code == 403
    assert login(app.test_client(), "meena", "wrongpw").status_code == 401


def test_create_user_with_preset_and_audit(app, admin):
    r = admin.post("/api/users", json={"username": "helper", "password": "secret1", "preset": "staff"})
    assert r.status_code == 201
    data = r.get_json()["data"]
    assert data["display_name"] == "helper" and "customers:view" in data["permissions"]
    with app.app_context():
        row = db.query_one("SELECT * FROM audit_log WHERE action = 'user.create'")
        assert row["user"] == "admin" and "secret1" not in row["detail"]
        stored = db.query_one("SELECT password_hash FROM app_users")["password_hash"]
        assert stored != "secret1" and stored.startswith(("scrypt:", "pbkdf2:"))


@pytest.mark.parametrize("body,fragment", [
    ({"username": "ab", "password": "secret1", "preset": "staff"}, "3-30"),
    ({"username": "has space", "password": "secret1", "preset": "staff"}, "3-30"),
    ({"username": "x" * 31, "password": "secret1", "preset": "staff"}, "30"),
    ({"username": "okname", "password": "short", "preset": "staff"}, "6 characters"),
    ({"username": "okname", "password": "secret1"}, "permissions or a preset"),
    ({"username": "okname", "password": "secret1", "preset": "root"}, "preset"),
    ({"username": "okname", "password": "secret1", "permissions": ["nope:nope"]}, "valid permission"),
    ({"username": "okname", "password": "secret1", "permissions": "retail:view"}, "list"),
])
def test_create_user_validation(admin, body, fragment):
    r = admin.post("/api/users", json=body)
    assert r.status_code == 400 and fragment in r.get_json()["error"]


@pytest.mark.parametrize("name", ["admin", "ADMIN", "Anand", "staff"])
def test_create_user_clashes_with_builtin(admin, name):
    r = admin.post("/api/users", json={"username": name, "password": "secret1", "preset": "staff"})
    assert r.status_code == 409 and r.get_json()["code"] == "duplicate"


def test_create_user_duplicate_case_insensitive(admin):
    body = {"username": "Ravi", "password": "secret1", "preset": "staff"}
    assert admin.post("/api/users", json=body).status_code == 201
    r = admin.post("/api/users", json={**body, "username": "rAVI"})
    assert r.status_code == 409 and r.get_json()["code"] == "duplicate"


def _make_user(admin, name="worker", **extra):
    r = admin.post("/api/users", json={"username": name, "password": "secret1", "permissions": ["retail:view"], **extra})
    return r.get_json()["data"]


def test_update_permissions_apply_immediately(app, admin):
    u = _make_user(admin)
    c = authed(app, "worker", "secret1")
    assert c.get("/api/customers").status_code == 403
    r = admin.put(f"/api/users/{u['id']}", json={"permissions": ["customers:edit"], "display_name": "W2"})
    assert r.status_code == 200
    assert r.get_json()["data"]["permissions"] == ["customers:edit", "customers:view"]
    assert r.get_json()["data"]["display_name"] == "W2"
    assert c.get("/api/customers").status_code == 200               # same session, new rights


def test_deactivate_blocks_login_and_session(app, admin):
    u = _make_user(admin)
    c = authed(app, "worker", "secret1")
    assert admin.put(f"/api/users/{u['id']}", json={"is_active": False}).get_json()["data"]["is_active"] is False
    assert c.get("/api/auth/me").status_code == 401
    assert login(app.test_client(), "worker", "secret1").status_code == 401
    admin.put(f"/api/users/{u['id']}", json={"is_active": True})
    assert login(app.test_client(), "worker", "secret1").status_code == 200


def test_update_user_errors(admin):
    assert admin.put("/api/users/999", json={"is_active": False}).status_code == 404
    u = _make_user(admin)
    assert admin.put(f"/api/users/{u['id']}", json={}).status_code == 400
    assert admin.put(f"/api/users/{u['id']}", json={"is_active": "no"}).status_code == 400
    assert admin.put(f"/api/users/{u['id']}", json={"permissions": []}).status_code == 400


def test_cannot_deactivate_self(app, admin):
    u = _make_user(admin, "boss", permissions=["users:manage"])
    c = authed(app, "boss", "secret1")
    r = c.put(f"/api/users/{u['id']}", json={"is_active": False})
    assert r.status_code == 400 and r.get_json()["code"] == "self_deactivate"


def test_reset_password(app, admin):
    u = _make_user(admin)
    assert admin.post(f"/api/users/{u['id']}/password", json={"password": "abc"}).status_code == 400
    assert admin.post("/api/users/999/password", json={"password": "newpass1"}).status_code == 404
    assert admin.post(f"/api/users/{u['id']}/password", json={"password": "newpass1"}).status_code == 200
    assert login(app.test_client(), "worker", "secret1").status_code == 401
    assert login(app.test_client(), "worker", "newpass1").status_code == 200
    with app.app_context():
        assert db.query_one("SELECT 1 AS x FROM audit_log WHERE action = 'user.password_reset'")
        assert "newpass1" not in str(db.query_all("SELECT detail FROM audit_log"))

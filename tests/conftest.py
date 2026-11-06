"""Shared fixtures. `admin`, `anand` (super user) and `staff` are logged-in test clients."""
import pytest

from app import create_app


@pytest.fixture
def app(tmp_path):
    return create_app({"TESTING": True, "DATABASE": str(tmp_path / "test.db"), "SECRET_KEY": "test-secret"})


@pytest.fixture
def make_client(app):
    def _make(username):
        c = app.test_client()
        with c.session_transaction() as s:        # same keys the real login sets (see auth/identity.py)
            s["uid"] = username
            s["csrf"] = "tok"
        c.environ_base["HTTP_X_CSRF_TOKEN"] = "tok"
        return c
    return _make


@pytest.fixture
def admin(make_client):
    return make_client("admin")


@pytest.fixture
def anand(make_client):
    return make_client("anand")


@pytest.fixture
def staff(make_client):
    return make_client("staff")

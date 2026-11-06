"""
Application factory.

Layout (one folder per feature; each has routes.py / service.py / queries.py):
    app/db.py          all DB plumbing + schema           app/utils/calc.py    all calculations
    app/auth/          login, users, permissions          app/customers/       customer book
    app/inventory/     retail stock                       app/sales/           retail + wholesale sales
    app/credits/       credit ledger + payments           app/orders/          reminders / pending deliveries
    app/reports/       dashboard + reports                app/web.py           HTML pages (login + SPA shell)
See docs/DESIGN.md.
"""
from __future__ import annotations

import importlib
import logging
import os
import secrets
import sqlite3
from datetime import timedelta

from flask import Flask, request, session

from app import db
from app.utils.calc import StockError
from app.utils.common import ApiError, fail

log = logging.getLogger(__name__)

# (module path, attribute holding the Blueprint). Every module exposes `bp`.
BLUEPRINT_MODULES = [
    "app.web",
    "app.auth.routes",
    "app.customers.routes",
    "app.inventory.routes",
    "app.sales.routes",
    "app.credits.routes",
    "app.orders.routes",
    "app.reports.routes",
]

CSRF_EXEMPT = {"/api/auth/login"}


def _load_secret_key(instance_path: str) -> str:
    """SECRET_KEY: env var, else a random key persisted in instance/secret_key."""
    env = os.environ.get("RICE_SHOP_SECRET")
    if env:
        return env
    path = os.path.join(instance_path, "secret_key")
    os.makedirs(instance_path, exist_ok=True)
    if os.path.exists(path):
        return open(path).read().strip()
    key = secrets.token_hex(32)
    with open(path, "w") as fh:
        fh.write(key)
    os.chmod(path, 0o600)
    return key


def create_app(test_config: dict | None = None) -> Flask:
    app = Flask(__name__, instance_relative_config=False)
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    instance = os.path.join(base, "instance")
    app.config.update(
        DATABASE=os.environ.get("RICE_SHOP_DB", os.path.join(instance, "rice_shop.db")),
        SECRET_KEY=None,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
        JSON_SORT_KEYS=False,
        MAX_CONTENT_LENGTH=1024 * 1024,
        LOGIN_MAX_ATTEMPTS=5,          # failed logins allowed ...
        LOGIN_LOCK_SECONDS=300,        # ... before a 5 minute lock (per username+IP)
    )
    if test_config:
        app.config.update(test_config)
    if not app.config.get("SECRET_KEY"):
        app.config["SECRET_KEY"] = _load_secret_key(instance)

    db.init_app(app)

    # ------------------------------ blueprints ------------------------------ #
    for mod_name in BLUEPRINT_MODULES:
        try:
            mod = importlib.import_module(mod_name)
        except ModuleNotFoundError as exc:
            if exc.name == mod_name:
                log.warning("Blueprint module %s not found - skipped", mod_name)
                continue
            raise
        app.register_blueprint(mod.bp)

    # --------------------------- CSRF + cache headers ------------------------- #
    @app.before_request
    def _csrf_guard():
        if request.method in ("POST", "PUT", "PATCH", "DELETE") and request.path.startswith("/api/"):
            if request.path in CSRF_EXEMPT:
                return None
            if not session.get("uid"):
                return fail("Please log in.", 401, "unauthorized")
            token = request.headers.get("X-CSRF-Token", "")
            if not token or token != session.get("csrf"):
                return fail("Session expired. Please reload the page.", 403, "csrf")
        return None

    @app.after_request
    def _no_store_api(resp):
        if request.path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store"
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        return resp

    # ------------------------------ error handling --------------------------- #
    @app.errorhandler(ApiError)
    def _api_error(e: ApiError):
        return fail(e.message, e.status, e.code)

    @app.errorhandler(StockError)
    def _stock_error(e: StockError):
        return fail(str(e), 409, "insufficient_stock")

    @app.errorhandler(OverflowError)
    def _overflow(_e):
        return fail("A number in the request is too large.", 400, "bad_request")

    @app.errorhandler(sqlite3.IntegrityError)
    def _integrity(e):
        log.warning("IntegrityError: %s", e)
        return fail("That conflicts with existing data (duplicate or in use).", 409, "conflict")

    @app.errorhandler(404)
    def _404(_e):
        if request.path.startswith("/api/"):
            return fail("Not found.", 404, "not_found")
        return "Not found", 404

    @app.errorhandler(405)
    def _405(_e):
        return fail("Method not allowed.", 405, "method_not_allowed")

    @app.errorhandler(500)
    def _500(e):
        log.exception("Unhandled error: %s", e)
        return fail("Something went wrong on the server.", 500, "server_error")

    return app

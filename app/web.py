"""
web.py - the only HTML route: GET /  ->  login page (logged out) or the app shell (logged in).

Everything else the browser needs comes from /api/... .  Templates live in app/templates and
static files in app/static (Flask defaults for the app package).
"""
from __future__ import annotations

import os
import secrets

from flask import Blueprint, make_response, render_template, session

from app.auth import permissions

bp = Blueprint("web", __name__)

_STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")   # Flask default: app/static


def _shared_scripts() -> list[str]:
    folder = os.path.join(_STATIC, "js", "shared")
    try:
        return sorted(n for n in os.listdir(folder) if n.endswith(".js"))
    except OSError:
        return []


@bp.get("/")
def index():
    user = permissions.current_user()
    if user is None:
        resp = make_response(render_template("login.html"))
    else:
        if not session.get("csrf"):
            session["csrf"] = secrets.token_urlsafe(32)
        resp = make_response(render_template(
            "index.html",
            user=user,
            tabs=permissions.tabs_for(user.permissions),
            csrf=session["csrf"],
            shared_scripts=_shared_scripts(),
            has_bell=user.can("orders:view"),
        ))
    resp.headers["Cache-Control"] = "no-store"
    return resp

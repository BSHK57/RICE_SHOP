"""
auth/routes.py - login/logout/me and the Users tab endpoints (DESIGN section 5.1). Thin: parse -> identity -> ok().
"""
from __future__ import annotations

import secrets

from flask import Blueprint, session

from app.auth import identity, permissions
from app.auth.permissions import User, current_user, login_required, require
from app.utils.common import json_body, ok

bp = Blueprint("auth", __name__)


def _user_json(user: User) -> dict:
    return {"username": user.username, "display_name": user.display_name, "role": user.role,
            "permissions": sorted(user.permissions)}


def _tabs_json(user: User) -> list[dict]:
    return [{"id": t["id"], "label": t["label"], "icon": t["icon"]}
            for t in permissions.tabs_for(user.permissions)]


@bp.post("/api/auth/login")
def login():
    body = json_body()
    user = identity.login(body.get("username"), body.get("password"))
    session.clear()                                   # fresh session -> no fixation
    session["uid"] = user.username
    session["csrf"] = secrets.token_urlsafe(32)
    session.permanent = True
    return ok({"user": _user_json(user), "tabs": _tabs_json(user), "csrf": session["csrf"]})


@bp.post("/api/auth/logout")
@login_required
def logout():
    session.clear()
    return ok({})


@bp.get("/api/auth/me")
@login_required
def me():
    user = current_user()
    if not session.get("csrf"):
        session["csrf"] = secrets.token_urlsafe(32)
    return ok({"user": _user_json(user), "tabs": _tabs_json(user), "csrf": session["csrf"]})


# ------------------------------- user admin ------------------------------- #
@bp.get("/api/users")
@require("users:manage")
def users_list():
    return ok(identity.list_users())


@bp.get("/api/users/catalog")
@require("users:manage")
def users_catalog():
    return ok(identity.catalog())


@bp.post("/api/users")
@require("users:manage")
def users_create():
    return ok(identity.create_user(json_body(), current_user()), 201)


@bp.put("/api/users/<int:user_id>")
@require("users:manage")
def users_update(user_id: int):
    return ok(identity.update_user(user_id, json_body(), current_user()))


@bp.post("/api/users/<int:user_id>/password")
@require("users:manage")
def users_password(user_id: int):
    identity.set_password(user_id, json_body(), current_user())
    return ok({})

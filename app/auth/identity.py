"""
identity.py - who is logging in: hard-coded users, DB users, login throttling and user admin.

Two kinds of users
  * BUILT-IN users in HARDCODED_USERS below (admin / anand / staff). To change a built-in
    login or password, edit that dict and restart the app.
  * DB users in table `app_users`, created by the admin in the Users tab. Their passwords are
    stored hashed with werkzeug (generate_password_hash) and never leave the server.

The session only stores the username (`session['uid']`). `load_user_from_session()` re-reads the
user on every request, so a permission change or deactivation applies immediately.
"""
from __future__ import annotations

import hmac
import json
import re
import threading
import time

from flask import current_app, request, session
from werkzeug.security import check_password_hash, generate_password_hash

from app import db
from app.auth import permissions, queries
from app.auth.permissions import User
from app.utils.common import ApiError, one_of, opt_str, req_str

# --------------------------------------------------------------------------- #
# EDIT CREDENTIALS HERE.  key = lowercase username.  role must be a key of permissions.PRESETS.
# `staff` password is a placeholder - it was not specified. Change it before going live.
# --------------------------------------------------------------------------- #
HARDCODED_USERS: dict[str, dict] = {
    "admin": {"password": "admin@123",  "role": "admin", "display_name": "Admin"},
    "anand": {"password": "anand1970",  "role": "super", "display_name": "Anand"},
    "staff": {"password": "staff@123",  "role": "staff", "display_name": "Staff"},
}

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,30}$")
MIN_PASSWORD_LEN = 6
MAX_PASSWORD_LEN = 128


# --------------------------------------------------------------------------- #
# Building User objects
# --------------------------------------------------------------------------- #
def _builtin_user(key: str) -> User:
    entry = HARDCODED_USERS[key]
    return User(username=key, display_name=entry["display_name"],
                permissions=permissions.PRESETS[entry["role"]], source="builtin", role=entry["role"])


def _db_user(row: dict) -> User:
    try:
        perms = json.loads(row["permissions"] or "[]")
    except ValueError:
        perms = []
    return User(username=row["username"], display_name=row["display_name"],
                permissions=permissions.normalize_permissions(perms), source="db", role=None,
                db_id=row["id"])


def _same_secret(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def authenticate(username: str, password: str) -> User | None:
    """Built-in users first (username case-insensitive), then active DB users."""
    if not isinstance(username, str) or not isinstance(password, str):
        return None
    key = username.strip().lower()
    entry = HARDCODED_USERS.get(key)
    if entry is not None:
        return _builtin_user(key) if _same_secret(password, entry["password"]) else None
    row = queries.get_user_by_username(key)
    if row is None or not row["is_active"]:
        return None
    return _db_user(row) if check_password_hash(row["password_hash"], password) else None


def load_user_from_session() -> User | None:
    """Resolve session['uid'] to a live User (None when unknown or deactivated)."""
    uid = session.get("uid")
    if not isinstance(uid, str) or not uid:
        return None
    key = uid.strip().lower()
    if key in HARDCODED_USERS:
        return _builtin_user(key)
    row = queries.get_user_by_username(key)
    if row is None or not row["is_active"]:
        return None
    return _db_user(row)


# --------------------------------------------------------------------------- #
# Login throttling (in memory, per username + client address; resets on restart)
# --------------------------------------------------------------------------- #
_throttle_lock = threading.Lock()
_failures: dict[tuple[str, str], dict] = {}   # key -> {count, last, locked_until}


def reset_throttle() -> None:
    with _throttle_lock:
        _failures.clear()


def _throttle_key(username: object) -> tuple[str, str]:
    name = username.strip().lower()[:100] if isinstance(username, str) else ""
    return name, request.remote_addr or ""


def _check_not_locked(key: tuple[str, str]) -> None:
    now = time.time()
    with _throttle_lock:
        st = _failures.get(key)
        if st and st["locked_until"] > now:
            wait = int(st["locked_until"] - now) + 1
            raise ApiError(f"Too many failed attempts. Try again in {max(1, -(-wait // 60))} minute(s).",
                           429, "locked")


def _record_failure(key: tuple[str, str]) -> None:
    now = time.time()
    max_attempts = current_app.config["LOGIN_MAX_ATTEMPTS"]
    lock_seconds = current_app.config["LOGIN_LOCK_SECONDS"]
    with _throttle_lock:
        if len(_failures) > 2000:   # drop stale entries so the dict cannot grow without bound
            for k in [k for k, v in _failures.items() if now - v["last"] > lock_seconds]:
                del _failures[k]
        st = _failures.get(key)
        if st is None or (st["locked_until"] <= now and now - st["last"] > lock_seconds):
            st = _failures[key] = {"count": 0, "last": now, "locked_until": 0.0}
        st["count"] += 1
        st["last"] = now
        if st["count"] >= max_attempts:
            st["count"] = 0
            st["locked_until"] = now + lock_seconds


def login(username: object, password: object) -> User:
    """authenticate() + throttling. Raises ApiError 429 'locked' / 401 'invalid_credentials'."""
    key = _throttle_key(username)
    _check_not_locked(key)
    user = authenticate(username, password) if isinstance(username, str) and isinstance(password, str) else None
    if user is None:
        _record_failure(key)
        raise ApiError("Incorrect username or password.", 401, "invalid_credentials")
    with _throttle_lock:
        _failures.pop(key, None)
    return user


# --------------------------------------------------------------------------- #
# User administration (Users tab). Only DB users can be changed; built-ins are read-only.
# --------------------------------------------------------------------------- #
def _public(row: dict) -> dict:
    """DB row -> API shape. Never includes the password hash."""
    u = _db_user(row)
    return {"id": row["id"], "username": row["username"], "display_name": row["display_name"],
            "source": "db", "role": None, "permissions": sorted(u.permissions),
            "is_active": bool(row["is_active"])}


def _builtin_public(key: str) -> dict:
    u = _builtin_user(key)
    return {"id": None, "username": key, "display_name": u.display_name, "source": "builtin",
            "role": u.role, "permissions": sorted(u.permissions), "is_active": True}


def list_users() -> list[dict]:
    return [_builtin_public(k) for k in HARDCODED_USERS] + [_public(r) for r in queries.list_users()]


def catalog() -> dict:
    return {
        "permissions": [{"key": k, "group": g, "label": label}
                        for k, (g, label) in permissions.PERMISSION_CATALOG.items()],
        "presets": {name: sorted(perms) for name, perms in permissions.PRESETS.items()},
    }


def _check_password(value: object) -> str:
    if not isinstance(value, str) or len(value) < MIN_PASSWORD_LEN:
        raise ApiError(f"Password must be at least {MIN_PASSWORD_LEN} characters.")
    if len(value) > MAX_PASSWORD_LEN:
        raise ApiError(f"Password is too long (max {MAX_PASSWORD_LEN}).")
    return value


def _permissions_from(payload: dict) -> frozenset[str]:
    """`permissions: [...]` or `preset: 'staff'`; normalised (implications added, unknown keys dropped)."""
    if "permissions" in payload and payload["permissions"] is not None:
        raw = payload["permissions"]
        if not isinstance(raw, list) or not all(isinstance(p, str) for p in raw):
            raise ApiError("permissions must be a list of permission keys.")
    elif payload.get("preset") is not None:
        raw = permissions.PRESETS[one_of(payload["preset"], tuple(permissions.PRESETS), "preset")]
    else:
        raise ApiError("Choose permissions or a preset.")
    perms = permissions.normalize_permissions(raw)
    if not perms:
        raise ApiError("Pick at least one valid permission.")
    return perms


def _perms_json(perms: frozenset[str]) -> str:
    return json.dumps(sorted(perms))


def create_user(payload: dict, actor: User) -> dict:
    username = req_str(payload, "username", "Username", 30)
    if not USERNAME_RE.match(username):
        raise ApiError("Username must be 3-30 characters: letters, digits, underscore, dot or dash.")
    display_name = opt_str(payload, "display_name", 60) or username
    password = _check_password(payload.get("password"))
    perms = _permissions_from(payload)
    with db.transaction():
        if username.lower() in HARDCODED_USERS or queries.get_user_by_username(username):
            raise ApiError(f"Username '{username}' is already taken.", 409, "duplicate")
        uid = queries.insert_user(username, display_name, generate_password_hash(password),
                                  _perms_json(perms), db.now_str())
        db.audit(actor.username, "user.create", "app_user", uid,
                 {"username": username, "permissions": sorted(perms)})
    return _public(queries.get_user_by_id(uid))


def update_user(user_id: int, payload: dict, actor: User) -> dict:
    row = queries.get_user_by_id(user_id)
    if row is None:
        raise ApiError("User not found.", 404, "not_found")
    display_name = row["display_name"]
    perms = _db_user(row).permissions
    active = bool(row["is_active"])
    if "display_name" in payload:
        display_name = req_str(payload, "display_name", "Display name", 60)
    if "permissions" in payload or "preset" in payload:
        perms = _permissions_from(payload)
    if "is_active" in payload:
        if not isinstance(payload["is_active"], bool):
            raise ApiError("is_active must be true or false.")
        active = payload["is_active"]
    if not active and row["username"].lower() == actor.username.lower():
        raise ApiError("You cannot deactivate your own account.", 400, "self_deactivate")
    if not any(k in payload for k in ("display_name", "permissions", "preset", "is_active")):
        raise ApiError("Nothing to update.")
    with db.transaction():
        queries.update_user(user_id, display_name, _perms_json(perms), active)
        db.audit(actor.username, "user.update", "app_user", user_id,
                 {"username": row["username"], "display_name": display_name,
                  "permissions": sorted(perms), "is_active": active})
    return _public(queries.get_user_by_id(user_id))


def set_password(user_id: int, payload: dict, actor: User) -> None:
    row = queries.get_user_by_id(user_id)
    if row is None:
        raise ApiError("User not found.", 404, "not_found")
    password = _check_password(payload.get("password"))
    with db.transaction():
        queries.set_password_hash(user_id, generate_password_hash(password))
        db.audit(actor.username, "user.password_reset", "app_user", user_id, {"username": row["username"]})

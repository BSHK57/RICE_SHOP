"""
common.py - small helpers shared by every module: JSON responses, errors, validation, dates.

All API endpoints return the same envelope:
    success -> {"ok": true,  "data": <anything>}
    failure -> {"ok": false, "error": "<human readable message>", "code": "<machine_code>"}
"""
from __future__ import annotations

import math
import re
from datetime import datetime
from typing import Any

from flask import jsonify, request

DATE_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")
DATETIME_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}(:[0-9]{2})?$")


# Sanity ceilings: far beyond any real shop figure, far below SQLite/float overflow.
MAX_INT = 10**9        # grams, rupees, counts, ids
MAX_PRICE = 10**7      # rupees per kg / per bag


class ApiError(Exception):
    """Raise anywhere inside a request; the app factory turns it into a JSON error."""

    def __init__(self, message: str, status: int = 400, code: str = "bad_request"):
        super().__init__(message)
        self.message, self.status, self.code = message, status, code


def ok(data: Any = None, status: int = 200):
    return jsonify({"ok": True, "data": data}), status


def fail(message: str, status: int = 400, code: str = "bad_request"):
    return jsonify({"ok": False, "error": message, "code": code}), status


def json_body() -> dict:
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError("Request body must be a JSON object.")
    return data


# ------------------------------ validation -------------------------------- #
def req_str(d: dict, key: str, label: str | None = None, max_len: int = 200) -> str:
    v = d.get(key)
    if not isinstance(v, str) or not v.strip():
        raise ApiError(f"{label or key} is required.")
    v = v.strip()
    if len(v) > max_len:
        raise ApiError(f"{label or key} is too long (max {max_len}).")
    return v


def opt_str(d: dict, key: str, max_len: int = 500) -> str | None:
    v = d.get(key)
    if v is None:
        return None
    if not isinstance(v, str):
        raise ApiError(f"{key} must be text.")
    v = v.strip()
    if len(v) > max_len:
        raise ApiError(f"{key} is too long (max {max_len}).")
    return v or None


def to_int(v: Any, label: str, minimum: int | None = None, required: bool = True) -> int | None:
    if v is None or v == "":
        if required:
            raise ApiError(f"{label} is required.")
        return None
    try:
        if isinstance(v, bool):
            raise ValueError
        f = float(v)
        if not math.isfinite(f) or f != int(f):
            raise ValueError
        n = int(f)
    except (TypeError, ValueError, OverflowError):
        raise ApiError(f"{label} must be a whole number.")
    if minimum is not None and n < minimum:
        raise ApiError(f"{label} must be at least {minimum}.")
    if abs(n) > MAX_INT:
        raise ApiError(f"{label} is too large.")
    return n


def to_price(v: Any, label: str, required: bool = True) -> float | None:
    if v is None or v == "":
        if required:
            raise ApiError(f"{label} is required.")
        return None
    try:
        if isinstance(v, bool):
            raise ValueError
        f = float(v)
        if not math.isfinite(f):
            raise ValueError
        f = round(f, 2)
    except (TypeError, ValueError, OverflowError):
        raise ApiError(f"{label} must be a number.")
    if f < 0:
        raise ApiError(f"{label} cannot be negative.")
    if f > MAX_PRICE:
        raise ApiError(f"{label} is too large.")
    return f


def req_date(v: Any, label: str = "date", required: bool = True) -> str | None:
    if v is None or v == "":
        if required:
            raise ApiError(f"{label} is required.")
        return None
    if not isinstance(v, str) or not DATE_RE.match(v):
        raise ApiError(f"{label} must be YYYY-MM-DD.")
    try:
        datetime.strptime(v, "%Y-%m-%d")
    except ValueError:
        raise ApiError(f"{label} is not a valid date.")
    return v


def req_datetime(v: Any, label: str = "date-time") -> str:
    """Accepts 'YYYY-MM-DD HH:MM' or the HTML datetime-local 'YYYY-MM-DDTHH:MM'. Stored 'YYYY-MM-DD HH:MM'."""
    if not isinstance(v, str) or not DATETIME_RE.match(v):
        raise ApiError(f"{label} must be YYYY-MM-DD HH:MM.")
    return v.replace("T", " ")[:16]


def one_of(v: Any, allowed: tuple, label: str) -> Any:
    if v not in allowed:
        raise ApiError(f"{label} must be one of: {', '.join(allowed)}.")
    return v


def date_range_args(default_days: int | None = None) -> tuple[str | None, str | None]:
    """Reads ?from=&to= (both optional, validated)."""
    return (req_date(request.args.get("from"), "from", required=False),
            req_date(request.args.get("to"), "to", required=False))

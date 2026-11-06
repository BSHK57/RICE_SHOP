"""
inventory/routes.py - retail stock endpoints (DESIGN section 5.3). Thin: parse -> service -> ok().
Rice types are addressed by name, so the URL uses a <path:> converter (names may contain spaces/slashes).
"""
from __future__ import annotations

from flask import Blueprint, request

from app.auth.permissions import current_user, require, require_any
from app.inventory import service
from app.utils.common import json_body, ok, to_int

bp = Blueprint("inventory", __name__)


@bp.get("/api/inventory/rice-types")
@require_any("inventory:view", "retail:edit", "orders:edit")
def rice_types_list():
    include_inactive = request.args.get("include_inactive", "0").lower() in ("1", "true", "yes")
    return ok(service.list_rice_types(include_inactive))


@bp.post("/api/inventory/rice-types")
@require("inventory:edit")
def rice_types_create():
    return ok(service.create_rice_type(json_body(), current_user()), 201)


@bp.put("/api/inventory/rice-types/<path:type_name>")
@require("inventory:edit")
def rice_types_update(type_name: str):
    return ok(service.update_rice_type(type_name, json_body(), current_user()))


@bp.post("/api/inventory/rice-types/<path:type_name>/receive")
@require("inventory:edit")
def rice_types_receive(type_name: str):
    return ok(service.receive_stock(type_name, json_body(), current_user()))


@bp.post("/api/inventory/rice-types/<path:type_name>/adjust")
@require("inventory:edit")
def rice_types_adjust(type_name: str):
    return ok(service.adjust_stock(type_name, json_body(), current_user()))


@bp.post("/api/inventory/rice-types/<path:type_name>/open-bag")
@require("inventory:edit")
def rice_types_open_bag(type_name: str):
    body = request.get_json(silent=True)
    return ok(service.open_bag(type_name, body if isinstance(body, dict) else {}, current_user()))


@bp.get("/api/inventory/movements")
@require("inventory:view")
def movements_list():
    limit = min(to_int(request.args.get("limit") or 100, "limit", 1), 500)
    return ok(service.list_movements(request.args.get("type_name") or None, limit))

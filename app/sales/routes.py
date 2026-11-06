"""sales/routes.py - thin HTTP layer for retail / wholesale / original sales (DESIGN §5.4)."""
from __future__ import annotations

from flask import Blueprint, request

from app.auth.permissions import current_user, login_required, require, require_any
from app.sales import service
from app.utils.common import json_body, ok

bp = Blueprint("sales", __name__)


@bp.get("/api/sales/retail")
@require("retail:view")
def retail_list():
    return ok(service.retail_day(request.args.get("date"), current_user()))


@bp.post("/api/sales/retail/preview")
@require("retail:edit")
def retail_preview():
    return ok(service.preview_retail(json_body()))


@bp.post("/api/sales/retail")
@require("retail:edit")
def retail_create():
    return ok(service.create_sale("retail", json_body(), current_user()), 201)


@bp.get("/api/sales/wholesale")
@require("wholesale:view")
def wholesale_list():
    return ok(service.wholesale_list(request.args, current_user()))


@bp.post("/api/sales/wholesale")
@require("wholesale:edit")
def wholesale_create():
    return ok(service.create_sale("wholesale", json_body(), current_user()), 201)


@bp.get("/api/sales/wholesale/rice-names")
@require_any("wholesale:edit", "orders:edit")
def wholesale_rice_names():
    return ok(service.wholesale_rice_names())


@bp.get("/api/sales/original")
@require("original:view")
def original_list():
    return ok(service.original_list(request.args, current_user()))


@bp.get("/api/sales/<int:sale_id>")
@login_required
def get_one(sale_id: int):
    return ok(service.get_sale(sale_id, current_user()))


@bp.post("/api/sales/<int:sale_id>/void")
@require("sales:void")
def void(sale_id: int):
    body = request.get_json(silent=True)
    return ok(service.void_sale(sale_id, body if isinstance(body, dict) else {}, current_user()))

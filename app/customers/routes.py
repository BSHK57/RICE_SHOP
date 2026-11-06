"""
customers/routes.py - customer book endpoints (DESIGN section 5.2). Thin: parse -> service -> ok().
"""
from __future__ import annotations

from flask import Blueprint, request

from app.auth.permissions import current_user, require, require_any
from app.customers import service
from app.utils.common import json_body, ok

bp = Blueprint("customers", __name__)

# Forms elsewhere (sales, credits, reminders) need to pick/add a customer.
_PICK = ("customers:view", "retail:edit", "wholesale:edit", "orders:edit", "credits:edit")
_ADD = ("customers:edit", "retail:edit", "wholesale:edit", "orders:edit", "credits:edit")


@bp.get("/api/customers")
@require_any(*_PICK)
def customers_list():
    include_inactive = request.args.get("include_inactive", "0").lower() in ("1", "true", "yes")
    return ok(service.list_customers(request.args.get("q"), include_inactive))


@bp.post("/api/customers")
@require_any(*_ADD)
def customers_create():
    return ok(service.create_customer(json_body(), current_user()), 201)


@bp.put("/api/customers/<int:customer_id>")
@require("customers:edit")
def customers_update(customer_id: int):
    return ok(service.update_customer(customer_id, json_body(), current_user()))


@bp.get("/api/customers/<int:customer_id>")
@require("customers:view")
def customers_detail(customer_id: int):
    return ok(service.customer_detail(customer_id))

"""orders/routes.py - thin HTTP layer for reminders / pending deliveries (DESIGN §5.6)."""
from __future__ import annotations

from flask import Blueprint, request

from app.auth.permissions import current_user, require
from app.orders import service
from app.utils.common import json_body, ok

bp = Blueprint("orders", __name__)


@bp.get("/api/orders/summary")
@require("orders:view")
def summary():
    return ok(service.summary(current_user()))


@bp.get("/api/orders")
@require("orders:view")
def list_orders():
    return ok(service.list_orders(request.args, current_user()))


@bp.post("/api/orders")
@require("orders:edit")
def create():
    return ok(service.create_order(json_body(), current_user()), 201)


@bp.put("/api/orders/<int:order_id>")
@require("orders:edit")
def update(order_id: int):
    return ok(service.update_order(order_id, json_body(), current_user()))


@bp.post("/api/orders/<int:order_id>/cancel")
@require("orders:edit")
def cancel(order_id: int):
    return ok(service.cancel_order(order_id, current_user()))


@bp.post("/api/orders/<int:order_id>/fulfill")
@require("orders:edit")
def fulfill(order_id: int):
    return ok(service.fulfill_order(order_id, json_body(), current_user()))

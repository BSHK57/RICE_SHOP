"""credits/routes.py - thin HTTP layer for the credit ledger (DESIGN §5.5)."""
from __future__ import annotations

from flask import Blueprint, request

from app.auth.permissions import current_user, require
from app.credits import service
from app.utils.common import json_body, ok

bp = Blueprint("credits", __name__)


@bp.get("/api/credits/summary")
@require("credits:view")
def summary():
    return ok(service.summary(current_user()))


@bp.get("/api/credits/entries")
@require("credits:view")
def entries():
    return ok(service.list_entries(request.args, current_user()))


@bp.get("/api/credits/by-customer")
@require("credits:view")
def by_customer():
    return ok(service.by_customer(request.args, current_user()))


@bp.get("/api/credits/by-date")
@require("credits:view")
def by_date():
    return ok(service.by_date(request.args, current_user()))


@bp.get("/api/credits/customer/<int:customer_id>")
@require("credits:view")
def customer_ledger(customer_id: int):
    return ok(service.customer_ledger(customer_id, current_user()))


@bp.get("/api/credits/collections")
@require("credits:view")
def collections():
    return ok(service.collections(request.args, current_user()))


@bp.post("/api/credits/entries")
@require("credits:edit")
def create_entry():
    return ok(service.create_manual_entry(json_body(), current_user()), 201)


@bp.put("/api/credits/entries/<int:entry_id>")
@require("credits:edit")
def update_entry(entry_id: int):
    return ok(service.update_entry(entry_id, json_body(), current_user()))


@bp.post("/api/credits/entries/<int:entry_id>/payments")
@require("credits:edit")
def pay_entry(entry_id: int):
    return ok(service.pay_entry(entry_id, json_body(), current_user()), 201)


@bp.post("/api/credits/customer/<int:customer_id>/payments")
@require("credits:edit")
def pay_customer(customer_id: int):
    return ok(service.pay_customer_lump_sum(customer_id, json_body(), current_user()), 201)


@bp.delete("/api/credits/payments/<int:payment_id>")
@require("credits:delete")
def delete_payment(payment_id: int):
    return ok(service.delete_payment(payment_id, current_user()))


@bp.delete("/api/credits/entries/<int:entry_id>")
@require("credits:delete")
def delete_entry(entry_id: int):
    return ok(service.delete_entry(entry_id, current_user()))

"""reports/routes.py - thin HTTP layer for the dashboard and reports (DESIGN §5.7)."""
from __future__ import annotations

from flask import Blueprint, Response, request

from app.auth.permissions import current_user, require
from app.reports import service
from app.utils.common import ok

bp = Blueprint("reports", __name__)


@bp.get("/api/dashboard")
@require("dashboard:view")
def dashboard():
    return ok(service.dashboard(current_user()))


@bp.get("/api/reports/summary")
@require("reports:view")
def summary():
    return ok(service.summary(request.args, current_user()))


@bp.get("/api/reports/sales.csv")
@require("reports:view")
def sales_csv():
    text, filename = service.sales_csv(request.args, current_user())
    return Response("﻿" + text, mimetype="text/csv",  # BOM so Excel reads ₹ / Tamil names correctly
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})

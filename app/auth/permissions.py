"""
permissions.py - the single source of truth for WHO can do WHAT.

Model
  * A user has a set of permission keys, e.g. {"retail:view", "credits:edit"}.
  * A "tab" is shown only when the user holds the tab's `requires` permission.
  * Three built-in presets (admin / super / staff) are used by the hard-coded users in
    identity.py; users created by the admin pick individual keys in the Users tab.
  * Back-end endpoints are protected with @require(...) / @require_any(...).
    The front end hides tabs, but the BACK END is what actually enforces access.

Permission keys (group -> key : meaning)
  dashboard  dashboard:view
  inventory  inventory:view | inventory:edit (add types, receive stock, change prices/stock)
  retail     retail:view | retail:edit (record retail sales)
  wholesale  wholesale:view | wholesale:edit
  original   original:view  -> sees EXACT prices, discounts, purchase cost and profit.
                               Without it every sales view shows STANDARD (list) prices only,
                               so a discount given to a customer is never revealed.
  sales      sales:void     (cancel a wrongly entered sale; stock + credit are reversed)
  credits    credits:view | credits:edit (record payments, add credit, edit due date/notes)
             | credits:delete (undo a payment / remove a credit) | credits:wholesale (see wholesale credits)
  customers  customers:view | customers:edit
  orders     orders:view | orders:edit    (reminders / pending deliveries + the bell icon)
  reports    reports:view
  users      users:manage   (admin only)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from functools import wraps
from typing import Iterable

from flask import g

from app.utils.common import ApiError

# key -> (group label, human label). Order = order shown in the admin UI.
PERMISSION_CATALOG: dict[str, tuple[str, str]] = {
    "dashboard:view":    ("Dashboard", "See dashboard"),
    "retail:view":       ("Retail sales", "View retail sales"),
    "retail:edit":       ("Retail sales", "Record retail sales"),
    "wholesale:view":    ("Wholesale", "View wholesale sales"),
    "wholesale:edit":    ("Wholesale", "Record wholesale sales"),
    "orders:view":       ("Reminders", "View reminders / pending deliveries"),
    "orders:edit":       ("Reminders", "Add reminders, mark as sent"),
    "credits:view":      ("Credits", "View credits (customer-wise, date-wise)"),
    "credits:edit":      ("Credits", "Record payments / add credit / edit due dates"),
    "credits:delete":    ("Credits", "Undo payments / remove credit entries"),
    "credits:wholesale": ("Credits", "Include wholesale credits"),
    "customers:view":    ("Customers", "View customers"),
    "customers:edit":    ("Customers", "Add / edit customers"),
    "inventory:view":    ("Inventory", "View stock"),
    "inventory:edit":    ("Inventory", "Update stock, prices, rice types"),
    "original:view":     ("Original sales", "See exact prices, discounts, cost & profit"),
    "sales:void":        ("Original sales", "Cancel (void) a sale"),
    "reports:view":      ("Reports", "View reports"),
    "users:manage":      ("Users", "Manage users"),
}

# Holding the key on the left automatically grants the key on the right.
IMPLIES: dict[str, str] = {
    "retail:edit": "retail:view",
    "wholesale:edit": "wholesale:view",
    "inventory:edit": "inventory:view",
    "customers:edit": "customers:view",
    "orders:edit": "orders:view",
    "credits:edit": "credits:view",
    "credits:delete": "credits:edit",
    "credits:wholesale": "credits:view",
    "sales:void": "retail:view",
}

PRESETS: dict[str, frozenset[str]] = {
    # admin: everything, including managing users
    "admin": frozenset(PERMISSION_CATALOG),
    # super user (the shop owner): everything except user management
    "super": frozenset(k for k in PERMISSION_CATALOG if k != "users:manage"),
    # normal staff: see (masked) retail sales, see credits customer-wise/date-wise and update them
    "staff": frozenset({"dashboard:view", "retail:view", "credits:view", "credits:edit", "customers:view"}),
}

# Sidebar tabs. Order matters. `requires` = single permission that makes the tab visible.
TABS: list[dict] = [
    {"id": "dashboard", "label": "Dashboard",      "icon": "home",     "requires": "dashboard:view"},
    {"id": "retail",    "label": "Retail Sales",   "icon": "shopping", "requires": "retail:view"},
    {"id": "wholesale", "label": "Wholesale",      "icon": "truck",    "requires": "wholesale:view"},
    {"id": "reminders", "label": "Reminders",      "icon": "clock",    "requires": "orders:view"},
    {"id": "credits",   "label": "Credits",        "icon": "ledger",   "requires": "credits:view"},
    {"id": "customers", "label": "Customers",      "icon": "users",    "requires": "customers:view"},
    {"id": "inventory", "label": "Inventory",      "icon": "box",      "requires": "inventory:view"},
    {"id": "original",  "label": "Original Sales", "icon": "eye",      "requires": "original:view"},
    {"id": "reports",   "label": "Reports",        "icon": "chart",    "requires": "reports:view"},
    {"id": "users",     "label": "Users",          "icon": "shield",   "requires": "users:manage"},
]


def normalize_permissions(perms: Iterable[str]) -> frozenset[str]:
    """Drop unknown keys and add implied ones (edit -> view ...), transitively."""
    out = {p for p in perms if p in PERMISSION_CATALOG}
    changed = True
    while changed:
        changed = False
        for p in list(out):
            implied = IMPLIES.get(p)
            if implied and implied not in out:
                out.add(implied)
                changed = True
    return frozenset(out)


def tabs_for(perms: Iterable[str]) -> list[dict]:
    held = set(perms)
    return [t for t in TABS if t["requires"] in held]


# --------------------------------------------------------------------------- #
# Current user + decorators
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class User:
    username: str
    display_name: str
    permissions: frozenset[str]
    source: str = "builtin"          # 'builtin' (hard-coded) or 'db'
    role: str | None = None          # 'admin' | 'super' | 'staff' | None for custom users
    db_id: int | None = None
    extra: dict = field(default_factory=dict)

    def can(self, perm: str) -> bool:
        return perm in self.permissions

    def can_any(self, *perms: str) -> bool:
        return any(p in self.permissions for p in perms)


def current_user() -> User | None:
    """The logged-in user for this request (cached on flask.g), or None."""
    if "_user" not in g:
        from app.auth.identity import load_user_from_session  # local import avoids a cycle
        g._user = load_user_from_session()
    return g._user


def can(perm: str) -> bool:
    u = current_user()
    return bool(u and u.can(perm))


def can_any(*perms: str) -> bool:
    u = current_user()
    return bool(u and u.can_any(*perms))


def _need_login() -> User:
    u = current_user()
    if u is None:
        raise ApiError("Please log in.", 401, "unauthorized")
    return u


def login_required(fn):
    @wraps(fn)
    def wrapper(*a, **kw):
        _need_login()
        return fn(*a, **kw)
    return wrapper


def require(*perms: str):
    """User must hold ALL the listed permissions."""
    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **kw):
            u = _need_login()
            missing = [p for p in perms if not u.can(p)]
            if missing:
                raise ApiError("You do not have access to this.", 403, "forbidden")
            return fn(*a, **kw)
        return wrapper
    return deco


def require_any(*perms: str):
    """User must hold AT LEAST ONE of the listed permissions."""
    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **kw):
            u = _need_login()
            if not u.can_any(*perms):
                raise ApiError("You do not have access to this.", 403, "forbidden")
            return fn(*a, **kw)
        return wrapper
    return deco

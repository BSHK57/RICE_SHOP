#!/usr/bin/env python3
"""
seed_demo.py - fill a DEMO database with sample shop data, using the real API.

    .venv/bin/python scripts/seed_demo.py                  # writes instance/demo.db
    .venv/bin/python scripts/seed_demo.py --db /some/path/demo.db

Safety
  * The real database (instance/rice_shop.db) is refused unless --force-real is given.
  * An existing file is never overwritten: delete it first, or choose another --db.
  * Everything goes through the app's own routes (validation, stock, credit rules), so the
    demo data is exactly what the app itself would have produced.

Run the app on the demo data afterwards:
    RICE_SHOP_DB=instance/demo.db .venv/bin/python run.py
"""
import argparse
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app import create_app  # noqa: E402

REAL_DB = ROOT / "instance" / "rice_shop.db"
DEFAULT_DB = ROOT / "instance" / "demo.db"
CSRF = "tok"
TODAY = date.today()


def day(offset: int) -> str:
    """Date relative to today, as YYYY-MM-DD (negative = past)."""
    return (TODAY + timedelta(days=offset)).isoformat()


class Api:
    """Calls the real HTTP routes; stops with a clear message on the first failure."""

    def __init__(self, client):
        self.client = client

    def _call(self, method: str, url: str, body=None):
        kwargs = {"headers": {"X-CSRF-Token": CSRF}}
        if body is not None:
            kwargs["json"] = body
        resp = getattr(self.client, method)(url, **kwargs)
        payload = resp.get_json(silent=True) or {}
        if resp.status_code not in (200, 201) or not payload.get("ok"):
            raise SystemExit(f"{method.upper()} {url} failed [{resp.status_code}]: "
                             f"{payload.get('error', payload)}")
        return payload["data"]

    def get(self, url):
        return self._call("get", url)

    def post(self, url, body=None):
        return self._call("post", url, body)


# --------------------------------------------------------------------------- #
# Sample data
# --------------------------------------------------------------------------- #
# name, price per kg, bag price, bag size (g), purchase cost per kg, bags in stock, loose grams
RICE_TYPES = [
    ("Sona Masoori", 62, 1550, 25000, 48, 20, 5000),
    ("Ponni", 48, 1250, 26000, 36, 15, 2000),
    ("Brown Rice", 80, 1600, 20000, 60, 4, 0),
    ("Idli Rice", 55, 1375, 25000, 40, 8, 0),
    ("Parboiled", 52, 940, 18000, 38, 10, 1500),
    ("Kolam", 58, 1500, 26000, 44, 6, 0),
]

# name, phone, place
CUSTOMERS = [
    ("Raju", "9000000001", "Main Road"),
    ("Lakshmi Stores", "9000000002", "Market Street"),
    ("Mohan Kirana", "9000000003", "Temple Lane"),
    ("Suresh Hotel", "9000000004", "Bus Stand"),
    ("Ammu Canteen", "9000000005", "College Road"),
    ("Shankar Sweets", "9000000006", "Market Street"),
    ("Venkat Mess", "9000000007", "Railway Colony"),
    ("Ganesh Provisions", "9000000008", "New Town"),
]


def seed(api: Api) -> dict:
    # ---- rice types (retail stock) ------------------------------------------
    for name, price, bag_price, size, cost, bags, loose in RICE_TYPES:
        api.post("/api/inventory/rice-types", {
            "type_name": name, "price_per_kg": price, "bag_price": bag_price,
            "bag_size_grams": size, "purchase_cost_per_kg": cost,
            "bags_qty": bags, "loose_grams": loose, "low_stock_bags": 2,
        })

    # ---- customers -----------------------------------------------------------
    cid = {}
    for name, phone, place in CUSTOMERS:
        cid[name] = api.post("/api/customers", {"name": name, "phone": phone, "place": place})["id"]

    # ---- retail sales (cash, UPI, credit, customer price, loose that opens a bag) -
    retail = []
    retail.append(api.post("/api/sales/retail", {  # cash, no customer
        "sale_date": day(-12), "payment_mode": "cash",
        "items": [{"rice_type": "Sona Masoori", "item_kind": "loose", "grams": 1500}]}))
    retail.append(api.post("/api/sales/retail", {  # UPI, two bags
        "sale_date": day(-10), "payment_mode": "upi", "customer_id": cid["Raju"],
        "items": [{"rice_type": "Ponni", "item_kind": "bag", "bags": 2}]}))
    credit_old = api.post("/api/sales/retail", {  # credit with advance, due date already passed
        "sale_date": day(-20), "payment_mode": "credit", "customer_id": cid["Lakshmi Stores"],
        "advance_paid": 200, "due_date": day(-2),
        "items": [{"rice_type": "Sona Masoori", "item_kind": "loose", "grams": 10000}]})
    retail.append(credit_old)
    retail.append(api.post("/api/sales/retail", {  # loose 3 kg from zero loose stock -> opens a bag
        "sale_date": day(-7), "payment_mode": "cash", "customer_id": cid["Mohan Kirana"],
        "items": [{"rice_type": "Idli Rice", "item_kind": "loose", "grams": 3000}]}))
    retail.append(api.post("/api/sales/retail", {  # customer-specific lower price (Rs 58 instead of Rs 62)
        "sale_date": day(-5), "payment_mode": "cash", "customer_id": cid["Shankar Sweets"],
        "items": [{"rice_type": "Sona Masoori", "item_kind": "loose", "grams": 10000, "unit_price": 58}]}))
    credit_kolam = api.post("/api/sales/retail", {  # credit, no advance, due in 15 days
        "sale_date": day(-3), "payment_mode": "credit", "customer_id": cid["Ammu Canteen"],
        "due_date": day(15),
        "items": [{"rice_type": "Kolam", "item_kind": "bag", "bags": 2}]})
    retail.append(credit_kolam)
    retail.append(api.post("/api/sales/retail", {  # today, UPI, loose 2 kg from zero stock -> opens a bag
        "sale_date": day(0), "payment_mode": "upi", "customer_id": cid["Suresh Hotel"],
        "items": [{"rice_type": "Brown Rice", "item_kind": "loose", "grams": 2000}]}))

    # ---- wholesale sales (bags, no stock change) -----------------------------
    wholesale = []
    credit_wh = api.post("/api/sales/wholesale", {  # credit with advance and a due date
        "customer_id": cid["Venkat Mess"], "sent_on": day(-6), "call_received_on": day(-7),
        "payment_mode": "credit", "advance_paid": 5000, "due_date": day(10),
        "items": [{"rice_type": "Sona Masoori", "item_kind": "bag", "bags": 10,
                   "bag_size_grams": 25000, "unit_price": 1400}]})
    wholesale.append(credit_wh)
    wholesale.append(api.post("/api/sales/wholesale", {  # cash, a new rice name typed in
        "customer_id": cid["Shankar Sweets"], "sent_on": day(-4), "payment_mode": "cash",
        "items": [{"rice_type": "Samba (new crop)", "item_kind": "bag", "bags": 5,
                   "bag_size_grams": 26000, "unit_price": 1350}]}))
    wholesale.append(api.post("/api/sales/wholesale", {  # UPI
        "customer_id": cid["Lakshmi Stores"], "sent_on": day(-1), "call_received_on": day(-2),
        "payment_mode": "upi",
        "items": [{"rice_type": "Ponni", "item_kind": "bag", "bags": 3,
                   "bag_size_grams": 26000, "unit_price": 1280}]}))

    # ---- reminders (pending orders): one overdue, one for the future ----------
    api.post("/api/orders", {
        "channel": "retail", "customer_id": cid["Raju"], "requested_for": f"{day(-2)} 10:00",
        "notes": "Wants it before lunch",
        "items": [{"rice_type": "Ponni", "item_kind": "bag", "bags": 1}]})
    api.post("/api/orders", {
        "channel": "wholesale", "customer_id": cid["Venkat Mess"], "requested_for": f"{day(3)} 09:30",
        "call_received_on": day(-1), "notes": "Call again to confirm the truck",
        "items": [{"rice_type": "Sona Masoori", "item_kind": "bag", "bags": 4,
                   "bag_size_grams": 25000, "unit_price": 1400}]})

    # ---- credit payments -------------------------------------------------------
    api.post(f"/api/credits/entries/{credit_kolam['credit_id']}/payments",
             {"amount": 1000, "mode": "upi", "paid_on": day(-1)})
    api.post(f"/api/credits/customer/{cid['Lakshmi Stores']}/payments",   # lump sum, applied oldest first
             {"amount": 200, "mode": "cash", "paid_on": day(-5)})
    api.post(f"/api/credits/entries/{credit_wh['credit_id']}/payments",
             {"amount": 2000, "mode": "cash", "paid_on": day(-2)})

    outstanding = api.get("/api/credits/summary")["outstanding_total"]
    return {"rice": len(RICE_TYPES), "customers": len(CUSTOMERS), "retail": len(retail),
            "wholesale": len(wholesale), "reminders": 2, "payments": 3, "outstanding": outstanding}


def main() -> None:
    parser = argparse.ArgumentParser(description="Create a demo database with sample shop data.")
    parser.add_argument("--db", default=str(DEFAULT_DB),
                        help="demo database file to create (default: instance/demo.db)")
    parser.add_argument("--force-real", action="store_true",
                        help="allow writing to the REAL database instance/rice_shop.db (not recommended)")
    args = parser.parse_args()

    target = Path(args.db).expanduser().resolve()
    if target == REAL_DB.resolve() and not args.force_real:
        sys.exit(f"Refusing to seed the real database {target}. Use the default demo file, "
                 "or pass --force-real if you really mean it.")
    if target.exists() and not args.force_real:
        sys.exit(f"{target} already exists. Delete it first, or choose another file with --db.")
    if target == REAL_DB.resolve():
        print(f"WARNING: --force-real given; seeding the REAL database {target}")

    target.parent.mkdir(parents=True, exist_ok=True)
    app = create_app({"DATABASE": str(target), "SECRET_KEY": "demo"})

    client = app.test_client()
    with client.session_transaction() as s:   # same session keys the real login sets
        s["uid"] = "anand"
        s["csrf"] = CSRF

    stats = seed(Api(client))

    shown = target.relative_to(ROOT) if target.is_relative_to(ROOT) else target
    print(f"Demo data written to {target}")
    print(f"  rice types: {stats['rice']}   customers: {stats['customers']}")
    print(f"  retail sales: {stats['retail']}   wholesale sales: {stats['wholesale']}")
    print(f"  reminders (pending): {stats['reminders']}   credit payments: {stats['payments']}")
    print(f"  outstanding credit: Rs {stats['outstanding']}")
    print()
    print("Run the app on this data:")
    print(f"  RICE_SHOP_DB={shown} .venv/bin/python run.py")
    print("Log in as anand / anand1970 (super user) or admin / admin@123.")


if __name__ == "__main__":
    main()

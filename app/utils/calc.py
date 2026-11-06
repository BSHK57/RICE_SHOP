"""
calc.py - every calculation the shop needs, in one place, with NO database or Flask code.

Pure functions only, so they are trivially unit-testable (see tests/test_calc.py).

Units
  * loose quantity ........ integer GRAMS
  * bag quantity .......... integer count; bag size in integer GRAMS
  * per-kg prices ......... float rupees / kg
  * per-bag prices ........ float rupees / bag
  * line & sale amounts ... integer rupees, rounded half-up (shop practice: whole rupees)
"""
from __future__ import annotations

from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Iterable, Sequence

GRAMS_PER_KG = 1000


class StockError(ValueError):
    """Raised when stock cannot satisfy a request. Message is shown to the user."""


# ----------------------------- unit conversion ----------------------------- #
def kg_to_grams(kg: float | int | str | Decimal) -> int:
    """2.5 -> 2500, '0.05' -> 50. Decimal-safe so 0.1 + 0.2 style errors never reach the DB."""
    return int((Decimal(str(kg)) * GRAMS_PER_KG).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def grams_to_kg(grams: int) -> float:
    return float(Decimal(grams) / GRAMS_PER_KG)


def format_kg(grams: int) -> str:
    """2500 -> '2.5 kg', 250 -> '250 g', 0 -> '0 g'."""
    if grams and abs(grams) < GRAMS_PER_KG:
        return f"{grams} g"
    kg = Decimal(grams) / GRAMS_PER_KG
    return f"{kg.normalize():f} kg"


# -------------------------------- money ----------------------------------- #
def round_money(value: float | int | Decimal) -> int:
    """Round half-up to whole rupees: 6.25 -> 6, 6.5 -> 7, 62.49 -> 62."""
    return int(Decimal(str(value)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def loose_amount(price_per_kg: float, grams: int) -> int:
    """Amount for a loose quantity. 250 g @ 62.5/kg -> 16 (15.625 rounded)."""
    return round_money(Decimal(str(price_per_kg)) * Decimal(grams) / GRAMS_PER_KG)


def bag_amount(price_per_bag: float, bags: int) -> int:
    return round_money(Decimal(str(price_per_bag)) * bags)


def default_bag_price(price_per_kg: float, bag_size_grams: int) -> float:
    """Fallback bag price when a type has none: per-kg price x bag weight."""
    return float(Decimal(str(price_per_kg)) * Decimal(bag_size_grams) / GRAMS_PER_KG)


def purchase_cost_for_line(item_kind: str, purchase_cost_per_kg: float | None,
                           grams: int, bags: int, bag_size_grams: int | None) -> int | None:
    """Shop's own cost of the goods on a line (for profit). None when cost is unknown."""
    if purchase_cost_per_kg is None:
        return None
    total_grams = grams if item_kind == "loose" else bags * (bag_size_grams or 0)
    return loose_amount(purchase_cost_per_kg, total_grams)


def discount(list_amount: int, amount: int) -> int:
    """Positive = customer got it cheaper than the standard price."""
    return list_amount - amount


def profit(amount: int, cost: int | None) -> int | None:
    return None if cost is None else amount - cost


# -------------------------- loose / bag arithmetic -------------------------- #
def split_loose_into_bags(grams: int, bag_size_grams: int | None) -> tuple[int, int]:
    """
    A loose request that reaches a full bag is really a bag sale
    ("if he asks 25 kg, treat it as a bag").
    Returns (bags, remaining_loose_grams).  25000 @ 25kg bag -> (1, 0); 27000 -> (1, 2000);
    24000 -> (0, 24000); no bag size known -> (0, grams).
    """
    if not bag_size_grams or bag_size_grams <= 0:
        return 0, grams
    return grams // bag_size_grams, grams % bag_size_grams


def plan_loose_deduction(bags_qty: int, loose_grams: int, bag_size_grams: int | None,
                         want_grams: int) -> dict:
    """
    Take `want_grams` of loose rice from stock. When the open loose rice is not enough,
    whole bags are opened (bag count goes down, loose goes up) just as the shopkeeper does.

    Returns {bags_opened, new_bags, new_loose}; raises StockError when impossible.
      stock (bags=3, loose=1000, size=25000) want 5000  -> open 1 -> (bags 2, loose 21000)
    """
    if want_grams <= 0:
        raise StockError("Quantity must be greater than zero.")
    if loose_grams >= want_grams:
        return {"bags_opened": 0, "new_bags": bags_qty, "new_loose": loose_grams - want_grams}
    shortfall = want_grams - loose_grams
    if not bag_size_grams:
        raise StockError(f"Only {format_kg(loose_grams)} loose stock left and no bag size is set to open a bag.")
    bags_needed = -(-shortfall // bag_size_grams)  # ceil division
    if bags_needed > bags_qty:
        available = loose_grams + bags_qty * bag_size_grams
        raise StockError(f"Not enough stock: need {format_kg(want_grams)}, only {format_kg(available)} available.")
    new_loose = loose_grams + bags_needed * bag_size_grams - want_grams
    return {"bags_opened": bags_needed, "new_bags": bags_qty - bags_needed, "new_loose": new_loose}


def plan_bag_deduction(bags_qty: int, want_bags: int) -> dict:
    if want_bags <= 0:
        raise StockError("Number of bags must be greater than zero.")
    if want_bags > bags_qty:
        raise StockError(f"Not enough bags: need {want_bags}, only {bags_qty} in stock.")
    return {"new_bags": bags_qty - want_bags}


def open_bags(bags_qty: int, loose_grams: int, bag_size_grams: int | None, count: int = 1) -> dict:
    """Manually turn `count` bags into loose rice."""
    if not bag_size_grams:
        raise StockError("Set the bag size for this rice type before opening bags.")
    if count <= 0 or count > bags_qty:
        raise StockError(f"Cannot open {count} bag(s); only {bags_qty} in stock.")
    return {"new_bags": bags_qty - count, "new_loose": loose_grams + count * bag_size_grams}


# ------------------------------- credit maths ------------------------------ #
def credit_balance(amount: int, paid: int) -> int:
    return amount - paid


def allocate_fifo(payment: int, entries: Sequence[dict]) -> tuple[list[dict], int]:
    """
    Spread one lump-sum payment over a customer's open credits, oldest first.
    `entries` = [{'id': .., 'balance': ..}, ...] ALREADY sorted oldest -> newest.
    Returns ([{'credit_id', 'amount'}, ...], leftover). leftover > 0 means over-payment.
    """
    allocations, remaining = [], payment
    for e in entries:
        if remaining <= 0:
            break
        take = min(remaining, e["balance"])
        if take > 0:
            allocations.append({"credit_id": e["id"], "amount": take})
            remaining -= take
    return allocations, remaining


def credit_part_of_sale(total: int, payment_mode: str, advance_paid: int = 0) -> tuple[int, int]:
    """
    -> (paid_now, credit_amount) for a sale.
      cash/upi : everything paid now, no credit
      credit   : `advance_paid` (may be 0) paid now, the rest is credit
    """
    if payment_mode in ("cash", "upi"):
        return total, 0
    if advance_paid < 0 or advance_paid >= total:
        raise ValueError("Advance must be between 0 and less than the total for a credit sale.")
    return advance_paid, total - advance_paid


# --------------------------------- dates ----------------------------------- #
def is_overdue(due_date: str | None, balance: int, today: str | None = None) -> bool:
    """True when something is still owed and the due date is before today."""
    if not due_date or balance <= 0:
        return False
    return due_date < (today or date.today().isoformat())


def is_order_overdue(requested_for: str, now: datetime | None = None) -> bool:
    """requested_for is 'YYYY-MM-DD HH:MM' (or with seconds)."""
    now = now or datetime.now()
    return requested_for[:16] < now.strftime("%Y-%m-%d %H:%M")


def sum_amounts(rows: Iterable[dict], key: str = "amount") -> int:
    return sum(int(r.get(key) or 0) for r in rows)

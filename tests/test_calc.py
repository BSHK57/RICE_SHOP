import pytest

from app.utils import calc
from app.utils.calc import StockError


def test_units():
    assert calc.kg_to_grams(2.5) == 2500
    assert calc.kg_to_grams("0.05") == 50
    assert calc.kg_to_grams(0.1 + 0.2) == 300
    assert calc.format_kg(250) == "250 g" and calc.format_kg(2500) == "2.5 kg" and calc.format_kg(25000) == "25 kg"


def test_money():
    assert calc.round_money(6.5) == 7 and calc.round_money(6.49) == 6
    assert calc.loose_amount(62.5, 250) == 16          # 15.625
    assert calc.loose_amount(60, 100) == 6
    assert calc.bag_amount(1450, 3) == 4350


def test_split_loose_into_bags():
    assert calc.split_loose_into_bags(25000, 25000) == (1, 0)
    assert calc.split_loose_into_bags(27000, 25000) == (1, 2000)
    assert calc.split_loose_into_bags(24000, 25000) == (0, 24000)
    assert calc.split_loose_into_bags(24000, None) == (0, 24000)


def test_loose_deduction_opens_bags():
    assert calc.plan_loose_deduction(3, 5000, 25000, 2000) == {"bags_opened": 0, "new_bags": 3, "new_loose": 3000}
    assert calc.plan_loose_deduction(3, 1000, 25000, 5000) == {"bags_opened": 1, "new_bags": 2, "new_loose": 21000}
    r = calc.plan_loose_deduction(3, 0, 20000, 45000)
    assert r == {"bags_opened": 3, "new_bags": 0, "new_loose": 15000}
    with pytest.raises(StockError):
        calc.plan_loose_deduction(1, 0, 25000, 30000)
    with pytest.raises(StockError):
        calc.plan_loose_deduction(5, 100, None, 500)


def test_bag_deduction_and_open():
    assert calc.plan_bag_deduction(5, 2) == {"new_bags": 3}
    with pytest.raises(StockError):
        calc.plan_bag_deduction(1, 2)
    assert calc.open_bags(2, 100, 25000, 1) == {"new_bags": 1, "new_loose": 25100}
    with pytest.raises(StockError):
        calc.open_bags(0, 0, 25000)


def test_fifo_and_credit_part():
    allocs, left = calc.allocate_fifo(1500, [{"id": 1, "balance": 1000}, {"id": 2, "balance": 800}])
    assert allocs == [{"credit_id": 1, "amount": 1000}, {"credit_id": 2, "amount": 500}] and left == 0
    assert calc.allocate_fifo(100, [{"id": 1, "balance": 50}]) == ([{"credit_id": 1, "amount": 50}], 50)
    assert calc.credit_part_of_sale(500, "cash") == (500, 0)
    assert calc.credit_part_of_sale(500, "credit", 100) == (100, 400)
    with pytest.raises(ValueError):
        calc.credit_part_of_sale(500, "credit", 500)


def test_profit_discount_cost_overdue():
    assert calc.discount(1000, 950) == 50 and calc.profit(950, 900) == 50 and calc.profit(950, None) is None
    assert calc.purchase_cost_for_line("bag", 50.0, 0, 2, 25000) == 2500
    assert calc.purchase_cost_for_line("loose", None, 1000, 0, None) is None
    assert calc.is_overdue("2026-01-01", 10, "2026-02-01") and not calc.is_overdue("2026-01-01", 0, "2026-02-01")

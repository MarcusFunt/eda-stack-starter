"""Regression tests for the typed-constraint experiment."""
from decimal import Decimal

import pytest

from edastack.experimental_constraints import (
    CircuitIR,
    ConstraintError,
    Interval,
    Pin,
    Quantity,
    choose_e24_divider,
    example_report,
)


def test_units_canonicalize_and_reject_dimension_mismatch():
    assert Quantity.parse("3300mV") == Quantity.parse("3.3V")
    assert Quantity.parse("1000uA") == Quantity.parse("1mA")
    assert Interval.between("2V", "3V").intersect(Interval.between("2500mV", "4V")) == (
        Interval.between("2.5V", "3V")
    )
    with pytest.raises(ConstraintError, match="different dimensions"):
        Interval.between("3V", "4V").intersect(Interval.between("1mA", "2mA"))
    with pytest.raises(ConstraintError, match="Expected voltage"):
        Pin("x", "power", "receiver", Interval.between("1mA", "2mA"))
    with pytest.raises(ConstraintError, match="reversed"):
        Interval.between("4V", "3V")


def test_compatible_power_and_canonical_hash():
    c1 = CircuitIR()
    c1.add(Pin("U.VDD", "power", "receiver", Interval.between("3V", "3.6V")))
    c1.add(Pin("REG.OUT", "power", "driver", Interval.between("3.2V", "3.4V")))
    c1.connect("VCC", "REG.OUT", "U.VDD")
    c2 = CircuitIR()
    c2.add(Pin("REG.OUT", "power", "driver", Interval.between("3200mV", "3400mV")))
    c2.add(Pin("U.VDD", "power", "receiver", Interval.between("3000mV", "3600mV")))
    c2.connect("VCC", "U.VDD", "REG.OUT")
    assert c1.report()["status"] == "pass"
    assert c1.report()["source_hash"] == c2.report()["source_hash"]
    assert c1.report()["resolved_nets"]["VCC"]["voltage_intersection"] == Interval.between(
        "3.2V", "3.4V"
    ).to_json()


def test_invalid_5v_to_3v3_supply_is_not_accepted():
    c = CircuitIR()
    c.add(Pin("REG.OUT", "power", "driver", Interval.between("4.75V", "5.25V")))
    c.add(Pin("MCU.VDD", "power", "receiver", Interval.between("3V", "3.6V")))
    c.connect("VCC", "REG.OUT", "MCU.VDD")
    assert c.report()["status"] == "review_required"
    assert {"net": "VCC", "code": "incompatible_voltage"} in c.report()["findings"]


def test_multiple_drivers_and_domain_mismatch_fail_closed():
    c = CircuitIR()
    c.add(Pin("A.OUT", "digital", "driver", Interval.between("0V", "3.3V")))
    c.add(Pin("B.OUT", "digital", "driver", Interval.between("0V", "3.3V")))
    c.add(Pin("C.IN", "analog", "receiver", Interval.between("0V", "3.3V")))
    c.connect("SHARED", "A.OUT", "B.OUT", "C.IN")
    codes = {item["code"] for item in c.report()["findings"]}
    assert "multiple_drivers" in codes
    assert "domain_mismatch" in codes


def test_invalid_net_ownership_and_pin_identity():
    c = CircuitIR()
    c.add(Pin("U1.1", "passive", "passive"))
    c.add(Pin("U2.1", "passive", "passive"))
    with pytest.raises(ConstraintError, match="Unknown physical pins"):
        c.connect("A", "missing")
    c.connect("A", "U1.1", "U2.1")
    with pytest.raises(ConstraintError, match="both A and B"):
        c.connect("B", "U1.1")
    with pytest.raises(ConstraintError, match="Repeated connection"):
        c.connect("A", "U1.1")
    with pytest.raises(ConstraintError, match="duplicate pin identity"):
        c.add(Pin("U1.1", "passive", "passive"))


def test_e24_divider_conservative_voltage_current_and_power():
    result = choose_e24_divider(
        Interval.between("11.4V", "12.6V"),
        Interval.between("3V", "3.6V"),
        Quantity.parse("1mA"),
    )
    assert result["status"] == "analytically_feasible_not_simulated"
    assert Decimal(result["vout_min_v"]) >= Decimal("3")
    assert Decimal(result["vout_max_v"]) <= Decimal("3.6")
    assert Decimal(result["current_max_a"]) <= Decimal("0.001")
    assert Decimal(result["conservative_top_power_w"]) <= Decimal("0.125")


def test_impossible_divider_fails():
    with pytest.raises(ConstraintError, match="No feasible"):
        choose_e24_divider(
            Interval.between("4V", "4.5V"),
            Interval.between("5V", "5.1V"),
            Quantity.parse("1mA"),
        )


def test_example_is_reproducible():
    assert example_report() == example_report()
    assert example_report()["status"] == "pass"


def test_partial_overlap_does_not_prove_driven_supply_safe():
    c = CircuitIR()
    c.add(Pin("REG.OUT", "power", "driver", Interval.between("3V", "4V")))
    c.add(Pin("MCU.VDD", "power", "receiver", Interval.between("3.5V", "4.5V")))
    c.connect("VCC", "REG.OUT", "MCU.VDD")
    assert "incompatible_voltage" in {f["code"] for f in c.report()["findings"]}


def test_third_pin_cannot_erase_an_earlier_voltage_contradiction():
    c = CircuitIR()
    c.add(Pin("REG.OUT", "power", "driver", Interval.between("5V", "5V")))
    c.add(Pin("MCU.VDD", "power", "receiver", Interval.between("3.3V", "3.3V")))
    c.add(Pin("LOAD.VDD", "power", "receiver", Interval.between("5V", "5V")))
    c.connect("VCC", "REG.OUT", "MCU.VDD", "LOAD.VDD")
    assert "incompatible_voltage" in {f["code"] for f in c.report()["findings"]}

"""Experimental typed electrical constraints; independent of Circuit JSON geometry.

No SPICE or manufacturer-rating claims are implied by these checks.
All values are SI Decimal, and deterministic serialized reports are hashable.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path

UNITS = {
    "V": ("voltage", "1"), "mV": ("voltage", "0.001"),
    "A": ("current", "1"), "mA": ("current", "0.001"),
    "uA": ("current", "0.000001"), "µA": ("current", "0.000001"),
    "ohm": ("resistance", "1"), "kohm": ("resistance", "1000"),
    "W": ("power", "1"), "mW": ("power", "0.001"),
}
E24 = (10, 11, 12, 13, 15, 16, 18, 20, 22, 24, 27, 30,
       33, 36, 39, 43, 47, 51, 56, 62, 68, 75, 82, 91)


class ConstraintError(ValueError):
    """A specification is contradictory, malformed or dimensionally invalid."""


def _number(n: Decimal) -> str:
    return format(n.normalize(), "f")


@dataclass(frozen=True)
class Quantity:
    value: Decimal
    kind: str

    @classmethod
    def parse(cls, text: str) -> Quantity:
        match = re.fullmatch(r"\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*([A-Za-zµ]+)\s*", text)
        if not match or match.group(2) not in UNITS:
            raise ConstraintError(f"Unsupported physical quantity: {text!r}")
        kind, scale = UNITS[match.group(2)]
        return cls(Decimal(match.group(1)) * Decimal(scale), kind)

    def ensure(self, kind: str) -> Decimal:
        if self.kind != kind:
            raise ConstraintError(f"Expected {kind}, received {self.kind}")
        return self.value

    def to_json(self) -> dict:
        return {"si": _number(self.value), "dimension": self.kind}


@dataclass(frozen=True)
class Interval:
    low: Quantity
    high: Quantity

    def __post_init__(self) -> None:
        if self.low.kind != self.high.kind or self.low.value > self.high.value:
            raise ConstraintError("Interval dimensions differ or endpoints are reversed")

    @classmethod
    def between(cls, low: str, high: str) -> Interval:
        return cls(Quantity.parse(low), Quantity.parse(high))

    def intersect(self, other: Interval) -> Interval | None:
        if self.low.kind != other.low.kind:
            raise ConstraintError("Cannot intersect intervals of different dimensions")
        lo = max(self.low.value, other.low.value)
        hi = min(self.high.value, other.high.value)
        if lo > hi:
            return None
        return Interval(Quantity(lo, self.low.kind), Quantity(hi, self.low.kind))

    def to_json(self) -> dict:
        return {"min": self.low.to_json(), "max": self.high.to_json()}


@dataclass(frozen=True)
class Pin:
    identity: str
    signal: str  # power | digital | analog | passive
    direction: str  # driver | receiver | passive
    accepted_voltage: Interval | None = None

    def __post_init__(self) -> None:
        if self.signal not in {"power", "digital", "analog", "passive"}:
            raise ConstraintError(f"Unknown signal domain: {self.signal}")
        if self.direction not in {"driver", "receiver", "passive"}:
            raise ConstraintError(f"Unknown pin direction: {self.direction}")
        if self.accepted_voltage is not None:
            self.accepted_voltage.low.ensure("voltage")

    def to_json(self) -> dict:
        return {
            "id": self.identity, "domain": self.signal, "direction": self.direction,
            "accepted_voltage": self.accepted_voltage.to_json() if self.accepted_voltage else None,
        }


@dataclass
class CircuitIR:
    pins: dict[str, Pin] = field(default_factory=dict)
    nets: dict[str, list[str]] = field(default_factory=dict)

    def add(self, pin: Pin) -> None:
        if not pin.identity or pin.identity in self.pins:
            raise ConstraintError(f"Empty or duplicate pin identity: {pin.identity!r}")
        self.pins[pin.identity] = pin

    def connect(self, net: str, *identities: str) -> None:
        if not net or not identities:
            raise ConstraintError("Net and identities must be nonempty")
        if len(set(identities)) != len(identities):
            raise ConstraintError(f"Duplicate pin on net {net}")
        missing = set(identities).difference(self.pins)
        if missing:
            raise ConstraintError(f"Unknown physical pins: {sorted(missing)}")
        owners = {p: name for name, ps in self.nets.items() for p in ps}
        for p in identities:
            if p in owners and owners[p] != net:
                raise ConstraintError(f"Pin {p} belongs to both {owners[p]} and {net}")
        attached = self.nets.setdefault(net, [])
        for p in identities:
            if p in attached:
                raise ConstraintError(f"Repeated connection of {p} to {net}")
            attached.append(p)

    def analyze(self) -> dict:
        findings = []
        derived = {}
        for name, ids in sorted(self.nets.items()):
            pins = [self.pins[p] for p in ids]
            drivers = [p.identity for p in pins if p.direction == "driver"]
            domains = sorted({p.signal for p in pins if p.signal != "passive"})
            voltage: Interval | None = None
            incompatible_voltage = False
            voltage_pins = [p for p in pins if p.accepted_voltage is not None]
            for p in voltage_pins:
                if incompatible_voltage:
                    break  # Never reset a contradictory intersection.
                voltage = p.accepted_voltage if voltage is None else voltage.intersect(p.accepted_voltage)
                if voltage is None:
                    incompatible_voltage = True
            # A nonempty intersection is NOT sufficient when the source can
            # produce values outside the receiver's absolute allowed range.
            source = next((p for p in pins if p.direction == "driver"), None)
            if len(drivers) == 1 and source and source.accepted_voltage:
                for p in pins:
                    if p is source or p.accepted_voltage is None:
                        continue
                    driven = source.accepted_voltage
                    allowed = p.accepted_voltage
                    if driven.low.value < allowed.low.value or driven.high.value > allowed.high.value:
                        incompatible_voltage = True
            if len(drivers) > 1:
                findings.append({"net": name, "code": "multiple_drivers", "drivers": drivers})
            if len(domains) > 1:
                findings.append({"net": name, "code": "domain_mismatch", "domains": domains})
            if incompatible_voltage:
                findings.append({"net": name, "code": "incompatible_voltage"})
            if len(ids) < 2:
                findings.append({"net": name, "code": "single_pin_net"})
            derived[name] = {
                "pins": sorted(ids), "voltage_intersection": voltage.to_json() if voltage else None,
            }
        return {
            "status": "pass" if not findings else "review_required",
            "findings": findings,
            "resolved_nets": derived,
        }

    def canonical(self) -> dict:
        return {
            "version": 1,
            "pins": [self.pins[k].to_json() for k in sorted(self.pins)],
            "nets": {k: sorted(v) for k, v in sorted(self.nets.items())},
        }

    def report(self) -> dict:
        canonical = self.canonical()
        digest = hashlib.sha256(json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        return {"circuit": canonical, "source_hash": digest, **self.analyze()}


def choose_e24_divider(
    supply: Interval, output: Interval, max_current: Quantity,
    *, tolerance: Decimal = Decimal("0.01"), max_power: Quantity = Quantity.parse("125mW"),
    preferred_current: Quantity = Quantity.parse("300uA"),
) -> dict:
    """Choose two E24 resistors by worst-case bounds (not SPICE verification).

    Resistance uncertainty is independent; voltage is a bounded interval.
    The power bound is conservative, not a tight global maximum.
    """
    supply.low.ensure("voltage")
    output.low.ensure("voltage")
    imax = max_current.ensure("current")
    pmax = max_power.ensure("power")
    ipref = preferred_current.ensure("current")
    if not 0 <= tolerance < 1 or supply.low.value <= 0 or output.low.value <= 0 or imax <= 0:
        raise ConstraintError("Invalid positive operating constraints or resistor tolerance")
    candidates: list[tuple[Decimal, Decimal, Decimal, dict]] = []
    values = sorted({Decimal(v) * (Decimal(10) ** decade) for decade in range(2, 6) for v in E24})
    target = (output.low.value + output.high.value) / 2
    for top in values:
        for bottom in values:
            rtop_min, rtop_max = top * (1 - tolerance), top * (1 + tolerance)
            rbot_min, rbot_max = bottom * (1 - tolerance), bottom * (1 + tolerance)
            low = supply.low.value * rbot_min / (rtop_max + rbot_min)
            high = supply.high.value * rbot_max / (rtop_min + rbot_max)
            current_max = supply.high.value / (rtop_min + rbot_min)
            upper_bound_power = supply.high.value**2 * rtop_max / (rtop_min + rbot_min)**2
            if low < output.low.value or high > output.high.value:
                continue
            if current_max > imax or upper_bound_power > pmax:
                continue
            nominal = (supply.low.value + supply.high.value) / 2 * bottom / (top + bottom)
            current_nom = (supply.low.value + supply.high.value) / 2 / (top + bottom)
            score = abs(nominal - target) / target + abs(current_nom - ipref) / ipref / 8
            details = {
                "r_top_ohm": _number(top), "r_bottom_ohm": _number(bottom),
                "vout_min_v": _number(low), "vout_max_v": _number(high),
                "current_max_a": _number(current_max),
                "conservative_top_power_w": _number(upper_bound_power),
                "resistor_tolerance": _number(tolerance),
                "series": "E24", "status": "analytically_feasible_not_simulated",
            }
            candidates.append((score, top, bottom, details))
    if not candidates:
        raise ConstraintError("No feasible E24 divider for these conservative constraints")
    return min(candidates, key=lambda c: (c[0], c[1], c[2]))[3]


def example_report() -> dict:
    circuit = CircuitIR()
    circuit.add(Pin("U1.VOUT", "power", "driver", Interval.between("3.135V", "3.465V")))
    circuit.add(Pin("U2.VDD", "power", "receiver", Interval.between("3V", "3.6V")))
    circuit.add(Pin("C1.1", "passive", "passive"))
    circuit.connect("+3V3", "U1.VOUT", "U2.VDD", "C1.1")
    report = circuit.report()
    report["divider"] = choose_e24_divider(
        Interval.between("11.4V", "12.6V"),
        Interval.between("3V", "3.6V"),
        Quantity.parse("1mA"),
    )
    report["limitations"] = [
        "A net voltage intersection does not prove operating-point behavior",
        "E24 selection does not select manufacturer parts or verify SPICE behavior",
        "Digital timing, source impedance, thermal behavior, and protection are not modeled",
    ]
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Unit-aware experimental circuit-constraint proof")
    parser.add_argument("--output", type=Path, help="Optional JSON evidence path")
    args = parser.parse_args()
    result = json.dumps(example_report(), indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(result, encoding="utf-8")
    print(result)


if __name__ == "__main__":
    main()

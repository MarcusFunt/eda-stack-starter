"""Model-backed, source-graph-derived SPICE acceptance proof for the first open-drain benchmark.

This deliberately supports one strictly checked circuit family; unsupported components
or topology fail, rather than receiving guessed equivalent SPICE models.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
from pathlib import Path

from edastack.core import run_project

_ALLOWED_REFERENCE = re.compile(r"^(R[0-9]+|C[0-9]+|Q[0-9]+|J[0-9]+)$")


def _normalize_part_number(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.casefold())


class ModelBackedError(RuntimeError):
    pass


def _load_json(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ModelBackedError("Expected a JSON object: " + str(path))
    return data


def _number(value: object, unit: str) -> str:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ModelBackedError("Non-numeric " + unit + " value")
    from math import isfinite
    if not isfinite(value) or value <= 0 or value >= 1e9:
        raise ModelBackedError("Unsupported " + unit + " value")
    return f"{value:.12g}"


def build_open_drain_spice(
    build_dir: Path,
    model_path: Path,
    catalog_path: Path,
    output_dir: Path,
) -> dict:
    """Translate *the compiled TSX connectivity* into SPICE using an authenticated model.

    The output is a simulation fixture, NOT a production-verified model or board.
    """
    build_dir = build_dir.resolve()
    output_dir = output_dir.resolve()
    if output_dir == build_dir or build_dir in output_dir.parents:
        raise ModelBackedError("Simulation output must not overwrite the circuit build")
    if output_dir.exists():
        raise ModelBackedError("Refusing to overwrite existing simulated evidence")
    graph = _load_json(build_dir / "source-graph.json")
    parts = _load_json(build_dir / "parts-validation.json")
    catalog = _load_json(catalog_path)
    models = catalog.get("models")
    if not isinstance(models, list):
        raise ModelBackedError("Vendor model catalog missing")
    device = next((item for item in models if item.get("id") == "diodes-2n7002-2017"), None)
    if not isinstance(device, dict):
        raise ModelBackedError("2N7002 vendor-model entry missing")
    bytes_ = model_path.read_bytes()
    digest = hashlib.sha256(bytes_).hexdigest()
    if digest != device["sha256"]:
        raise ModelBackedError("Vendor model SHA-256 mismatch")
    header = bytes_.decode("utf-8", errors="replace").upper()
    if not re.search(r"(?m)^\.SUBCKT\s+N7002\s+10\s+20\s+30\s*$", header):
        raise ModelBackedError("Vendor model terminal declaration changed")

    components = graph.get("components")
    nets = graph.get("nets")
    if not isinstance(components, list) or not isinstance(nets, list):
        raise ModelBackedError("Canonical source graph incomplete")
    components_by_ref = {c["reference"]: c for c in components}
    expected = {"J1", "J2", "Q1", "R1", "R2", "R3", "C1"}
    # A generated *schematic-only* symbol is allowed, but not a second transistor.
    unexpected = set(components_by_ref) - expected
    if set(components_by_ref) - unexpected != expected:
        raise ModelBackedError("Missing required open-drain components")
    if unexpected:
        if unexpected != {"Q1A"}:
            raise ModelBackedError("Unsupported source components: " + ", ".join(sorted(unexpected)))
    if len(components_by_ref) != len(components):
        raise ModelBackedError("Duplicate component references")

    pin_net = {}
    by_name = {}
    for net in nets:
        if not isinstance(net, dict):
            raise ModelBackedError("Invalid net record")
        names = net.get("names")
        if not isinstance(names, list) or len(names) != 1:
            raise ModelBackedError("Net names must be unique and explicit")
        name = names[0]
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", name):
            raise ModelBackedError("Unsafe net name: " + str(name))
        if name in by_name:
            raise ModelBackedError("Duplicate net name " + name)
        spice = "0" if name == "GND" else "n_" + name.lower()
        by_name[name] = spice
        for pin in net["pins"]:
            if pin in pin_net:
                raise ModelBackedError("Pin assigned to more than one net")
            pin_net[pin] = spice
    if set(by_name) != {"VIN5", "CTRL", "GND", "GATE_FILTERED", "OUT"}:
        raise ModelBackedError("Unexpected or missing named nets")
    required_pins = {
        "J1:1": "VIN5", "J1:2": "CTRL", "J1:3": "GND",
        "J2:1": "OUT", "J2:2": "GND",
        "Q1:1": "GATE_FILTERED", "Q1:2": "GND", "Q1:3": "OUT",
        "R1:1": "VIN5", "R1:2": "OUT",
        "R2:1": "CTRL", "R2:2": "GATE_FILTERED",
        "R3:1": "GATE_FILTERED", "R3:2": "GND",
        "C1:1": "GATE_FILTERED", "C1:2": "GND",
    }
    for pin, name in required_pins.items():
        if pin_net.get(pin) != by_name[name]:
            raise ModelBackedError("Circuit connectivity diverges at " + pin)
    if set(pin_net) != set(required_pins):
        raise ModelBackedError("Unexpected or missing physical-pin connections")

    locked = {p["reference"]: p for p in parts.get("entries", [])}
    if set(locked) != expected or locked["Q1"].get("model_id") != device["id"] or not locked["Q1"].get("model_verified"):
        raise ModelBackedError("Model-bound Q1 and complete part lock required")
    supported_part_numbers = device.get("manufacturer_part_numbers")
    locked_part_number = locked["Q1"].get("manufacturer_part_number")
    if not isinstance(supported_part_numbers, list) or not isinstance(locked_part_number, str) or not any(
        isinstance(part_number, str) and _normalize_part_number(part_number) == _normalize_part_number(locked_part_number)
        for part_number in supported_part_numbers
    ):
        raise ModelBackedError("Vendor model does not match locked Q1 manufacturer part")
    if device.get("terminal_order") != ["D", "G", "S"] or device.get("sot23_physical_pin_map") != {"D": "3", "G": "1", "S": "2"}:
        raise ModelBackedError("Vendor model pin order differs from locked physical package")

    lines = ["* Source graph derived 5 V open-drain switch (external testbench)",
             ".include 2N7002.spice.txt",
             "VDD n_vin5 0 DC 5",
             "VCTRL n_ctrl 0 PULSE(0 5 10u 100n 100n 40u 100u)"]
    for reference in ["R1", "R2", "R3", "C1"]:
        item = components_by_ref[reference]
        prop = item.get("properties", {})
        key = "resistance" if reference.startswith("R") else "capacitance"
        value = _number(prop.get(key), key)
        lines.append(f"{reference} {pin_net[reference + ':1']} {pin_net[reference + ':2']} {value}")
    lines.extend([
        "XQ1 n_out n_gate_filtered 0 N7002",
        ".end",
    ])
    spec = {
        "schema_version": 1,
        "name": "model_backed_open_drain",
        "netlist": "open_drain.cir",
        "parameters": {},
        "scenarios": [{"name": "vendor_model_nominal", "set": {}}],
        "analyses": ["tran 0.1u 80u 0 0.05u"],
        "measurements": [
            {"id": "off_voltage", "directive": "meas tran off_voltage FIND v(n_out) AT=5u", "unit": "V", "min": 4.8, "max": 5.01},
            {"id": "on_voltage", "directive": "meas tran on_voltage FIND v(n_out) AT=40u", "unit": "V", "min": -0.05, "max": 0.3},
            {"id": "post_voltage", "directive": "meas tran post_voltage FIND v(n_out) AT=75u", "unit": "V", "min": 4.6, "max": 5.1},
            {"id": "peak_drain", "directive": "meas tran peak_drain MAX v(n_out)", "unit": "V", "min": 4.9, "max": 5.5},
        ],
    }

    output_dir.mkdir(parents=True, exist_ok=False)
    (output_dir / "open_drain.cir").write_text("\n".join(lines) + "\n", encoding="utf-8")
    shutil.copyfile(model_path, output_dir / "2N7002.spice.txt")
    (output_dir / "spec.json").write_text(json.dumps(spec, indent=2) + "\n", encoding="utf-8")
    (output_dir / "provenance.json").write_text(json.dumps({
        "schema_version": 1,
        "source_graph": str(build_dir / "source-graph.json"),
        "model_id": device["id"], "model_sha256": digest,
        "simulator": "ngspice", "model_fidelity": "Vendor SPICE macro-model; no thermal, layout parasitic or silicon qualification",
        "source_net_names": sorted(by_name),
        "testbench": "5V supply, ground-referenced 5V pulse, no external output load",
    }, indent=2) + "\n", encoding="utf-8")
    return {"spec": str(output_dir / "spec.json"), "model_sha256": digest}


def simulate_open_drain(
    build_dir: Path, model_path: Path, catalog_path: Path, output_dir: Path, ngspice: str,
) -> dict:
    generated = build_open_drain_spice(build_dir, model_path, catalog_path, output_dir)
    report = run_project(output_dir / "spec.json", output_dir / "verification", binary=ngspice)
    return {"passed": bool(report["passed"]), **generated,
            "report": str(output_dir / "verification" / "report.json"),
            "scenarios": [{"name": case["scenario"], "passed": bool(case["passed"]),
                           "errors": case["errors"],
                           "checks": [{"id": check["id"], "value": check["value"], "passed": check["passed"]}
                                      for check in case["checks"]]}
                          for case in report["scenarios"]]}

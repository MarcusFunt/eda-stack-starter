"""Unit-level checks for the Topola DSN mutation and session-metrics benchmark.

The actual Topola binary and KiCad DRC are exercised separately on a real board.
"""
import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "experiments" / "topola" / "benchmark.py"
spec = importlib.util.spec_from_file_location("eda_topola_benchmark", SCRIPT)
assert spec and spec.loader
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


def test_place_mutation_changes_only_requested_component():
    source = (ROOT / "experiments" / "topola" / "fixtures" / "bridge.dsn").read_text()
    mutated = benchmark.shift_placement(source, "D3", -1.5)
    assert mutated != source
    assert "(place D3 116610.000000 -80010.000000 front 180.000000" in mutated
    assert "(place D2 118110.000000 -74930.000000" in mutated
    assert "(place J1 101600.000000 -74930.000000" in mutated
    assert benchmark.shift_placement(source, "D3", 0) != ""


def test_missing_or_unsupported_mutation_fails():
    with pytest.raises(ValueError, match="exactly one"):
        benchmark.shift_placement("(unit um)\n(placement)\n", "D3", 1.0)
    with pytest.raises(ValueError, match="micrometers"):
        benchmark.shift_placement("(placement (place D3 10 20 front 0))", "D3", 1.0)


def test_session_geometry_realistic_fragment():
    session = """(session ID (routes (network_out
      (net "GND" (wire (path F.Cu 200 0 0 3000 4000)))
      (net "VCC" (wire (path B.Cu 200 0 0 0 2000)))
    )))"""
    result = benchmark.session_geometry(session)
    assert result["session_net_count"] == 2
    assert result["wire_path_count"] == 2
    assert result["route_segment_count"] == 2
    assert result["route_length_mm"] == 7.0
    assert result["route_length_by_layer_mm"] == {"B.Cu": 2.0, "F.Cu": 5.0}
    assert result["via_token_count"] == 0


def test_empty_session_cannot_be_misreported_as_routed():
    result = benchmark.session_geometry("(session ID (routes (network_out)))")
    assert result["wire_path_count"] == 0
    assert result["session_net_count"] == 0

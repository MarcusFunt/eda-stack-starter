"""Real circuit-level smoke tests, skipped if ngspice is not installed.

These are NOT mocked. GitHub Actions installs ngspice and runs them.
"""

import json
import math
import shutil
import tempfile
import unittest
from pathlib import Path

from edastack.core import run_project

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("ngspice"), "real ngspice not installed")
class RealNgspiceIntegrationTests(unittest.TestCase):
    def test_rc_filter_matches_analytic_value(self):
        with tempfile.TemporaryDirectory() as temp:
            report = run_project(ROOT / "examples/rc_filter/spec.json", Path(temp))
            self.assertTrue(report["passed"], report["scenarios"])
            nominal = {m["id"]: m["value"] for m in report["scenarios"][0]["checks"]}
            analytic = 5.0 * (1.0 - math.exp(-1.0))
            self.assertAlmostEqual(nominal["vout_100u"], analytic, delta=0.02)
            peak = next(
                check
                for check in report["scenarios"][0]["checks"]
                if check["id"] == "vout_peak"
            )
            self.assertGreater(peak["time_s"], 0.0)

    def test_diode_clamp_limits(self):
        with tempfile.TemporaryDirectory() as temp:
            report = run_project(ROOT / "examples/diode_clamp/spec.json", Path(temp))
            self.assertTrue(report["passed"], report["scenarios"])

    def test_missing_included_model_fails_with_log_reference(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "bad.cir").write_text(
                "* missing external model\n.include models/not-there.lib\n"
                "V1 in 0 5\nR1 in out 1k\n.end\n"
            )
            (root / "spec.json").write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "name": "missing_model",
                        "netlist": "bad.cir",
                        "parameters": {},
                        "scenarios": [{"name": "nominal", "set": {}}],
                        "analyses": ["tran 1u 10u"],
                        "measurements": [
                            {
                                "id": "vout",
                                "directive": "meas tran vout FIND v(out) AT=10u",
                                "min": 4.9,
                                "max": 5.1,
                            }
                        ],
                    }
                )
            )
            report = run_project(root / "spec.json", root / "output")
            scenario = report["scenarios"][0]
            self.assertFalse(report["passed"])
            self.assertEqual(scenario["scenario"], "nominal")
            self.assertFalse(scenario["passed"])
            self.assertTrue(scenario["errors"], scenario)
            self.assertTrue(Path(scenario["artifacts"]["log"]).is_file())

    def test_inconsistent_voltage_sources_fail_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "inconsistent.cir").write_text(
                "* inconsistent ideal sources have no valid operating point\n"
                "V1 in 0 5\nV2 in 0 0\nR1 in out 1k\nC1 out 0 1n\n.end\n"
            )
            (root / "spec.json").write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "name": "inconsistent_sources",
                        "netlist": "inconsistent.cir",
                        "parameters": {},
                        "scenarios": [{"name": "nominal", "set": {}}],
                        "analyses": ["tran 1n 1u"],
                        "measurements": [
                            {
                                "id": "vout",
                                "directive": "meas tran vout FIND v(out) AT=1u",
                                "min": 0.0,
                                "max": 5.0,
                            }
                        ],
                    }
                )
            )
            report = run_project(root / "spec.json", root / "output")
            scenario = report["scenarios"][0]
            self.assertFalse(report["passed"])
            self.assertFalse(scenario["passed"])
            self.assertTrue(
                scenario["errors"]
                or any(not check["passed"] for check in scenario["checks"]),
                scenario,
            )
            self.assertTrue(Path(scenario["artifacts"]["log"]).is_file())

    def test_nonconvergent_behavioral_source_fails_with_timestep_diagnostics(self):
        with tempfile.TemporaryDirectory() as temp:
            report = run_project(
                ROOT / "tests/fixtures/nonconvergent_behavioral_spec.json",
                Path(temp) / "output",
            )
            scenario = report["scenarios"][0]
            self.assertFalse(report["passed"], report)
            self.assertFalse(scenario["passed"], scenario)
            self.assertTrue(scenario["errors"], scenario)
            self.assertTrue(
                any(
                    "timestep too small" in error.lower()
                    or "operating point" in error.lower()
                    for error in scenario["errors"]
                ),
                scenario["errors"],
            )
            self.assertTrue(Path(scenario["artifacts"]["log"]).is_file())

    def test_named_sweep_waveform_and_resistor_overstress_evidence(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        report = run_project(
            ROOT / "examples/resistor_overstress/spec.json", Path(temp.name)
        )
        self.assertFalse(report["passed"])
        self.assertEqual(
            [analysis["id"] for analysis in report["analyses"]],
            ["startup", "startup_fine"],
        )
        cases = {scenario["scenario"]: scenario for scenario in report["scenarios"]}
        self.assertEqual(set(cases), {"supply_V_4", "supply_V_5", "supply_V_6"})
        self.assertTrue(cases["supply_V_4"]["passed"])
        for name, expected_power in [("supply_V_5", 0.025), ("supply_V_6", 0.036)]:
            scenario = cases[name]
            self.assertFalse(scenario["passed"])
            power = next(
                check for check in scenario["checks"] if check["id"] == "resistor_p_max"
            )
            self.assertAlmostEqual(power["value"], expected_power, delta=0.001)
            self.assertGreater(power["time_s"], 0.0)
            self.assertEqual(power["max"], 0.02)
            self.assertEqual(power["analysis"], "startup")
            self.assertEqual(power["model"]["component"], "R1")
            self.assertIn("Ideal resistance", power["model"]["limitations"][0])
            mean_power = next(
                check
                for check in scenario["checks"]
                if check["id"] == "resistor_p_average"
            )
            self.assertAlmostEqual(
                mean_power["value"],
                0.003125 if name == "supply_V_5" else 0.0045,
                delta=0.0003,
            )
            rms_current = next(
                check
                for check in scenario["checks"]
                if check["id"] == "rms_resistor_current"
            )
            self.assertGreater(rms_current["value"], 0.0)
            self.assertEqual(rms_current["analysis"], "startup")
            waveforms = scenario["artifacts"]["waveforms"]
            self.assertEqual(len(waveforms), 1)
            waveform = waveforms[0]
            self.assertEqual(waveform["analysis"], "startup")
            self.assertGreater(waveform["samples"], 10)
            self.assertTrue(Path(waveform["csv"]).is_file())
            self.assertTrue(Path(waveform["raw"]).is_file())

    def test_versioned_two_pin_model_fixture(self):
        with tempfile.TemporaryDirectory() as temp:
            report = run_project(
                ROOT / "models/fixtures/ideal_two_pin_spec.json", Path(temp)
            )
            self.assertTrue(report["passed"], report["scenarios"])
            self.assertEqual(report["model_library"]["library_version"], "1.0.0")
            self.assertRegex(report["model_library"]["sha256"], r"^[0-9a-f]{64}$")
            check = report["scenarios"][0]["checks"][0]
            self.assertEqual(check["value"], 0.5)
            self.assertEqual(check["model"]["pin_order"], ["P", "N"])
            sampling = report["scenarios"][0]["solver_quality"]["transient_sampling"][0]
            self.assertTrue(sampling["passed"])

    def test_startup_load_step_shutdown_and_operating_corners(self):
        with tempfile.TemporaryDirectory() as temp:
            report = run_project(
                ROOT / "examples/rc_operating_cases/spec.json", Path(temp)
            )
            self.assertTrue(report["passed"], report["scenarios"])
            self.assertEqual(len(report["scenarios"]), 8)
            self.assertEqual(report["coverage"]["nominal_scenarios"], ["nominal"])
            self.assertEqual(len(report["coverage"]["tested_corners"]), 7)
            self.assertEqual(report["coverage"]["statistical_samples"], [])
            self.assertFalse(report["coverage"]["global_worst_case_claim"])
            self.assertEqual(report["scenarios"][0]["category"], "nominal")
            self.assertEqual(
                {
                    item["analysis"]
                    for item in report["scenarios"][0]["solver_quality"][
                        "transient_sampling"
                    ]
                },
                {"startup", "load_step", "shutdown"},
            )

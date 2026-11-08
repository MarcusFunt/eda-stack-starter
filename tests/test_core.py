import hashlib
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path, PurePosixPath
from unittest.mock import patch

from edastack.cli import main as cli_main
from edastack.core import (
    EDAError,
    _convert_waveform,
    _scenario_solver_quality,
    _solver_log_diagnostics,
    _transient_step_limit,
    evaluate_measurements,
    executable_path,
    extract_measurement_records,
    extract_measurements,
    load_spec,
    render_deck,
    run_project,
)
from edastack.mcp import respond, workspace_path

ROOT = Path(__file__).resolve().parents[1]


class ExecutableResolutionTests(unittest.TestCase):
    def test_windows_gui_alias_uses_sibling_console_binary(self):
        with tempfile.TemporaryDirectory() as td:
            gui_binary = Path(td) / "ngspice.exe"
            console_binary = Path(td) / "ngspice_con.exe"
            gui_binary.touch()
            console_binary.touch()
            with (
                patch("sys.platform", "win32"),
                patch("edastack.core.shutil.which", return_value=str(gui_binary)),
            ):
                self.assertEqual(executable_path("ngspice"), str(console_binary))

    def test_doctor_reports_console_binary_when_gui_alias_is_given(self):
        with tempfile.TemporaryDirectory() as td:
            gui_binary = Path(td) / "ngspice.exe"
            console_binary = Path(td) / "ngspice_con.exe"
            gui_binary.touch()
            console_binary.touch()
            output = StringIO()
            with (
                patch("sys.platform", "win32"),
                patch("edastack.cli.shutil.which", return_value=None),
                redirect_stdout(output),
            ):
                exit_code = cli_main(["doctor", "--ngspice", str(gui_binary)])

            self.assertEqual(exit_code, 0)
            self.assertEqual(
                json.loads(output.getvalue())["ngspice_path"], str(console_binary)
            )


class SpecTests(unittest.TestCase):
    def test_host_waveform_paths_with_spaces_are_relative_on_posix(self):
        with tempfile.TemporaryDirectory(prefix="eda workspace ") as td:
            root = Path(td)
            waveform_path = PurePosixPath(root.as_posix() + "/output/wave.dat")
            deck = render_deck(
                "RC fixture\nR1 in out 1k\n.end\n",
                {},
                [{"id": "transient", "kind": "tran", "command": "tran 1n 1u"}],
                [],
                [{"id": "wave", "analysis": "transient", "signals": ["v(out)"]}],
                {"wave": waveform_path},
                root,
            )
        self.assertIn("wrdata output/wave.dat v(out)", deck)
        self.assertNotIn("eda workspace", deck)

    def test_operating_example_declares_categories_and_untested_conditions(self):
        spec = load_spec(ROOT / "examples/rc_operating_cases/spec.json")
        self.assertEqual(spec["scenarios"][0]["category"], "nominal")
        self.assertEqual(spec["scenarios"][1]["category"], "corner")
        self.assertTrue(spec["_untested_conditions"])

    def test_example_specs_load(self):
        for p in ROOT.glob("examples/*/spec.json"):
            d = load_spec(p)
            self.assertTrue(d["measurements"])
            self.assertTrue(d["scenarios"])

    def test_render_rc(self):
        spec = load_spec(ROOT / "examples/rc_filter/spec.json")
        template = Path(spec["_netlist_path"]).read_text()
        deck = render_deck(
            template, spec["parameters"], spec["analyses"], spec["measurements"]
        )
        self.assertIn("R1 IN OUT 1k", deck)
        self.assertIn("C1 OUT 0 100n", deck)
        self.assertIn("meas tran vout_peak", deck)
        self.assertEqual(deck.count(".endc"), 1)
        self.assertTrue(deck.endswith(".end\n"))
        self.assertLess(deck.index("tran 0.2u 400u"), deck.index("meas tran vin_peak"))

    def test_unresolved_parameter_rejected(self):
        with self.assertRaises(EDAError):
            render_deck("Title\nR1 1 0 {{X}}\n.end", {}, ["tran 1n 1u"], [])

    def test_existing_control_rejected(self):
        with self.assertRaises(EDAError):
            render_deck("Title\n.control\n.endc\n.end", {}, ["tran 1n 1u"], [])

    def test_unknown_override_rejected(self):
        src = ROOT / "examples/rc_filter/spec.json"
        with tempfile.TemporaryDirectory() as td:
            dest = Path(td)
            (dest / "c.cir").write_text("* example\nR1 a b 1k\n.end")
            spec = json.loads(src.read_text())
            spec["netlist"] = "c.cir"
            spec["scenarios"] = [{"name": "bad", "set": {"unknown": "1k"}}]
            (dest / "spec.json").write_text(json.dumps(spec))
            with self.assertRaises(EDAError):
                load_spec(dest / "spec.json")

    def test_path_traversal_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            with self.assertRaises(EDAError):
                workspace_path(root, "../../etc/passwd")

    def test_malformed_json_spec_is_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            bad_spec = Path(td) / "spec.json"
            bad_spec.write_text("{not json")
            with self.assertRaises(json.JSONDecodeError):
                load_spec(bad_spec)

    def test_missing_simulator_is_a_configuration_error(self):
        with tempfile.TemporaryDirectory() as td:
            with self.assertRaises(EDAError):
                run_project(
                    ROOT / "examples/rc_filter/spec.json",
                    Path(td) / "out",
                    "missing-ngspice-binary",
                )

    def test_default_simulator_uses_ngspice_exe_environment_variable(self):
        with (
            tempfile.TemporaryDirectory() as td,
            patch.dict("os.environ", {"NGSPICE_EXE": "missing-ngspice-console"}),
        ):
            with self.assertRaisesRegex(
                EDAError, "executable not found: 'missing-ngspice-console'"
            ):
                run_project(ROOT / "examples/rc_filter/spec.json", Path(td) / "out")

    def test_duplicate_measurement_names_are_case_insensitive(self):
        source = ROOT / "examples/rc_filter/spec.json"
        with tempfile.TemporaryDirectory() as td:
            dest = Path(td)
            (dest / "c.cir").write_text(
                (ROOT / "examples/rc_filter/rc_lowpass.cir").read_text()
            )
            spec = json.loads(source.read_text())
            spec["netlist"] = "c.cir"
            spec["measurements"][1]["id"] = "VIN_PEAK"
            spec["measurements"][1]["directive"] = (
                "meas tran VIN_PEAK FIND v(out) AT=100u"
            )
            (dest / "spec.json").write_text(json.dumps(spec))
            with self.assertRaises(EDAError):
                load_spec(dest / "spec.json")

    def test_duplicate_analysis_kind_is_rejected(self):
        source = ROOT / "examples/rc_filter/spec.json"
        with tempfile.TemporaryDirectory() as td:
            dest = Path(td)
            (dest / "c.cir").write_text(
                (ROOT / "examples/rc_filter/rc_lowpass.cir").read_text()
            )
            spec = json.loads(source.read_text())
            spec["netlist"] = "c.cir"
            spec["analyses"] = ["tran 0.2u 400u", "TRAN 0.1u 400u"]
            (dest / "spec.json").write_text(json.dumps(spec))
            with self.assertRaises(EDAError):
                load_spec(dest / "spec.json")

    def test_named_analyses_waveforms_model_provenance_and_explicit_sweep(self):
        source = ROOT / "examples/rc_filter/spec.json"
        with tempfile.TemporaryDirectory() as td:
            dest = Path(td)
            (dest / "c.cir").write_text(
                (ROOT / "examples/rc_filter/rc_lowpass.cir").read_text()
            )
            spec = json.loads(source.read_text())
            spec["netlist"] = "c.cir"
            spec["analyses"] = [
                {"id": "startup", "command": "tran 0.2u 400u"},
                {"id": "startup_fine", "command": "tran 0.1u 10u"},
            ]
            spec["measurements"][0].update(
                {"analysis": "startup", "signal": "v(in)", "model_ref": "R1_ideal"}
            )
            spec["measurements"][1].update({"analysis": "startup", "signal": "v(out)"})
            spec["measurements"][2].update({"analysis": "startup", "signal": "v(out)"})
            spec["measurements"][3].update(
                {"analysis": "startup_fine", "signal": "v(out)"}
            )
            spec["waveforms"] = [
                {
                    "id": "startup_nodes",
                    "analysis": "startup",
                    "signals": ["v(in)", "v(out)", "i(R1)"],
                }
            ]
            spec["models"] = [
                {
                    "id": "R1_ideal",
                    "component": "R1",
                    "kind": "spice_primitive",
                    "source": "ngspice passive resistor element R",
                    "version": "engine built-in",
                    "sha256": None,
                    "limitations": [
                        "Ideal resistance; no temperature or power derating model."
                    ],
                }
            ]
            spec["scenarios"] = []
            spec["sweeps"] = [
                {"name": "r_grid", "values": {"R": ["900", "1k", "1.1k"]}}
            ]
            (dest / "spec.json").write_text(json.dumps(spec))

            loaded = load_spec(dest / "spec.json")
            self.assertEqual(
                [a["id"] for a in loaded["_analyses"]], ["startup", "startup_fine"]
            )
            self.assertEqual(
                [s["name"] for s in loaded["scenarios"]],
                ["r_grid_R_900", "r_grid_R_1k", "r_grid_R_1_1k"],
            )
            self.assertEqual(
                [s["set"]["R"] for s in loaded["scenarios"]], ["900", "1k", "1.1k"]
            )
            self.assertEqual(loaded["measurements"][0]["analysis"], "startup")
            self.assertEqual(loaded["_models"]["r1_ideal"]["component"], "R1")

            deck = render_deck(
                Path(spec["_netlist_path"]).read_text()
                if "_netlist_path" in spec
                else (dest / "c.cir").read_text(),
                loaded["parameters"],
                loaded["_analyses"],
                loaded["measurements"],
                loaded["_waveforms"],
                {"startup_nodes": dest / "out" / "startup_nodes.dat"},
            )
            first_analysis = deck.index("tran 0.2u 400u")
            first_measure = deck.index("meas tran vin_peak")
            waveform_export = deck.index("wrdata")
            second_analysis = deck.index("tran 0.1u 10u")
            second_measure = deck.index("meas tran vout_peak")
            self.assertLess(first_analysis, first_measure)
            self.assertLess(first_measure, waveform_export)
            self.assertLess(waveform_export, second_analysis)
            self.assertLess(second_analysis, second_measure)

    def test_ambiguous_named_analysis_measurement_is_rejected(self):
        source = ROOT / "examples/rc_filter/spec.json"
        with tempfile.TemporaryDirectory() as td:
            dest = Path(td)
            (dest / "c.cir").write_text(
                (ROOT / "examples/rc_filter/rc_lowpass.cir").read_text()
            )
            spec = json.loads(source.read_text())
            spec["netlist"] = "c.cir"
            spec["analyses"] = [
                {"id": "startup", "command": "tran 1u 10u"},
                {"id": "fine", "command": "tran 100n 1u"},
            ]
            (dest / "spec.json").write_text(json.dumps(spec))
            with self.assertRaisesRegex(EDAError, "must name one of"):
                load_spec(dest / "spec.json")

    def test_named_sweep_over_32_scenarios_is_rejected(self):
        source = ROOT / "examples/rc_filter/spec.json"
        with tempfile.TemporaryDirectory() as td:
            dest = Path(td)
            (dest / "c.cir").write_text(
                (ROOT / "examples/rc_filter/rc_lowpass.cir").read_text()
            )
            spec = json.loads(source.read_text())
            spec["netlist"] = "c.cir"
            spec["scenarios"] = []
            spec["sweeps"] = [
                {"name": "grid", "values": {"R": [f"{i}k" for i in range(1, 34)]}}
            ]
            (dest / "spec.json").write_text(json.dumps(spec))
            with self.assertRaisesRegex(EDAError, "32 scenarios"):
                load_spec(dest / "spec.json")

    def test_unknown_measurement_model_reference_is_rejected(self):
        source = ROOT / "examples/rc_filter/spec.json"
        with tempfile.TemporaryDirectory() as td:
            dest = Path(td)
            (dest / "c.cir").write_text(
                (ROOT / "examples/rc_filter/rc_lowpass.cir").read_text()
            )
            spec = json.loads(source.read_text())
            spec["netlist"] = "c.cir"
            spec["measurements"][0]["model_ref"] = "missing_model"
            (dest / "spec.json").write_text(json.dumps(spec))
            with self.assertRaisesRegex(EDAError, "Unknown model reference"):
                load_spec(dest / "spec.json")

    def test_measurement_signal_must_match_its_directive(self):
        source = ROOT / "examples/rc_filter/spec.json"
        with tempfile.TemporaryDirectory() as td:
            dest = Path(td)
            (dest / "c.cir").write_text(
                (ROOT / "examples/rc_filter/rc_lowpass.cir").read_text()
            )
            spec = json.loads(source.read_text())
            spec["netlist"] = "c.cir"
            spec["measurements"][0]["signal"] = "v(out)"
            (dest / "spec.json").write_text(json.dumps(spec))
            with self.assertRaisesRegex(EDAError, "does not occur in"):
                load_spec(dest / "spec.json")

    def test_waveform_converter_requires_finite_monotonic_rows(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            raw = root / "wave.dat"
            csv_path = root / "wave.csv"
            raw.write_text("time v(out) i(r1)\n0 0 -0.005\n1e-6 0.1 -0.004\n")
            summary = _convert_waveform(raw, csv_path, ["v(out)", "i(R1)"])
            self.assertEqual(summary["samples"], 2)
            self.assertEqual(summary["columns"], ["time_s", "v(out)", "i(R1)"])
            self.assertEqual(summary["sample_interval_max_s"], 1e-6)
            self.assertIn("time_s,v(out),i(R1)", csv_path.read_text())
            raw.write_text("time v(out) i(r1)\n1e-6 0.1 -0.004\n1e-6 0.2 -0.003\n")
            with self.assertRaisesRegex(EDAError, "strictly increasing"):
                _convert_waveform(raw, csv_path, ["v(out)", "i(R1)"])


class ParsingTests(unittest.TestCase):
    def test_solver_diagnostics_detect_timestep_and_convergence_failures(self):
        diagnostics = _solver_log_diagnostics(
            "Warning: convergence issue\nTimestep too small; time = 1e-6\n"
        )
        self.assertEqual(diagnostics["status"], "failed")
        self.assertTrue(
            any("Timestep too small" in line for line in diagnostics["failures"])
        )
        self.assertTrue(any("Warning:" in line for line in diagnostics["warnings"]))

    def test_transient_step_limit_uses_explicit_or_ngspice_default(self):
        default = _transient_step_limit({"id": "fast", "command": "tran 1n 10n"})
        explicit = _transient_step_limit(
            {"id": "fine", "command": "tran 2n 20n 10n 100p"}
        )
        self.assertAlmostEqual(default["max_step_s"], 0.2e-9)
        self.assertEqual(default["basis"], "ngspice_default")
        self.assertAlmostEqual(explicit["max_step_s"], 0.1e-9)
        self.assertEqual(explicit["basis"], "explicit_tmax")

    def test_transient_sampling_outside_maximum_step_fails_quality_check(self):
        quality = _scenario_solver_quality(
            "Initial Transient Solution\n",
            [{"id": "fast", "command": "tran 1n 10n", "kind": "tran"}],
            [
                {
                    "analysis": "fast",
                    "sample_interval_max_s": 1e-9,
                }
            ],
        )
        self.assertEqual(quality["status"], "failed")
        self.assertFalse(quality["transient_sampling"][0]["passed"])

    def test_extract_measurements(self):
        log = (
            "Circuit: test\nvin_peak   =  5.000000e+00 at= 4.000000e-04\n"
            "vout_peak = 4.908421e+00 from= 0 to= 4.0000e-04\n"
            "vout_100u = 3.160600e+00\n"
        )
        values = extract_measurements(log)
        self.assertAlmostEqual(values["vin_peak"], 5)
        self.assertAlmostEqual(values["vout_100u"], 3.1606)

    def test_measurement_peak_time_is_preserved(self):
        records = extract_measurement_records("peak = 2.5 at= 3.2e-06\nmean = 1.25\n")
        self.assertEqual(records["peak"], {"value": 2.5, "time_s": 3.2e-06})
        self.assertEqual(records["mean"], {"value": 1.25})

    def test_missing_measure_fails_closed(self):
        specs = [{"id": "peak", "min": 0.0, "max": 2.0}]
        checks = evaluate_measurements(specs, {})
        self.assertFalse(checks[0]["passed"])
        self.assertIsNone(checks[0]["value"])

    def test_bound_violations(self):
        specs = [{"id": "peak", "min": 0.0, "max": 2.0}]
        self.assertFalse(evaluate_measurements(specs, {"peak": 2.5})[0]["passed"])
        self.assertTrue(evaluate_measurements(specs, {"peak": 1.5})[0]["passed"])

    def test_zero_is_checked_and_nonfinite_values_fail_closed(self):
        values = extract_measurements(
            "zero = 0.0\nnan_reading = nan\npos_inf = inf\nneg_inf = -inf\n"
        )
        checks = evaluate_measurements(
            [
                {"id": "zero", "min": 0.0, "max": 0.0},
                {"id": "nan_reading"},
                {"id": "pos_inf"},
                {"id": "neg_inf"},
            ],
            values,
        )
        self.assertTrue(checks[0]["passed"])
        self.assertTrue(
            all(
                not check["passed"]
                and check["reason"] == "missing or non-finite measurement"
                for check in checks[1:]
            )
        )


class MockSimulatorTests(unittest.TestCase):
    """End-to-end subprocess orchestration using a MOCK binary, NOT real SPICE."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.binary = root / "fake_ngspice"
        self.binary.write_text("""#!/usr/bin/env python3
import pathlib
import sys
if '-v' in sys.argv:
    print('Mock ngspice 0.0 - NOT A CIRCUIT SOLVER')
    sys.exit(0)
logfile = pathlib.Path(sys.argv[sys.argv.index('-o') + 1])
logfile.write_text('vin_peak = 5.0\\nvout_100u = 3.1606\\n' +
                   'rise_time_10_90 = 2.20e-4\\nvout_peak = 4.91\\n')
""")
        self.command = [sys.executable, str(self.binary)]
        self.out = root / "out"

    def test_command_argv_runs_python_mock(self):
        command = [sys.executable, str(self.binary)]
        try:
            report = run_project(
                ROOT / "examples/rc_filter/spec.json", self.out, command
            )
        except TypeError as exc:
            self.fail(
                f"run_project should accept an executable command sequence: {exc}"
            )
        self.assertTrue(report["passed"])

    def test_timeout_fails_closed_with_machine_readable_reason(self):
        spec = json.loads((ROOT / "examples/rc_filter/spec.json").read_text())
        spec["scenarios"] = [{"name": "nominal", "set": {}}]
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "c.cir").write_text(
                (ROOT / "examples/rc_filter/rc_lowpass.cir").read_text()
            )
            spec["netlist"] = "c.cir"
            (root / "spec.json").write_text(json.dumps(spec))
            sleeper = root / "slow_mock.py"
            sleeper.write_text(
                "import sys, time\nif '-v' in sys.argv:\n print('Mock ngspice')\nelse:\n time.sleep(5)\n"
            )
            report = run_project(
                root / "spec.json",
                root / "out",
                [sys.executable, str(sleeper)],
                timeout=1,
            )
        scenario = report["scenarios"][0]
        self.assertFalse(report["passed"])
        self.assertTrue(scenario["timed_out"])
        self.assertTrue(any("timeout" in error for error in scenario["errors"]))
        self.assertFalse(scenario["checks"][0]["passed"])

    def test_solver_failure_log_cannot_produce_a_passing_report(self):
        self.binary.write_text(
            """import pathlib
import sys
if '-v' in sys.argv:
    print('Mock ngspice 0.0 - NOT A CIRCUIT SOLVER')
else:
    logfile = pathlib.Path(sys.argv[sys.argv.index('-o') + 1])
    logfile.write_text('Timestep too small; time = 1e-6\\n' +
                       'vin_peak = 5.0\\nvout_100u = 3.1606\\n' +
                       'rise_time_10_90 = 2.20e-4\\nvout_peak = 4.91\\n')
"""
        )
        report = run_project(
            ROOT / "examples/rc_filter/spec.json", self.out, self.command
        )
        self.assertFalse(report["passed"])
        self.assertEqual(report["scenarios"][0]["solver_quality"]["status"], "failed")
        self.assertTrue(
            any(
                "Timestep too small" in error
                for error in report["scenarios"][0]["errors"]
            )
        )

    def test_reused_output_records_a_new_run_manifest(self):
        first = run_project(
            ROOT / "examples/rc_filter/spec.json", self.out, self.command
        )
        manifest_path = self.out / "run_manifest.json"
        self.assertTrue(manifest_path.is_file())
        first_manifest = json.loads(manifest_path.read_text())
        first_run_report = self.out / "runs" / first["run_id"] / "report.json"
        self.assertTrue(first_run_report.is_file())
        second = run_project(
            ROOT / "examples/rc_filter/spec.json", self.out, self.command
        )
        second_manifest = json.loads(manifest_path.read_text())
        self.assertNotEqual(first["run_id"], second["run_id"])
        self.assertEqual(second["run_id"], second_manifest["run_id"])
        self.assertNotEqual(first_manifest["run_id"], second_manifest["run_id"])
        self.assertTrue(first_run_report.is_file())

    def test_end_to_end_report_generation(self):
        report = run_project(
            ROOT / "examples/rc_filter/spec.json", self.out, self.command
        )
        self.assertTrue(report["passed"])
        self.assertEqual(len(report["scenarios"]), 3)
        self.assertEqual(len(list(self.out.rglob("input.cir"))), 3)
        self.assertTrue((self.out / "report.json").is_file())
        self.assertTrue((self.out / "measurements.csv").is_file())
        self.assertTrue((self.out / "report.md").is_file())
        self.assertEqual(report["scenarios"][0]["checks"][0]["value"], 5.0)
        self.assertIn("Mock ngspice", report["simulator_version"])
        scenario = report["scenarios"][0]
        self.assertEqual(
            hashlib.sha256(Path(scenario["artifacts"]["netlist"]).read_bytes()).hexdigest(),
            scenario["deck_sha256"],
        )

    def test_mcp_status_and_simulation(self):
        root = Path(self.temp.name)
        status = respond(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, root, str(self.binary)
        )
        self.assertEqual(len(status["result"]["tools"]), 2)
        info = respond(
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "initialize",
                "params": {"protocolVersion": "2025-06-18"},
            },
            root,
            str(self.binary),
        )
        self.assertEqual(info["result"]["serverInfo"]["name"], "edastack-spice")
        self.assertIsNone(
            respond(
                {"jsonrpc": "2.0", "method": "notifications/initialized"},
                root,
                str(self.binary),
            )
        )

    def test_stale_log_cannot_produce_false_pass(self):
        # First run produces a good report; second run's fake executable writes no log.
        first = run_project(
            ROOT / "examples/rc_filter/spec.json", self.out, self.command
        )
        first_log = Path(first["scenarios"][0]["artifacts"]["log"])
        self.assertTrue(first["passed"])
        self.assertTrue(first_log.is_file())
        self.binary.write_text("""#!/usr/bin/env python3
import sys
if '-v' in sys.argv: print('mock')
""")
        report = run_project(
            ROOT / "examples/rc_filter/spec.json", self.out, self.command
        )
        self.assertFalse(report["passed"])
        self.assertFalse(Path(report["scenarios"][0]["artifacts"]["log"]).exists())
        self.assertTrue(first_log.is_file())

    def test_missing_measurement_report_fails(self):
        self.binary.write_text(
            self.binary.read_text().replace("vout_peak = 4.91\\n", "")
        )
        report = run_project(
            ROOT / "examples/rc_filter/spec.json", self.out, self.command
        )
        self.assertFalse(report["passed"])
        self.assertFalse(report["scenarios"][0]["checks"][-1]["passed"])


if __name__ == "__main__":
    unittest.main()

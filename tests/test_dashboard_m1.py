"""Milestone 1 dashboard semantics, extrema and evidence regressions."""

import csv
import json
import tempfile
import unittest
from pathlib import Path

from edastack.dashboard import (
    MAX_WAVEFORM_POINTS,
    _read_waveform,
    build_dashboard,
)
from edastack.dashboard_view import (
    PREVIEW_LIMIT,
    _check_status,
    _evidence,
    _scenario_status,
)


class DashboardMilestoneOneTests(unittest.TestCase):
    def test_status_distinguishes_unbounded_measurement_from_verification(self):
        self.assertEqual(
            _check_status({"value": 0.002, "unit": "W", "passed": True}),
            "measured",
        )
        self.assertEqual(_check_status({"value": 0.002}), "measured")
        self.assertEqual(_check_status({"value": 0.002, "max": 0.005}), "not-run")
        self.assertEqual(
            _check_status({"value": 0.002, "max": 0.005, "passed": True}),
            "passed",
        )
        self.assertEqual(
            _check_status({"value": 0.02, "max": 0.005, "passed": False}),
            "failed",
        )
        self.assertEqual(
            _check_status({"value": None, "passed": False}),
            "not-run",
        )
        self.assertEqual(
            _check_status({"value": None, "error": "probe missing"}),
            "error",
        )

    def test_scenario_status_prefers_errors_and_failures(self):
        self.assertEqual(
            _scenario_status(
                {"status": "pass", "checks": [{"display_status": "measured"}]}
            ),
            "measured",
        )
        self.assertEqual(
            _scenario_status(
                {"status": "pass", "checks": [{"display_status": "failed"}]}
            ),
            "failed",
        )
        self.assertEqual(
            _scenario_status({"status": "error", "checks": []}),
            "error",
        )
        self.assertEqual(
            _scenario_status({"status": "pass", "checks": [{"display_status": "not-run"}, {"display_status": "passed"}]}),
            "not-run",
        )
        self.assertEqual(_scenario_status({"checks": []}), "not-run")

    def test_narrow_waveform_spikes_are_preserved(self):
        with tempfile.TemporaryDirectory() as td:
            csv_path = Path(td) / "waveform.csv"
            with csv_path.open("w", newline="", encoding="utf-8") as stream:
                writer = csv.writer(stream)
                writer.writerow(["time_s", "v(out)", "i(r1)"])
                for i in range(5000):
                    writer.writerow(
                        [
                            i / 1e6,
                            100 if i == 1017 else 0,
                            -50 if i == 3456 else 0,
                        ]
                    )
            waves = _read_waveform(
                csv_path,
                ["v(out)", "i(r1)"],
                label="demo",
                run_id="r1",
                scenario="nominal",
                analysis="tran",
            )
            self.assertEqual(len(waves), 2)
            self.assertEqual(waves[0]["samples"], 5000)
            for wave in waves:
                self.assertLessEqual(wave["display_samples"], MAX_WAVEFORM_POINTS)
                self.assertEqual(wave["x"], sorted(wave["x"]))
                self.assertEqual(wave["x"][0], 0)
                self.assertAlmostEqual(wave["x"][-1], 0.004999)
            self.assertIn(100, waves[0]["y"])
            self.assertIn(-50, waves[1]["y"])

    def test_evidence_preview_is_capped_and_has_original_link(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "log.txt"
            path.write_text("x" * (PREVIEW_LIMIT + 20), encoding="utf-8")
            entry = _evidence("Simulator log", str(path))
            self.assertTrue(entry["available"])
            self.assertTrue(entry["truncated"])
            self.assertEqual(len(entry["preview"]), PREVIEW_LIMIT)
            self.assertTrue(entry["uri"].startswith("file:"))
            missing = _evidence("missing", str(Path(td) / "absent"))
            self.assertFalse(missing["available"])

    def test_cross_project_diffs_not_generated(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            reports = []
            for project in ("a", "b"):
                sub = root / project
                sub.mkdir()
                netlist = sub / "input.cir"
                netlist.write_text("R1 A B 1k\n", encoding="utf-8")
                report = sub / "report.json"
                report.write_text(
                    json.dumps(
                        {
                            "project": project,
                            "run_id": project,
                            "scenarios": [
                                {
                                    "scenario": "nominal",
                                    "status": "pass",
                                    "checks": [
                                        {
                                            "id": "rms",
                                            "value": 0.01,
                                            "unit": "A",
                                            "passed": True,
                                        }
                                    ],
                                    "artifacts": {
                                        "netlist": str(netlist),
                                        "waveforms": [],
                                    },
                                }
                            ],
                        }
                    ),
                    encoding="utf-8",
                )
                reports.append(report)
            output = root / "dashboard.html"
            build_dashboard(reports, output)
            html = output.read_text(encoding="utf-8")
            self.assertIn('"display_status":"measured"', html)
            self.assertIn('"diffs":[]', html)
            self.assertIn('"label":"Original verification report"', html)


if __name__ == "__main__":
    unittest.main()

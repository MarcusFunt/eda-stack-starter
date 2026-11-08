import contextlib
import csv
import io
import json
import tempfile
import unittest
from pathlib import Path

from edastack.cli import main as cli_main


def call_cli(arguments):
    try:
        return cli_main(arguments)
    except SystemExit as exc:
        return int(exc.code)


class DashboardCliTests(unittest.TestCase):
    def test_dashboard_shows_run_matrix_waveforms_deck_diff_and_bom_status(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            reports = []
            for run_id, resistance, value in (
                ("baseline", "1k", 3.1606),
                ("candidate", "3k", 1.4173),
            ):
                run_dir = root / run_id
                run_dir.mkdir()
                netlist = run_dir / "input.cir"
                netlist.write_text(f"R1 IN OUT {resistance}\nC1 OUT 0 100n\n")
                waveform = run_dir / "waveform.csv"
                with waveform.open("w", newline="", encoding="utf-8") as stream:
                    writer = csv.writer(stream)
                    writer.writerow(["time_s", "v(out)"])
                    writer.writerow([0, 0])
                    writer.writerow([0.0001, value])
                report = {
                    "project": "rc_filter",
                    "run_id": run_id,
                    "run_completed_at_utc": "2026-11-07T20:00:00Z",
                    "simulator_version": "ngspice 47",
                    "passed": value > 3,
                    "scenarios": [
                        {
                            "scenario": "nominal",
                            "category": "nominal",
                            "parameters": {"R": resistance, "C": "100n"},
                            "status": "pass" if value > 3 else "fail",
                            "passed": value > 3,
                            "checks": [
                                {
                                    "id": "vout_100u",
                                    "value": value,
                                    "unit": "V",
                                    "min": 3.0,
                                    "max": 3.3,
                                    "passed": value > 3,
                                }
                            ],
                            "artifacts": {
                                "netlist": str(netlist),
                                "waveforms": [
                                    {
                                        "id": "startup",
                                        "analysis": "tran",
                                        "signals": ["v(out)"],
                                        "csv": str(waveform),
                                        "samples": 2,
                                    }
                                ],
                            },
                        }
                    ],
                }
                report_path = run_dir / "report.json"
                report_path.write_text(json.dumps(report), encoding="utf-8")
                reports.append(report_path)

            bom = root / "bom.json"
            bom.write_text(
                json.dumps(
                    {
                        "snapshot_time_utc": "2026-11-07T20:00:00Z",
                        "items": [
                            {
                                "reference": "R1",
                                "quantity": 1,
                                "selected_part": {
                                    "manufacturer": "YAGEO",
                                    "manufacturer_part_number": "RC0603FR-071KL",
                                    "supplier": "JLCPCB/LCSC",
                                    "supplier_part_number": "C22548",
                                    "supplier_stock_quantity": 14127700,
                                    "availability_price_snapshot_utc": "2026-11-07T20:00:00Z",
                                },
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            output = root / "dashboard.html"
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                exit_code = call_cli(
                    [
                        "dashboard",
                        *(str(path) for path in reports),
                        "--bom",
                        str(bom),
                        "--out",
                        str(output),
                    ]
                )

            self.assertEqual(exit_code, 0, stderr.getvalue())
            self.assertTrue(output.is_file())
            page = output.read_text(encoding="utf-8")
            for expected in (
                "Experiment matrix",
                "Waveform overlays",
                "vout_100u",
                "Deck differences",
                "RC0603FR-071KL",
                "JLCPCB/LCSC",
                "R1 IN OUT 1k",
                "R1 IN OUT 3k",
            ):
                self.assertIn(expected, page)

    def test_dashboard_rejects_invalid_report_without_writing_output(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            invalid_report = root / "invalid.json"
            invalid_report.write_text("{}", encoding="utf-8")
            output = root / "dashboard.html"
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                exit_code = call_cli(
                    ["dashboard", str(invalid_report), "--out", str(output)]
                )

            self.assertEqual(exit_code, 2)
            self.assertIn("must contain a project and scenarios", stderr.getvalue())
            self.assertFalse(output.exists())

    def test_dashboard_will_not_overwrite_a_report_input(self):
        with tempfile.TemporaryDirectory() as td:
            report = Path(td) / "report.json"
            original = {
                "project": "rc_filter",
                "run_id": "run-1",
                "scenarios": [
                    {
                        "scenario": "nominal",
                        "checks": [],
                        "artifacts": {"waveforms": []},
                    }
                ],
            }
            report.write_text(json.dumps(original), encoding="utf-8")
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                exit_code = call_cli(["dashboard", str(report), "--out", str(report)])

            self.assertEqual(exit_code, 2)
            self.assertIn("cannot overwrite an input artifact", stderr.getvalue())
            self.assertEqual(json.loads(report.read_text(encoding="utf-8")), original)

    def test_dashboard_will_not_overwrite_simulator_log_or_raw_waveform(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            report = root / "report.json"
            log = root / "ngspice.log"
            raw = root / "wave.dat"
            csv = root / "wave.csv"
            log.write_text("simulator evidence\n", encoding="utf-8")
            raw.write_bytes(b"raw waveform evidence")
            csv.write_text("time_s,v(out)\n0,0\n1,1\n", encoding="utf-8")
            report.write_text(
                json.dumps(
                    {
                        "project": "rc_filter",
                        "run_id": "run-1",
                        "scenarios": [
                            {
                                "scenario": "nominal",
                                "checks": [],
                                "artifacts": {
                                    "log": str(log),
                                    "waveforms": [
                                        {
                                            "raw": str(raw),
                                            "csv": str(csv),
                                            "signals": ["v(out)"],
                                        }
                                    ],
                                },
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            for protected in (log, raw):
                original = protected.read_bytes()
                stdout, stderr = io.StringIO(), io.StringIO()
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                    exit_code = call_cli(["dashboard", str(report), "--out", str(protected)])
                self.assertEqual(exit_code, 2)
                self.assertIn("cannot overwrite an input artifact", stderr.getvalue())
                self.assertEqual(protected.read_bytes(), original)

    def test_dashboard_rejects_malformed_checks(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            report = root / "report.json"
            report.write_text(
                json.dumps(
                    {
                        "project": "rc_filter",
                        "scenarios": [{"scenario": "nominal", "checks": [None]}],
                    }
                ),
                encoding="utf-8",
            )
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                exit_code = call_cli(["dashboard", str(report)])

            self.assertEqual(exit_code, 2)
            self.assertIn("invalid check", stderr.getvalue())

    def test_dashboard_rejects_non_array_waveform_metadata(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            report = root / "report.json"
            report.write_text(
                json.dumps(
                    {
                        "project": "rc_filter",
                        "scenarios": [
                            {
                                "scenario": "nominal",
                                "checks": [],
                                "artifacts": {"waveforms": None},
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                exit_code = call_cli(["dashboard", str(report)])

            self.assertEqual(exit_code, 2)
            self.assertIn("invalid waveform metadata", stderr.getvalue())

    def test_dashboard_bounds_waveform_display_samples(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            waveform = root / "waveform.csv"
            with waveform.open("w", newline="", encoding="utf-8") as stream:
                writer = csv.writer(stream)
                writer.writerow(["time_s", "v(out)"])
                writer.writerows((index / 1_000_000, index) for index in range(5000))
            report = root / "report.json"
            report.write_text(
                json.dumps(
                    {
                        "project": "rc_filter",
                        "scenarios": [
                            {
                                "scenario": "nominal",
                                "checks": [],
                                "artifacts": {
                                    "waveforms": [
                                        {
                                            "csv": str(waveform),
                                            "signals": ["v(out)"],
                                        }
                                    ]
                                },
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )
            output = root / "dashboard.html"
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                exit_code = call_cli(["dashboard", str(report), "--out", str(output)])

            self.assertEqual(exit_code, 0, stderr.getvalue())
            page = output.read_text(encoding="utf-8")
            self.assertIn('"samples":5000,"display_samples":2000', page)


if __name__ == "__main__":
    unittest.main()

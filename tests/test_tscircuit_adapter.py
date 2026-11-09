import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from edastack.adapters.tscircuit import TscircuitBuildError, build_tscircuit_project


class TscircuitAdapterTests(unittest.TestCase):
    def test_invokes_worker_without_a_shell_and_returns_build_artifacts(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            worker = root / "worker"
            worker.mkdir()
            result = {
                "status": "compiled",
                "projectName": "board-a",
                "outputDir": str(root / "out"),
                "circuitJsonPath": str(root / "out" / "circuit.json"),
                "sourceGraphPath": str(root / "out" / "source-graph.json"),
                "sourceManifestPath": str(root / "out" / "source-manifest.json"),
                "kicadOutputDir": str(root / "out" / "kicad"),
                "manifestPath": str(root / "out" / "build-manifest.json"),
                "circuitJsonSha256": "a" * 64,
                "componentCount": 3,
                "netCount": 2,
            }
            with patch(
                "edastack.adapters.tscircuit.subprocess.run",
                return_value=subprocess.CompletedProcess([], 0, json.dumps(result, indent=2), ""),
            ) as run:
                build = build_tscircuit_project(
                    root / "project with spaces",
                    root / "out",
                    worker_root=worker,
                    entrypoint="src/custom-board.tsx",
                    timeout_ms=15_000,
                )

            self.assertEqual(build.project_name, "board-a")
            self.assertEqual(build.component_count, 3)
            self.assertEqual(build.net_count, 2)
            self.assertEqual(build.circuit_json_path, root / "out" / "circuit.json")
            command = run.call_args.args[0]
            self.assertEqual(command[0:3], ["node", "--import", "tsx"])
            self.assertIn("--project-root", command)
            self.assertIn(str((root / "project with spaces").resolve()), command)
            self.assertIn("src/custom-board.tsx", command)
            self.assertFalse(run.call_args.kwargs["shell"])
            self.assertEqual(run.call_args.kwargs["cwd"], worker.resolve())
            self.assertEqual(run.call_args.kwargs["timeout"], 45)

    def test_reports_worker_diagnostic_and_code_on_failure(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            worker = root / "worker"
            worker.mkdir()
            with patch(
                "edastack.adapters.tscircuit.subprocess.run",
                return_value=subprocess.CompletedProcess(
                    [], 1, "", json.dumps({"status": "failed", "error": "BUILD_SCHEMA: invalid project"})
                ),
            ):
                with self.assertRaises(TscircuitBuildError) as raised:
                    build_tscircuit_project(root / "project", root / "out", worker_root=worker)

            self.assertEqual(raised.exception.code, "BUILD_SCHEMA")
            self.assertIn("invalid project", str(raised.exception))
            self.assertEqual(raised.exception.returncode, 1)

    def test_classifies_worker_timeout(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            worker = root / "worker"
            worker.mkdir()
            with patch(
                "edastack.adapters.tscircuit.subprocess.run",
                side_effect=subprocess.TimeoutExpired(["node"], 35),
            ):
                with self.assertRaises(TscircuitBuildError) as raised:
                    build_tscircuit_project(root / "project", root / "out", worker_root=worker)

            self.assertEqual(raised.exception.code, "TSCIRCUIT_ADAPTER_TIMEOUT")


if __name__ == "__main__":
    unittest.main()

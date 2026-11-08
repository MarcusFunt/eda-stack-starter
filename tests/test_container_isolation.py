import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import edastack.core as core
from edastack.core import (
    DEFAULT_DOCKER_IMAGE,
    EDAError,
    _collect_container_inputs,
    _docker_call,
    _docker_run_scenario,
    _docker_security_flags,
    _validate_container_options,
    _validate_docker_container_inspect,
)


class ContainerOptionTests(unittest.TestCase):
    def test_docker_output_is_capped_in_host_memory(self):
        result = _docker_call(
            sys.executable,
            ["-c", "import sys; sys.stdout.buffer.write(b'x' * 1000000)"],
            binary=True,
            max_output_bytes=64,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertLessEqual(len(result.stdout), 64)
        self.assertIn(b"host output limit", result.stderr)

    def test_docker_output_has_a_host_cap_when_no_limit_is_supplied(self):
        result = _docker_call(
            sys.executable,
            ["-c", "import sys; sys.stdout.buffer.write(b'x' * 3000000)"],
            binary=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertLessEqual(len(result.stdout), core.MAX_DOCKER_STDOUT_BYTES)
        self.assertIn(b"host output limit", result.stderr)

    def test_container_output_reader_rejects_symlinks_and_special_files(self):
        self.assertTrue(callable(getattr(core, "_docker_read_file", None)))
        with patch(
            "edastack.core._docker_call",
            return_value=subprocess.CompletedProcess(
                ["docker"], 74, stdout=b"", stderr=b"refusing non-regular output"
            ),
        ) as docker_call:
            with self.assertRaisesRegex(EDAError, "regular file"):
                core._docker_read_file("docker", "fixture", "/work/ngspice.log", 1024)
        args = docker_call.call_args.args[1]
        self.assertIn("/bin/sh", args)
        self.assertIn("-L", args[args.index("-c") + 1])
        self.assertEqual(docker_call.call_args.kwargs["max_output_bytes"], 1025)

    def test_container_status_read_has_a_small_host_byte_limit(self):
        self.assertTrue(callable(getattr(core, "_docker_read_file", None)))
        with patch(
            "edastack.core._docker_call",
            return_value=subprocess.CompletedProcess(
                ["docker"], 0, stdout=b"0\n", stderr=b""
            ),
        ) as docker_call:
            self.assertEqual(core._docker_read_file("docker", "fixture", "/work/exit-code", 32), b"0\n")
        self.assertEqual(docker_call.call_args.kwargs["max_output_bytes"], 33)

    def test_default_image_is_digest_pinned(self):
        options = _validate_container_options("docker", DEFAULT_DOCKER_IMAGE)
        self.assertIn("@sha256:", options["image"])
        self.assertEqual(options["memory_limit_mb"], 1024)
        self.assertEqual(options["storage_limit_mb"], 512)

    def test_mutable_image_tag_is_rejected(self):
        with self.assertRaisesRegex(EDAError, "sha256 digest"):
            _validate_container_options("docker", "ngspice:latest")

    def test_resource_bounds_are_checked(self):
        with self.assertRaisesRegex(EDAError, "memory_limit_mb"):
            _validate_container_options(
                "docker", DEFAULT_DOCKER_IMAGE, memory_limit_mb=32
            )

    def test_docker_flags_disable_network_and_bound_resources(self):
        flags = _docker_security_flags(1024, 1.5, 64)
        for expected in (
            "--network=none",
            "--read-only",
            "--user=65534:65534",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges:true",
            "--pids-limit=64",
            "--memory=1024m",
            "--cpus=1.5",
        ):
            self.assertIn(expected, flags)

    def test_container_inspection_rejects_missing_isolation_flags(self):
        options = _validate_container_options("docker", DEFAULT_DOCKER_IMAGE)
        project = Path("project-stage")
        scenario = Path("scenario-input")
        inspected = {
            "Config": {"User": "65534:65534", "Image": DEFAULT_DOCKER_IMAGE},
            "HostConfig": {
                "NetworkMode": "none",
                "ReadonlyRootfs": True,
                "CapDrop": ["ALL"],
                "SecurityOpt": ["no-new-privileges:true"],
                "LogConfig": {"Type": "none"},
                "Memory": 1024 * 1024 * 1024,
                "NanoCpus": 1_000_000_000,
                "PidsLimit": 64,
                "Tmpfs": {
                    "/work": "rw,noexec,nosuid,nodev,size=512m",
                    "/tmp": "rw,noexec,nosuid,nodev,size=64m",
                },
            },
            "Mounts": [
                {
                    "Type": "bind",
                    "Destination": "/project",
                    "Source": str(project),
                    "RW": False,
                },
                {
                    "Type": "bind",
                    "Destination": "/input",
                    "Source": str(scenario),
                    "RW": False,
                },
            ],
        }
        _validate_docker_container_inspect(inspected, options, project, scenario)
        inspected["HostConfig"]["LogConfig"]["Type"] = "json-file"
        with self.assertRaisesRegex(EDAError, "disabled Docker daemon logging"):
            _validate_docker_container_inspect(inspected, options, project, scenario)
        inspected["HostConfig"]["LogConfig"]["Type"] = "none"
        inspected["HostConfig"]["NetworkMode"] = "bridge"
        with self.assertRaisesRegex(EDAError, "network"):
            _validate_docker_container_inspect(inspected, options, project, scenario)

    def test_container_timeout_removes_the_running_job(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            stage, scenario = root / "project", root / "scenario"
            stage.mkdir()
            scenario.mkdir()
            inspected = {
                "Config": {"User": "65534:65534", "Image": DEFAULT_DOCKER_IMAGE},
                "HostConfig": {
                    "NetworkMode": "none",
                    "ReadonlyRootfs": True,
                    "CapDrop": ["ALL"],
                    "SecurityOpt": ["no-new-privileges:true"],
                    "LogConfig": {"Type": "none"},
                    "Memory": 1024 * 1024 * 1024,
                    "NanoCpus": 1_000_000_000,
                    "PidsLimit": 64,
                    "Tmpfs": {
                        "/work": "rw,noexec,nosuid,nodev,size=512m",
                        "/tmp": "rw,noexec,nosuid,nodev,size=64m",
                    },
                },
                "Mounts": [
                    {
                        "Type": "bind",
                        "Destination": "/project",
                        "Source": str(stage),
                        "RW": False,
                    },
                    {
                        "Type": "bind",
                        "Destination": "/input",
                        "Source": str(scenario),
                        "RW": False,
                    },
                ],
            }
            calls = []

            def docker_call(_docker, args, *, binary=False, **_kwargs):
                calls.append(args)
                if args[0] == "create":
                    return subprocess.CompletedProcess(
                        args, 0, stdout="id\n", stderr=""
                    )
                if args[0] == "inspect" and "{{json .}}" in args:
                    return subprocess.CompletedProcess(
                        args, 0, stdout=json.dumps(inspected), stderr=""
                    )
                if args[0] == "inspect":
                    return subprocess.CompletedProcess(
                        args, 0, stdout="true|0\n", stderr=""
                    )
                if args[0] == "exec" and "/work/exit-code" in args:
                    return subprocess.CompletedProcess(
                        args, 75, stdout=b"", stderr=b"missing"
                    )
                if args[0] == "exec":
                    return subprocess.CompletedProcess(
                        args,
                        0,
                        stdout=b"" if binary else "",
                        stderr=b"" if binary else "",
                    )
                return subprocess.CompletedProcess(args, 0, stdout="", stderr="")

            with (
                patch("edastack.core._docker_call", side_effect=docker_call),
                patch("edastack.core.time.monotonic", side_effect=[10.0, 12.0]),
            ):
                result = _docker_run_scenario(
                    "docker",
                    _validate_container_options("docker", DEFAULT_DOCKER_IMAGE),
                    stage,
                    "/project",
                    scenario,
                    root / "ngspice.log",
                    {},
                    1,
                )

            self.assertEqual(result[2:], (-1, True))
            create_args = next(call for call in calls if call[0] == "create")
            self.assertIn("--log-driver=none", create_args)
            self.assertIn(
                [
                    "rm",
                    "--force",
                    next(
                        arg
                        for call in calls
                        if call[0] == "create"
                        for arg in call
                        if arg.startswith("edastack-")
                    ),
                ],
                calls,
            )


class ContainerInputStagingTests(unittest.TestCase):
    def test_named_library_section_is_staged_and_internal_lib_block_is_not_a_path(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "project"
            netlist_dir = root / "examples" / "rc"
            model_dir = root / "models"
            netlist_dir.mkdir(parents=True)
            model_dir.mkdir()
            netlist = netlist_dir / "input.cir"
            model_file = model_dir / "models.lib"
            netlist.write_text(
                'RC fixture\n'
                '.lib "../../models/models.lib" TT\n'
                '.lib TT $ internal section comment\n'
                '.end\n'
            )
            model_file.write_text(".lib TT\nRTEST 1 0 1k\n.endl TT\n")

            copied = _collect_container_inputs(netlist, root, Path(td) / "stage")

            staged_netlist = (Path(td) / "stage/examples/rc/input.cir").read_text()
            self.assertEqual(copied, 2)
            self.assertIn('.lib "../../models/models.lib" TT', staged_netlist)
            self.assertIn(".lib TT $ internal section comment", staged_netlist)
            self.assertTrue((Path(td) / "stage/models/models.lib").is_file())

    def test_oversized_input_is_rejected_before_reading_file_contents(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "project"
            root.mkdir()
            netlist = root / "large.cir"
            with netlist.open("wb") as stream:
                stream.truncate(32 * 1024 * 1024 + 1)
            with patch.object(Path, "read_bytes", side_effect=AssertionError("unbounded read")):
                with self.assertRaisesRegex(EDAError, "32 MiB per-file limit"):
                    _collect_container_inputs(netlist, root, Path(td) / "stage")

    def test_stages_only_recursive_spice_inputs_and_normalizes_paths(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "project"
            netlist_dir = root / "examples" / "rc"
            model_dir = root / "models"
            netlist_dir.mkdir(parents=True)
            model_dir.mkdir()
            netlist = netlist_dir / "input.cir"
            netlist.write_text('RC fixture\n.include "../../models/main.lib"\n.end\n')
            (model_dir / "main.lib").write_text(
                '.include "../../examples/rc/inner.lib"\n'
            )
            (netlist_dir / "inner.lib").write_text("* leaf model\n")
            (root / "private.txt").write_text("not mounted\n")
            staged = Path(td) / "staged"

            copied = _collect_container_inputs(netlist, root, staged)

            self.assertEqual(copied, 3)
            self.assertTrue((staged / "examples/rc/input.cir").is_file())
            self.assertTrue((staged / "models/main.lib").is_file())
            self.assertTrue((staged / "examples/rc/inner.lib").is_file())
            self.assertFalse((staged / "private.txt").exists())
            self.assertIn(
                '.include "../../models/main.lib"',
                (staged / "examples/rc/input.cir").read_text(),
            )
            self.assertIn(
                '.include "inner.lib"', (staged / "models/main.lib").read_text()
            )

    def test_rejects_missing_and_project_escaping_includes(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td) / "project"
            netlist_dir = root / "examples" / "rc"
            netlist_dir.mkdir(parents=True)
            netlist = netlist_dir / "input.cir"
            staged = Path(td) / "staged"
            (Path(td) / "outside.lib").write_text("* outside the project root\n")
            netlist.write_text('RC fixture\n.include "../../../outside.lib"\n.end\n')
            with self.assertRaisesRegex(EDAError, "within the project root"):
                _collect_container_inputs(netlist, root, staged)

            netlist.write_text('RC fixture\n.include "missing.lib"\n.end\n')
            with self.assertRaisesRegex(EDAError, "unavailable"):
                _collect_container_inputs(netlist, root, staged)


if __name__ == "__main__":
    unittest.main()

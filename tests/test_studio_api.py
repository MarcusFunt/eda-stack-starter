import hashlib
import importlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient


def _studio_api():
    try:
        spec = importlib.util.find_spec("edastack.studio.api")
    except ModuleNotFoundError:
        spec = None
    assert spec is not None, "EDA Studio API routes have not been implemented"
    return importlib.import_module("edastack.studio.api")


def _make_studio_project(workspace: Path, project_id: str) -> Path:
    project_root = workspace / project_id
    source_path = project_root / "src" / "board.tsx"
    source_path.parent.mkdir(parents=True)
    source_path.write_bytes(b"export default function Board() { return null; }\n")
    (project_root / "eda.project.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "project_id": project_id,
                "authoring_backend": "tscircuit",
                "entrypoint": "src/board.tsx",
            }
        ),
        encoding="utf-8",
    )
    return project_root


def test_health_exposes_a_versioned_service_contract():
    api = _studio_api()
    response = TestClient(api.create_app()).get(
        "/api/v1/health", headers={"host": "127.0.0.1"}
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["schema_version"] == 1
    assert payload["service"] == "eda-studio-api"
    assert payload["status"] == "ok"
    assert payload["api_version"] == "v1"
    assert payload["build_version"]


def test_unknown_route_returns_a_typed_error_with_request_id():
    api = _studio_api()
    response = TestClient(api.create_app()).get(
        "/api/v1/not-a-route", headers={"host": "localhost"}
    )

    assert response.status_code == 404
    assert response.headers["x-request-id"]
    assert response.json() == {
        "schema_version": 1,
        "error": {
            "code": "NOT_FOUND",
            "message": "The requested API route was not found.",
            "request_id": response.headers["x-request-id"],
        },
    }


def test_host_and_origin_checks_reject_untrusted_web_origins():
    api = _studio_api()
    client = TestClient(api.create_app())

    host_response = client.get(
        "/api/v1/health", headers={"host": "127.0.0.1.attacker.example"}
    )
    origin_response = client.get(
        "/api/v1/health",
        headers={"host": "127.0.0.1", "origin": "https://attacker.example"},
    )

    assert host_response.status_code == 403
    assert host_response.json()["error"]["code"] == "HOST_NOT_ALLOWED"
    assert origin_response.status_code == 403
    assert origin_response.json()["error"]["code"] == "ORIGIN_NOT_ALLOWED"


def test_origin_allowlist_cannot_enable_a_remote_browser_origin():
    api = _studio_api()
    app = api.create_app(
        settings=api.StudioSettings(allowed_origins=("https://attacker.example",))
    )
    response = TestClient(app).get(
        "/api/v1/health",
        headers={"host": "127.0.0.1", "origin": "https://attacker.example"},
    )

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "ORIGIN_NOT_ALLOWED"


def test_origin_allowlist_accepts_a_configured_loopback_dev_server():
    api = _studio_api()
    app = api.create_app(
        settings=api.StudioSettings(allowed_origins=("http://127.0.0.1:5173",))
    )
    response = TestClient(app).get(
        "/api/v1/health",
        headers={"host": "127.0.0.1:8765", "origin": "http://127.0.0.1:5173"},
    )

    assert response.status_code == 200


def test_openapi_lists_health_toolchain_and_typed_errors():
    api = _studio_api()
    schema = api.create_app().openapi()

    assert schema["info"]["version"] == "1.0.0"
    assert "/api/v1/health" in schema["paths"]
    assert "/api/v1/toolchain" in schema["paths"]
    assert "ErrorResponse" in schema["components"]["schemas"]


def test_projects_list_and_detail_are_scoped_to_the_configured_workspace(tmp_path: Path):
    api = _studio_api()
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    _make_studio_project(workspace, "voltage-divider")
    outside = tmp_path / "outside"
    _make_studio_project(tmp_path, "outside")

    client = TestClient(api.create_app(settings=api.StudioSettings(workspace_root=workspace)))
    headers = {"host": "127.0.0.1"}
    listing = client.get("/api/v1/projects", headers=headers)
    detail = client.get("/api/v1/projects/voltage-divider", headers=headers)

    assert listing.status_code == 200, listing.text
    assert listing.json()["workspace_status"] == "available"
    assert listing.json()["workspace_name"] == "workspace"
    assert [project["project_id"] for project in listing.json()["projects"]] == ["voltage-divider"]
    assert str(workspace) not in listing.text
    assert str(outside) not in listing.text
    assert detail.status_code == 200, detail.text
    assert detail.json()["entrypoint"] == "src/board.tsx"
    assert detail.json()["source_files"] == [
        {"path": "src/board.tsx", "bytes": len(b"export default function Board() { return null; }\n")}
    ]


def test_project_detail_indexes_typescript_and_tsx_modules(tmp_path: Path):
    api = _studio_api()
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    project_root = _make_studio_project(workspace, "voltage-divider")
    helper = project_root / "src" / "components.ts"
    helper.write_text("export const resistance = 1000;\n", encoding="utf-8")

    response = TestClient(api.create_app(settings=api.StudioSettings(workspace_root=workspace))).get(
        "/api/v1/projects/voltage-divider", headers={"host": "127.0.0.1"}
    )

    assert response.status_code == 200, response.text
    assert response.json()["source_file_count"] == 2
    assert [item["path"] for item in response.json()["source_files"]] == [
        "src/board.tsx",
        "src/components.ts",
    ]


def test_projects_report_unconfigured_and_unavailable_workspace_roots(tmp_path: Path):
    api = _studio_api()
    no_workspace = TestClient(api.create_app()).get("/api/v1/projects", headers={"host": "localhost"})
    invalid_root = TestClient(
        api.create_app(settings=api.StudioSettings(workspace_root=tmp_path / "missing"))
    ).get("/api/v1/projects", headers={"host": "localhost"})

    assert no_workspace.status_code == 200
    assert no_workspace.json()["workspace_status"] == "not_configured"
    assert no_workspace.json()["projects"] == []
    assert invalid_root.status_code == 200
    assert invalid_root.json()["workspace_status"] == "unavailable"
    assert invalid_root.json()["projects"] == []


def test_project_list_does_not_follow_symlinked_projects(tmp_path: Path):
    api = _studio_api()
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside_root = tmp_path / "outside"
    _make_studio_project(tmp_path, "outside")
    link = workspace / "outside"
    try:
        link.symlink_to(outside_root, target_is_directory=True)
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"directory symlinks are not available: {exc}")

    response = TestClient(api.create_app(settings=api.StudioSettings(workspace_root=workspace))).get(
        "/api/v1/projects", headers={"host": "127.0.0.1"}
    )

    assert response.status_code == 200
    assert response.json()["projects"] == []


@pytest.mark.parametrize("manifest", [b"[" * 1_500, b"{" + b" " * (64 * 1024) + b"}"])
def test_malformed_or_oversized_project_manifests_do_not_break_discovery(tmp_path: Path, manifest: bytes):
    api = _studio_api()
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    _make_studio_project(workspace, "valid-project")
    invalid_root = workspace / "invalid-project"
    invalid_root.mkdir()
    (invalid_root / "eda.project.json").write_bytes(manifest)

    response = TestClient(api.create_app(settings=api.StudioSettings(workspace_root=workspace))).get(
        "/api/v1/projects", headers={"host": "127.0.0.1"}
    )

    assert response.status_code == 200, response.text
    assert [project["project_id"] for project in response.json()["projects"]] == ["valid-project"]


def test_project_routes_reject_unknown_and_path_traversal_ids(tmp_path: Path):
    api = _studio_api()
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    client = TestClient(api.create_app(settings=api.StudioSettings(workspace_root=workspace)))
    headers = {"host": "127.0.0.1"}

    missing = client.get("/api/v1/projects/missing", headers=headers)
    traversal = client.get("/api/v1/projects/%2E%2E", headers=headers)

    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "PROJECT_NOT_FOUND"
    assert traversal.status_code == 422
    assert traversal.json()["error"]["code"] == "INVALID_REQUEST"


def test_toolchain_keeps_missing_simulator_explicitly_unavailable(monkeypatch):
    api = _studio_api()
    monkeypatch.delenv("EDA_STUDIO_NGSPICE", raising=False)
    monkeypatch.delenv("EDA_STUDIO_DOCKER", raising=False)
    toolchain = api.detect_toolchain(
        executable_lookup=lambda _name: None,
        command_runner=None,
    )

    assert toolchain.tools["ngspice"].status == "unavailable"
    assert toolchain.tools["ngspice"].version is None
    assert toolchain.tools["docker"].status == "unavailable"


def test_toolchain_extracts_ngspice_version_from_its_banner(monkeypatch):
    api = _studio_api()
    monkeypatch.delenv("EDA_STUDIO_NGSPICE", raising=False)

    def command_runner(command, **_kwargs):
        if command[0] == "fake-ngspice":
            return SimpleNamespace(
                returncode=0,
                stdout="******\n** ngspice-47 : Circuit level simulation program\n",
                stderr="",
            )
        return SimpleNamespace(returncode=1, stdout="", stderr="")

    toolchain = api.detect_toolchain(
        executable_lookup=lambda name: f"fake-{name}",
        command_runner=command_runner,
    )

    assert toolchain.tools["ngspice"].status == "available"
    assert toolchain.tools["ngspice"].version == "ngspice-47"


def test_toolchain_finds_kicad_cli_using_its_conventional_name(monkeypatch):
    api = _studio_api()
    monkeypatch.delenv("EDA_STUDIO_KICAD_CLI", raising=False)
    requested = []

    def executable_lookup(name):
        requested.append(name)
        return "D:/Programs/KiCad/10.0.8/bin/kicad-cli.exe" if name == "kicad-cli" else None

    def command_runner(command, **_kwargs):
        if command[0].endswith("kicad-cli.exe"):
            return SimpleNamespace(returncode=0, stdout="10.0.8\n", stderr="")
        return SimpleNamespace(returncode=1, stdout="", stderr="")

    toolchain = api.detect_toolchain(
        executable_lookup=executable_lookup,
        command_runner=command_runner,
    )

    assert toolchain.tools["kicad_cli"].status == "available"
    assert toolchain.tools["kicad_cli"].version == "10.0.8"
    assert toolchain.tools["kicad_cli"].executable == "D:/Programs/KiCad/10.0.8/bin/kicad-cli.exe"
    assert "kicad-cli" in requested


def test_toolchain_explicit_executable_override_is_reported_and_not_silently_replaced(monkeypatch):
    api = _studio_api()
    override = "D:/Programs/Custom KiCad/bin/kicad-cli.exe"
    monkeypatch.setenv("EDA_STUDIO_KICAD_CLI", override)
    requested = []

    def executable_lookup(name):
        requested.append(name)
        return override if name == override else None

    def command_runner(command, **_kwargs):
        if command[0] == override:
            return SimpleNamespace(returncode=0, stdout="10.0.8\n", stderr="")
        return SimpleNamespace(returncode=1, stdout="", stderr="")

    toolchain = api.detect_toolchain(
        executable_lookup=executable_lookup,
        command_runner=command_runner,
    )

    assert toolchain.tools["kicad_cli"].status == "available"
    assert toolchain.tools["kicad_cli"].executable == override
    assert override in requested
    assert "kicad-cli" not in requested


@pytest.mark.parametrize(
    ("system", "name", "expected"),
    [
        ("Linux", "ngspice", "/usr/bin/ngspice"),
        ("Linux", "kicad_cli", "/usr/bin/kicad-cli"),
        ("Darwin", "ngspice", "/opt/homebrew/bin/ngspice"),
        ("Darwin", "kicad_cli", "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli"),
    ],
)
def test_toolchain_includes_platform_installation_paths(system, name, expected, monkeypatch):
    toolchain = importlib.import_module("edastack.studio.toolchain")
    monkeypatch.setattr(toolchain.platform, "system", lambda: system)

    candidates = toolchain._platform_tool_paths(name)

    assert candidates[0].as_posix() == expected


def test_windows_kicad_installation_versions_are_sorted_numerically(tmp_path: Path, monkeypatch):
    toolchain = importlib.import_module("edastack.studio.toolchain")
    program_files = tmp_path / "Program Files"
    install_root = program_files / "KiCad"
    (install_root / "9.0" / "bin").mkdir(parents=True)
    (install_root / "10.0" / "bin").mkdir(parents=True)
    monkeypatch.setattr(toolchain.platform, "system", lambda: "Windows")
    monkeypatch.setenv("ProgramFiles", str(program_files))
    monkeypatch.setenv("ProgramFiles(x86)", str(tmp_path / "Program Files (x86)"))

    candidates = toolchain._platform_tool_paths("kicad_cli")

    assert candidates[0] == install_root / "10.0" / "bin" / "kicad-cli.exe"


@pytest.mark.parametrize("image_lock_matches", [True, False])
def test_toolchain_requires_pinned_sandbox_image_labels(image_lock_matches: bool):
    api = _studio_api()
    root = Path(__file__).resolve().parents[1]
    lock_hash = hashlib.sha256(
        (root / "packages" / "tscircuit-compiler" / "package-lock.json").read_bytes()
    ).hexdigest()
    labels = {
        "org.edastack.project-sandbox": "tscircuit-v1",
        "org.edastack.compiler-lock-sha256": lock_hash if image_lock_matches else "0" * 64,
    }

    def command_runner(command, **_kwargs):
        if "--format" in command and "Config.Labels" in command[-2]:
            output = json.dumps(labels)
        elif "--format" in command and command[-2] == "{{.Id}}":
            output = "sha256:" + "a" * 64
        else:
            output = "29.9.2"
        return SimpleNamespace(returncode=0, stdout=output, stderr="")

    toolchain = api.detect_toolchain(
        executable_lookup=lambda name: f"fake-{name}",
        command_runner=command_runner,
    )

    expected_status = "available" if image_lock_matches else "unavailable"
    assert toolchain.tools["tscircuit_sandbox"].status == expected_status


def test_compile_returns_hash_indexed_manifest_without_host_paths(tmp_path: Path):
    api = _studio_api()
    workspace = tmp_path / "workspace"
    project_root = workspace / "voltage-divider"
    source_path = project_root / "src" / "board.tsx"
    source_path.parent.mkdir(parents=True)
    source_bytes = b"export default function Board() { return null; }\n"
    source_path.write_bytes(source_bytes)
    (project_root / "eda.project.json").write_text("{}", encoding="utf-8")
    build_calls = []

    def fake_build(project_root_arg, output_dir_arg, **_kwargs):
        output_dir = Path(output_dir_arg)
        output_dir.mkdir(parents=True)
        (output_dir / "circuit.json").write_bytes(b"[]\n")
        (output_dir / "source-graph.json").write_bytes(b"{}\n")
        (output_dir / "kicad").mkdir()
        (output_dir / "kicad" / "voltage-divider.kicad_sch").write_bytes(b"(kicad_sch)\n")
        manifest = {
            "schema_version": 1,
            "status": "compiled",
            "project_name": "voltage-divider",
            "entrypoint": "src/board.tsx",
            "created_at_utc": "2026-11-09T12:00:00Z",
            "source_files": [
                {
                    "path": "src/board.tsx",
                    "sha256": hashlib.sha256(source_bytes).hexdigest(),
                    "bytes": len(source_bytes),
                }
            ],
            "source_graph_counts": {"components": 3, "ports": 6, "nets": 3},
            "toolchain": {
                "node": "v24.15.0",
                "tscircuit": "0.0.3114",
                "react": "19.3.1",
                "compiler_runtime": "0.1.0",
                "compiler_lock_sha256": "b" * 64,
                "sandbox_image": "sha256:" + "c" * 64,
                "circuit_json_to_kicad": "0.0.270",
                "worker": "0.1.0",
            },
            "circuit_json_sha256": hashlib.sha256(b"[]\n").hexdigest(),
            "source_graph_sha256": hashlib.sha256(b"{}\n").hexdigest(),
            "parts_verification": {
                "status": "unverified",
                "unresolved": 3,
                "sha256": "d" * 64,
            },
            "kicad_export_files": ["kicad/voltage-divider.kicad_sch"],
            "artifacts": {
                "circuit.json": {
                    "sha256": hashlib.sha256(b"[]\n").hexdigest(),
                    "bytes": 3,
                },
                "source-graph.json": {
                    "sha256": hashlib.sha256(b"{}\n").hexdigest(),
                    "bytes": 3,
                },
                "kicad/voltage-divider.kicad_sch": {
                    "sha256": hashlib.sha256(b"(kicad_sch)\n").hexdigest(),
                    "bytes": len(b"(kicad_sch)\n"),
                },
            },
        }
        manifest_path = output_dir / "build-manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        build_calls.append((Path(project_root_arg), output_dir))
        return SimpleNamespace(manifest_path=manifest_path)

    app = api.create_app(
        settings=api.StudioSettings(workspace_root=workspace),
        compiler=fake_build,
    )
    client = TestClient(app)
    session = client.get("/api/v1/session", headers={"host": "127.0.0.1"})
    token = session.json()["session_token"]
    response = client.post(
        "/api/v1/projects/voltage-divider/compile",
        headers={"host": "127.0.0.1", "authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["schema_version"] == 1
    assert payload["status"] == "compiled"
    assert payload["source_graph_counts"] == {"components": 3, "ports": 6, "nets": 3}
    assert payload["toolchain"]["tscircuit"] == "0.0.3114"
    assert payload["artifacts"]["circuit.json"]["bytes"] == 3
    assert len(payload["manifest_sha256"]) == 64
    assert str(workspace) not in response.text
    assert build_calls[0][0] == project_root.resolve()
    assert build_calls[0][1].is_relative_to(workspace.resolve())
    assert build_calls[0][1] != project_root


@pytest.mark.parametrize(
    "mismatch",
    [
        "circuit_digest",
        "source_graph_digest",
        "unindexed_kicad_reference",
        "entrypoint_not_in_source_index",
        "source_file_digest",
        "duplicate_source_path",
    ],
)
def test_compile_rejects_inconsistent_build_manifest(tmp_path: Path, mismatch: str):
    api = _studio_api()
    workspace = tmp_path / "workspace"
    project_root = workspace / "voltage-divider"
    source_bytes = b"export default function Board() { return null; }\n"
    source_path = project_root / "src" / "board.tsx"
    source_path.parent.mkdir(parents=True)
    source_path.write_bytes(source_bytes)
    (project_root / "eda.project.json").write_text("{}", encoding="utf-8")

    artifact_bytes = {
        "circuit.json": b"[]\n",
        "source-graph.json": b"{}\n",
        "kicad/voltage-divider.kicad_sch": b"(kicad_sch)\n",
    }
    source_entry = {
        "path": "src/board.tsx",
        "sha256": hashlib.sha256(source_bytes).hexdigest(),
        "bytes": len(source_bytes),
    }
    manifest = {
        "schema_version": 1,
        "status": "compiled",
        "project_name": "voltage-divider",
        "entrypoint": "src/board.tsx",
        "created_at_utc": "2026-11-09T12:00:00Z",
        "source_files": [source_entry],
        "source_graph_counts": {"components": 3, "ports": 6, "nets": 3},
        "toolchain": {
            "node": "v24.15.0",
            "tscircuit": "0.0.3114",
            "react": "19.3.1",
            "compiler_runtime": "0.1.0",
            "compiler_lock_sha256": "b" * 64,
            "sandbox_image": "sha256:" + "c" * 64,
            "circuit_json_to_kicad": "0.0.270",
            "worker": "0.1.0",
        },
        "circuit_json_sha256": hashlib.sha256(artifact_bytes["circuit.json"]).hexdigest(),
        "source_graph_sha256": hashlib.sha256(artifact_bytes["source-graph.json"]).hexdigest(),
        "parts_verification": {"status": "unverified", "unresolved": 3, "sha256": "d" * 64},
        "kicad_export_files": ["kicad/voltage-divider.kicad_sch"],
        "artifacts": {
            path: {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
            for path, data in artifact_bytes.items()
        },
    }
    if mismatch == "circuit_digest":
        manifest["circuit_json_sha256"] = "e" * 64
    elif mismatch == "source_graph_digest":
        manifest["source_graph_sha256"] = "e" * 64
    elif mismatch == "unindexed_kicad_reference":
        manifest["kicad_export_files"] = ["kicad/missing.kicad_sch"]
    elif mismatch == "entrypoint_not_in_source_index":
        manifest["entrypoint"] = "src/missing.tsx"
    elif mismatch == "source_file_digest":
        manifest["source_files"][0]["sha256"] = "e" * 64
    elif mismatch == "duplicate_source_path":
        manifest["source_files"].append(source_entry.copy())

    def fake_build(_project_root, output_dir_arg, **_kwargs):
        output_dir = Path(output_dir_arg)
        for relative, data in artifact_bytes.items():
            artifact_path = output_dir / relative
            artifact_path.parent.mkdir(parents=True, exist_ok=True)
            artifact_path.write_bytes(data)
        manifest_path = output_dir / "build-manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        return SimpleNamespace(manifest_path=manifest_path)

    app = api.create_app(
        settings=api.StudioSettings(workspace_root=workspace),
        compiler=fake_build,
    )
    client = TestClient(app)
    token = client.get("/api/v1/session", headers={"host": "127.0.0.1"}).json()["session_token"]
    response = client.post(
        "/api/v1/projects/voltage-divider/compile",
        headers={"host": "127.0.0.1", "authorization": f"Bearer {token}"},
    )

    assert response.status_code == 502
    assert response.json()["error"]["code"] == "BUILD_MANIFEST_INVALID"


def test_compile_requires_session_token_before_touching_project(tmp_path: Path):
    api = _studio_api()
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    called = False

    def fake_build(*_args, **_kwargs):
        nonlocal called
        called = True

    app = api.create_app(
        settings=api.StudioSettings(workspace_root=workspace),
        compiler=fake_build,
    )
    response = TestClient(app).post(
        "/api/v1/projects/voltage-divider/compile",
        headers={"host": "localhost"},
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "AUTH_REQUIRED"
    assert not called


def test_compile_rejects_path_traversal_project_ids(tmp_path: Path):
    api = _studio_api()
    app = api.create_app(settings=api.StudioSettings(workspace_root=tmp_path))
    client = TestClient(app)
    token = client.get("/api/v1/session", headers={"host": "127.0.0.1"}).json()["session_token"]
    response = client.post(
        "/api/v1/projects/%2E%2E/compile",
        headers={"host": "127.0.0.1", "authorization": f"Bearer {token}"},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_REQUEST"

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


def test_toolchain_keeps_missing_simulator_explicitly_unavailable():
    api = _studio_api()
    toolchain = api.detect_toolchain(
        executable_lookup=lambda _name: None,
        command_runner=None,
    )

    assert toolchain.tools["ngspice"].status == "unavailable"
    assert toolchain.tools["ngspice"].version is None
    assert toolchain.tools["kicad_cli"].status == "unavailable"
    assert toolchain.tools["docker"].status == "unavailable"


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
    project_root.mkdir(parents=True)
    (project_root / "eda.project.json").write_text("{}", encoding="utf-8")
    build_calls = []

    def fake_build(project_root_arg, output_dir_arg, **_kwargs):
        output_dir = Path(output_dir_arg)
        output_dir.mkdir(parents=True)
        (output_dir / "circuit.json").write_bytes(b"[]\n")
        (output_dir / "source-graph.json").write_bytes(b"{}\n")
        manifest = {
            "schema_version": 1,
            "status": "compiled",
            "project_name": "voltage-divider",
            "entrypoint": "src/board.tsx",
            "created_at_utc": "2026-11-09T12:00:00Z",
            "source_files": [
                {"path": "src/board.tsx", "sha256": "a" * 64, "bytes": 123}
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

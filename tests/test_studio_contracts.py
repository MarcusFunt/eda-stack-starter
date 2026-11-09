import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, ValidationError

from edastack.studio.api import create_app

REPO_ROOT = Path(__file__).resolve().parents[1]
CONTRACT_ROOT = REPO_ROOT / "schemas" / "studio" / "v1"


def _replace_schema_refs(value):
    if isinstance(value, dict):
        return {key: _replace_schema_refs(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_replace_schema_refs(item) for item in value]
    if isinstance(value, str):
        return value.replace("#/components/schemas/", "#/$defs/")
    return value


def test_committed_openapi_matches_the_runtime_contract():
    snapshot_path = CONTRACT_ROOT / "openapi.json"
    assert snapshot_path.is_file(), "the versioned Studio OpenAPI snapshot is missing"

    committed = json.loads(snapshot_path.read_text(encoding="utf-8"))
    runtime = create_app().openapi()

    assert committed == runtime
    assert committed["info"]["version"] == "1.0.0"
    assert "/api/v1/projects" in committed["paths"]
    assert "/api/v1/projects/{project_id}" in committed["paths"]
    assert "/api/v1/projects/{project_id}/compile" in committed["paths"]
    assert committed["components"]["securitySchemes"]["HTTPBearer"]["scheme"] == "bearer"
    for path_item in runtime["paths"].values():
        for operation in path_item.values():
            if isinstance(operation, dict) and "422" in operation.get("responses", {}):
                assert operation["responses"]["422"]["description"] == "Validation Error"


def test_versioned_contract_fixtures_validate_against_openapi_schemas():
    schema_path = CONTRACT_ROOT / "openapi.json"
    assert schema_path.is_file(), "the versioned Studio OpenAPI snapshot is missing"
    document = json.loads(schema_path.read_text(encoding="utf-8"))
    definitions = _replace_schema_refs(document["components"]["schemas"])

    for fixture_name, schema_name in (
        ("health.json", "HealthResponse"),
        ("session.json", "SessionResponse"),
        ("toolchain.json", "ToolchainResponse"),
        ("projects.json", "ProjectListResponse"),
        ("project.json", "ProjectDetailResponse"),
        ("error.json", "ErrorResponse"),
        ("compile.json", "CompileResponse"),
    ):
        fixture_path = CONTRACT_ROOT / "examples" / fixture_name
        assert fixture_path.is_file(), f"missing Studio contract fixture: {fixture_name}"
        schema = {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$defs": definitions,
            "$ref": f"#/$defs/{schema_name}",
        }
        Draft202012Validator(schema).validate(json.loads(fixture_path.read_text(encoding="utf-8")))


def test_status_taxonomy_preserves_failure_absence_review_and_approval():
    status_path = CONTRACT_ROOT / "statuses.json"
    assert status_path.is_file(), "the versioned Studio status contract is missing"
    status_schema = json.loads(status_path.read_text(encoding="utf-8"))
    dispositions = status_schema["$defs"]["CheckDisposition"]
    jobs = status_schema["$defs"]["JobState"]
    revisions = status_schema["$defs"]["RevisionState"]

    for value in (
        "passed",
        "failed",
        "error",
        "not_run",
        "measured_only",
        "unsupported",
        "stale",
        "review_required",
        "approved",
    ):
        Draft202012Validator(dispositions).validate(value)
    Draft202012Validator(jobs).validate("failed_infrastructure")
    Draft202012Validator(jobs).validate("interrupted")
    Draft202012Validator(revisions).validate("frozen_candidate")
    with pytest.raises(ValidationError):
        Draft202012Validator(dispositions).validate("green")

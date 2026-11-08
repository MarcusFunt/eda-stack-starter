"""Run trusted SPICE netlists in isolated scenario directories and check bounds.

No proprietary or paid services required. Requires an external ngspice executable
for *real* circuit simulations. Never substitutes an approximate Python simulator.
"""

from __future__ import annotations

import csv
import hashlib
import itertools
import json
import math
import os
import re
import shutil
import stat
import statistics
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Sequence
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

VALID_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")
VALID_SPICE_VALUE = re.compile(
    r"^[+\-]?(?:\d+\.?\d*|\.\d+)(?:[Ee][+\-]?\d+)?(?:[TGMKmunpf]|meg)?$", re.I
)
MEAS_PATTERN = re.compile(
    r"^\s*([A-Za-z][A-Za-z0-9_]*)\s*=\s*([+\-]?(?:(?:\d+\.?\d*|\.\d+)(?:[Ee][+\-]?\d+)?|nan|inf))(?=\s|$)",
    re.I | re.M,
)
PLACEHOLDER = re.compile(r"\{\{([A-Za-z][A-Za-z0-9_]*)\}\}")
VALID_MEAS = re.compile(r"^meas\s+(?:tran|ac|dc)\s+[a-z][a-z0-9_]*\s+.+$", re.I)
VALID_ANALYSIS = re.compile(r"^(?:tran|ac|dc)\s+[^\r\n]+$", re.I)
VALID_SIGNAL_EXPRESSION = re.compile(
    r"^(?:(?:v|i)\([A-Za-z0-9_]+(?:\s*,\s*[A-Za-z0-9_]+)?\)|@[A-Za-z][A-Za-z0-9_]*\[i\]|(?:\d+\.?\d*|\.\d+)(?:[Ee][+\-]?\d+)?)(?:\s*[+\-*/]\s*(?:(?:v|i)\([A-Za-z0-9_]+(?:\s*,\s*[A-Za-z0-9_]+)?\)|@[A-Za-z][A-Za-z0-9_]*\[i\]|(?:\d+\.?\d*|\.\d+)(?:[Ee][+\-]?\d+)?))*$",
    re.I,
)
VALID_WAVEFORM_SIGNAL = re.compile(
    r"^(?:(?:v|i)\([A-Za-z0-9_]+(?:\s*,\s*[A-Za-z0-9_]+)?\)|@[A-Za-z][A-Za-z0-9_]*\[i\])$",
    re.I,
)
VALID_SHA256 = re.compile(r"^[0-9a-f]{64}$", re.I)
SCENARIO_CATEGORIES = {"nominal", "corner", "fault", "statistical_sample", "other"}
DEFAULT_DOCKER_IMAGE = "kicad/kicad@sha256:3f4a01786dfbe803a65f345c3342b765db9add913f5e9448f8356793714ddc34"
SPICE_INCLUDE_LINE = re.compile(
    r"^(?P<prefix>\s*\.(?P<directive>include|lib)\s+)(?P<token>\"[^\"]+\"|'[^']+'|\S+)(?P<tail>.*)$",
    re.I,
)
DOCKER_COMMAND = (
    "ngspice -b -o /work/ngspice.log /input/input.cir; "
    'result=$?; printf "%s\\n" "$result" > /work/exit-code; sleep 86400'
)
MAX_CONTAINER_INPUT_FILES = 512
MAX_CONTAINER_SINGLE_INPUT_BYTES = 32 * 1024 * 1024
MAX_CONTAINER_LOG_BYTES = 16 * 1024 * 1024
MAX_CONTAINER_WAVEFORM_BYTES = 128 * 1024 * 1024
MAX_CONTAINER_STATUS_BYTES = 32
MAX_DOCKER_STDOUT_BYTES = 1024 * 1024
MAX_DOCKER_STDERR_BYTES = 64 * 1024
SOLVER_FAILURE_PATTERNS = (
    re.compile(r"\btimestep too small\b", re.I),
    re.compile(
        r"\bno convergence\b|\bconvergence failed\b|\bconvergence failure\b", re.I
    ),
    re.compile(r"\bsingular matrix\b|\btrouble with node\b", re.I),
    re.compile(r"\bsimulation interrupted\b|\bfailed to find operating point\b", re.I),
)
SPICE_TIME_SCALES = {
    "": 1.0,
    "t": 1e12,
    "g": 1e9,
    "meg": 1e6,
    "k": 1e3,
    "m": 1e-3,
    "u": 1e-6,
    "n": 1e-9,
    "p": 1e-12,
    "f": 1e-15,
}


class EDAError(Exception):
    """Invalid input or a failed simulation setup."""


def _read_limited_regular_file(
    path: Path, max_bytes: int, purpose: str, *, limit_description: str | None = None
) -> bytes:
    """Read a regular file without allowing an unbounded allocation."""
    try:
        with path.open("rb") as stream:
            metadata = os.fstat(stream.fileno())
            if not stat.S_ISREG(metadata.st_mode):
                raise EDAError(f"{purpose} must be a regular file: {path}")
            if metadata.st_size > max_bytes:
                detail = limit_description or f"{max_bytes}-byte limit"
                raise EDAError(f"{purpose} exceeds the {detail}: {path}")
            content = stream.read(max_bytes + 1)
    except EDAError:
        raise
    except OSError as exc:
        raise EDAError(f"Cannot read {purpose}: {path}: {exc}") from exc
    if len(content) > max_bytes:
        detail = limit_description or f"{max_bytes}-byte limit"
        raise EDAError(f"{purpose} exceeds the {detail}: {path}")
    return content


def _read_limited_text(path: Path, max_bytes: int, purpose: str) -> str:
    try:
        return _read_limited_regular_file(path, max_bytes, purpose).decode("utf-8")
    except UnicodeDecodeError as exc:
        raise EDAError(f"{purpose} must be UTF-8 text: {path}") from exc


def _valid_name(name: Any, what: str) -> str:
    if not isinstance(name, str) or not VALID_NAME.fullmatch(name):
        raise EDAError(f"Invalid {what}: {name!r} (letters, digits, underscores only)")
    return name


def _safe_line(line: Any, what: str, pattern: re.Pattern[str]) -> str:
    if (
        not isinstance(line, str)
        or "\n" in line
        or "\r" in line
        or not pattern.fullmatch(line.strip())
    ):
        raise EDAError(f"Invalid {what}: {line!r}")
    # Reject ngspice command separators and shell-redirection syntax.
    if any(token in line for token in (";", "!", "`", "|", ">", "<", "$", "\\")):
        raise EDAError(f"Unsupported token in {what}: {line!r}")
    return line.strip()


def _normalize_analyses(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list) or not raw:
        raise EDAError("analyses must be a nonempty list")
    is_legacy = all(isinstance(item, str) for item in raw)
    if not is_legacy and not all(isinstance(item, dict) for item in raw):
        raise EDAError(
            "analyses must use either command strings or named analysis objects"
        )
    normalized = []
    ids = set()
    kinds = set()
    for item in raw:
        if isinstance(item, str):
            command = _safe_line(item, "analysis command", VALID_ANALYSIS)
            kind = command.split()[0].casefold()
            analysis_id = kind
        else:
            if set(item) - {"id", "command", "kind"}:
                raise EDAError("Named analyses accept only id and command fields")
            analysis_id = _valid_name(item.get("id"), "analysis id")
            command = _safe_line(
                item.get("command"), f"analysis {analysis_id}", VALID_ANALYSIS
            )
            kind = command.split()[0].casefold()
            if item.get("kind") not in (None, kind):
                raise EDAError(
                    f"Analysis kind does not match command for {analysis_id}"
                )
        key = analysis_id.casefold()
        if key in ids:
            raise EDAError(f"Duplicate analysis id: {analysis_id}")
        ids.add(key)
        if is_legacy and kind in kinds:
            raise EDAError(f"Multiple {kind} analyses require named analysis objects")
        kinds.add(kind)
        normalized.append({"id": analysis_id, "command": command, "kind": kind})
    return normalized


def _ngspice_vector_expression(expression: str) -> str:
    expression = re.sub(
        r"(?i)\bv\(\s*([A-Za-z][A-Za-z0-9_]*)\s*,\s*([A-Za-z][A-Za-z0-9_]*)\s*\)",
        r"(v(\1)-v(\2))",
        expression,
    )
    expression = re.sub(
        r"(?i)\bi\(\s*([A-Za-z][A-Za-z0-9_]*)\s*\)",
        lambda match: f"@{match.group(1).lower()}[i]",
        expression,
    )
    return expression


def _materialize_measurement(measurement: dict[str, Any]) -> tuple[list[str], str]:
    directive = measurement["directive"]
    match = re.match(
        r"^(meas\s+(?:tran|ac|dc)\s+[A-Za-z][A-Za-z0-9_]*\s+(?:max|min|avg|rms|pp)\s+)"
        r"(.+?)(?=\s+(?:from|to)=|$)(.*)$",
        directive,
        re.I,
    )
    if not match:
        return [], _ngspice_vector_expression(directive)
    expression = match.group(2).strip()
    signal = measurement.get("signal")
    if signal and signal.casefold().replace(" ", "") != expression.casefold().replace(
        " ", ""
    ):
        raise EDAError(
            f"Measurement {measurement['id']}.signal does not match its directive vector expression"
        )
    needs_let = bool(
        re.search(r"[+\-*/]", expression)
        or re.search(r"(?i)\bv\([^)]*,[^)]*\)", expression)
    )
    normalized_expression = _ngspice_vector_expression(expression)
    if not needs_let:
        return [], match.group(1) + normalized_expression + match.group(3)
    temporary = f"edastack_{measurement['id'].lower()}"
    return [f"let {temporary} = {normalized_expression}"], match.group(
        1
    ) + temporary + match.group(3)


def _normalize_models(
    raw: Any,
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    if not isinstance(raw, list):
        raise EDAError("models must be a list")
    models = []
    by_id = {}
    for model in raw:
        if not isinstance(model, dict):
            raise EDAError("Each model must be an object")
        required = {"id", "component", "kind", "source", "version", "limitations"}
        if not required.issubset(model):
            raise EDAError(
                f"Model is missing required fields: {sorted(required - set(model))}"
            )
        if set(model) - (required | {"sha256"}):
            raise EDAError("Models contain unsupported fields")
        model_id = _valid_name(model.get("id"), "model id")
        key = model_id.casefold()
        if key in by_id:
            raise EDAError(f"Duplicate model id: {model_id}")
        component = _valid_name(model.get("component"), "model component")
        kind = model.get("kind")
        if kind not in {"spice_primitive", "subcircuit", "behavioral"}:
            raise EDAError(f"Invalid model kind for {model_id}: {kind!r}")
        for field in ("source", "version"):
            value = model.get(field)
            if not isinstance(value, str) or not value.strip() or len(value) > 512:
                raise EDAError(
                    f"Model {model_id}.{field} must be a nonempty string of at most 512 characters"
                )
        limitations = model.get("limitations")
        if (
            not isinstance(limitations, list)
            or not limitations
            or any(
                not isinstance(item, str) or not item.strip() or len(item) > 512
                for item in limitations
            )
        ):
            raise EDAError(
                f"Model {model_id}.limitations must be a nonempty list of strings"
            )
        checksum = model.get("sha256")
        if checksum is not None and (
            not isinstance(checksum, str) or not VALID_SHA256.fullmatch(checksum)
        ):
            raise EDAError(
                f"Model {model_id}.sha256 must be a 64-character SHA-256 or null"
            )
        normalized = {
            "id": model_id,
            "component": component,
            "kind": kind,
            "source": model["source"].strip(),
            "version": model["version"].strip(),
            "sha256": checksum.lower() if checksum else None,
            "limitations": [item.strip() for item in limitations],
        }
        models.append(normalized)
        by_id[key] = normalized
    return models, by_id


def _project_root_for_spec(path: Path) -> Path:
    for parent in path.parents:
        if (parent / "pyproject.toml").is_file() or (parent / ".git").exists():
            return parent.resolve()
    return path.parent.resolve()


def _resolve_model_path(base: Path, relative: Any, what: str) -> Path:
    if (
        not isinstance(relative, str)
        or not relative.strip()
        or Path(relative).is_absolute()
    ):
        raise EDAError(f"{what} must be a nonempty relative path")
    try:
        resolved = (base / relative).resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise EDAError(f"{what} is unavailable: {relative}") from exc
    if not resolved.is_relative_to(base.resolve()):
        raise EDAError(f"{what} must stay within {base}")
    if not resolved.is_file():
        raise EDAError(f"{what} must be a file: {relative}")
    return resolved


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _subcircuit_pins(model_file: Path, subckt_name: str) -> list[str]:
    declarations = []
    for line in model_file.read_text(encoding="utf-8", errors="replace").splitlines():
        clean = line.strip()
        if not clean or clean.startswith("*"):
            continue
        tokens = clean.split()
        if len(tokens) < 3 or tokens[0].casefold() != ".subckt":
            continue
        if tokens[1].casefold() == subckt_name.casefold():
            pin_tokens = tokens[2:]
            for index, token in enumerate(pin_tokens):
                if token.casefold() == "params:" or token.casefold().startswith(
                    "params:"
                ):
                    pin_tokens = pin_tokens[:index]
                    break
            declarations.append(pin_tokens)
    if len(declarations) != 1:
        raise EDAError(
            f"Model file {model_file.name} must declare .SUBCKT {subckt_name} exactly once"
        )
    if not declarations[0] or len({pin.casefold() for pin in declarations[0]}) != len(
        declarations[0]
    ):
        raise EDAError(f"Model {subckt_name} has an empty or duplicate pin order")
    return declarations[0]


def _load_model_library(path: Path) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
    try:
        library = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise EDAError(f"Could not read model library: {path}") from exc
    if (
        not isinstance(library, dict)
        or set(library) != {"schema_version", "library_version", "models"}
        or library.get("schema_version") != 1
    ):
        raise EDAError(
            "Model library must contain schema_version: 1, library_version, and models"
        )
    library_version = library.get("library_version")
    if not isinstance(library_version, str) or not library_version.strip():
        raise EDAError("Model library library_version must be a nonempty string")
    raw_models = library.get("models")
    if not isinstance(raw_models, list) or not raw_models:
        raise EDAError("Model library models must be a nonempty list")
    entries = {}
    allowed = {
        "id",
        "kind",
        "subckt_name",
        "component_type",
        "file",
        "sha256",
        "pin_order",
        "physical_pin_map",
        "source",
        "version",
        "license",
        "manufacturer",
        "part_number",
        "operating_conditions",
        "limitations",
        "validation_fixture",
        "validation_fixture_sha256",
    }
    for raw in raw_models:
        if not isinstance(raw, dict) or set(raw) - allowed:
            raise EDAError("Model library entries contain unsupported fields")
        required = {
            "id",
            "kind",
            "pin_order",
            "physical_pin_map",
            "source",
            "version",
            "license",
            "manufacturer",
            "part_number",
            "operating_conditions",
            "limitations",
            "validation_fixture",
            "validation_fixture_sha256",
        }
        if not required.issubset(raw):
            raise EDAError(
                f"Model library entry is missing fields: {sorted(required - set(raw))}"
            )
        model_id = _valid_name(raw.get("id"), "library model id")
        key = model_id.casefold()
        if key in entries:
            raise EDAError(f"Duplicate model library id: {model_id}")
        kind = raw.get("kind")
        if kind not in {"spice_primitive", "subcircuit"}:
            raise EDAError(f"Unsupported model library kind for {model_id}: {kind!r}")
        for field in ("source", "version", "license"):
            value = raw.get(field)
            if not isinstance(value, str) or not value.strip() or len(value) > 512:
                raise EDAError(f"Model {model_id}.{field} must be a nonempty string")
        for field in ("manufacturer", "part_number"):
            value = raw.get(field)
            if value is not None and (not isinstance(value, str) or not value.strip()):
                raise EDAError(
                    f"Model {model_id}.{field} must be a nonempty string or null"
                )
        limitations = raw.get("limitations")
        if (
            not isinstance(limitations, list)
            or not limitations
            or any(
                not isinstance(item, str) or not item.strip() or len(item) > 512
                for item in limitations
            )
        ):
            raise EDAError(
                f"Model {model_id}.limitations must be a nonempty list of strings"
            )
        pin_order = raw.get("pin_order")
        if (
            not isinstance(pin_order, list)
            or not pin_order
            or any(
                not isinstance(pin, str) or not re.fullmatch(r"[A-Za-z0-9_]{1,64}", pin)
                for pin in pin_order
            )
        ):
            raise EDAError(
                f"Model {model_id}.pin_order must be a nonempty list of pin names"
            )
        if len({pin.casefold() for pin in pin_order}) != len(pin_order):
            raise EDAError(f"Model {model_id} has duplicate pin names")
        physical_pin_map = raw.get("physical_pin_map")
        if not isinstance(physical_pin_map, dict) or not physical_pin_map:
            raise EDAError(
                f"Model {model_id}.physical_pin_map must be a nonempty object"
            )
        if any(
            not isinstance(pin, str)
            or not pin.strip()
            or not isinstance(name, str)
            or not name.strip()
            for pin, name in physical_pin_map.items()
        ):
            raise EDAError(
                f"Model {model_id}.physical_pin_map must map string pin identifiers to names"
            )
        if {pin.casefold() for pin in physical_pin_map.values()} != {
            pin.casefold() for pin in pin_order
        } or len(physical_pin_map) != len(pin_order):
            raise EDAError(
                f"Model {model_id}.physical_pin_map must map every pin exactly once"
            )
        operating = raw.get("operating_conditions")
        if not isinstance(operating, dict) or set(operating) != {
            "temperature_C",
            "voltage_V",
            "assumptions",
        }:
            raise EDAError(
                f"Model {model_id}.operating_conditions has an invalid shape"
            )
        for field in ("temperature_C", "voltage_V"):
            bounds = operating.get(field)
            if not isinstance(bounds, dict) or set(bounds) != {"min", "max", "basis"}:
                raise EDAError(
                    f"Model {model_id}.{field} must contain min, max, and basis"
                )
            for bound in ("min", "max"):
                value = bounds[bound]
                if value is not None and (
                    not isinstance(value, (int, float))
                    or isinstance(value, bool)
                    or not math.isfinite(value)
                ):
                    raise EDAError(
                        f"Model {model_id}.{field}.{bound} must be finite or null"
                    )
            if (
                bounds["min"] is not None
                and bounds["max"] is not None
                and bounds["min"] > bounds["max"]
            ):
                raise EDAError(f"Model {model_id}.{field}.min exceeds max")
            if not isinstance(bounds["basis"], str) or not bounds["basis"].strip():
                raise EDAError(
                    f"Model {model_id}.{field}.basis must be a nonempty string"
                )
        if (
            not isinstance(operating["assumptions"], list)
            or not operating["assumptions"]
            or any(
                not isinstance(item, str) or not item.strip()
                for item in operating["assumptions"]
            )
        ):
            raise EDAError(
                f"Model {model_id}.operating_conditions.assumptions must be a nonempty list"
            )
        fixture_path = _resolve_model_path(
            path.parent,
            raw.get("validation_fixture"),
            f"Model {model_id} validation fixture",
        )
        fixture_hash = raw.get("validation_fixture_sha256")
        if not isinstance(fixture_hash, str) or not VALID_SHA256.fullmatch(
            fixture_hash
        ):
            raise EDAError(
                f"Model {model_id}.validation_fixture_sha256 must be a SHA-256"
            )
        if _sha256_file(fixture_path) != fixture_hash.casefold():
            raise EDAError(f"Model {model_id} validation fixture SHA-256 mismatch")
        model_file = None
        if kind == "subcircuit":
            if "component_type" in raw:
                raise EDAError(
                    f"Subcircuit model {model_id} cannot declare component_type"
                )
            subckt_name = _valid_name(
                raw.get("subckt_name"), f"model {model_id} subcircuit name"
            )
            model_file = _resolve_model_path(
                path.parent, raw.get("file"), f"Model {model_id} file"
            )
            checksum = raw.get("sha256")
            if not isinstance(checksum, str) or not VALID_SHA256.fullmatch(checksum):
                raise EDAError(f"Model {model_id}.sha256 must be a SHA-256")
            if _sha256_file(model_file) != checksum.casefold():
                raise EDAError(f"Model {model_id} SHA-256 mismatch")
            declared_pins = _subcircuit_pins(model_file, subckt_name)
            if [pin.casefold() for pin in declared_pins] != [
                pin.casefold() for pin in pin_order
            ]:
                raise EDAError(
                    f"Model {model_id} library pin order does not match .SUBCKT {subckt_name}"
                )
            component_type = "X"
        else:
            if "subckt_name" in raw:
                raise EDAError(f"Primitive model {model_id} cannot declare subckt_name")
            component_type = raw.get("component_type")
            if (
                not isinstance(component_type, str)
                or len(component_type) != 1
                or not component_type.isalpha()
            ):
                raise EDAError(
                    f"Model {model_id}.component_type must be one SPICE designator letter"
                )
            if raw.get("file") is not None or raw.get("sha256") is not None:
                raise EDAError(
                    f"Built-in primitive model {model_id} cannot declare a separate model file"
                )
            subckt_name = None
        entry = {
            "id": model_id,
            "kind": kind,
            "subckt_name": subckt_name,
            "component_type": component_type,
            "file": str(model_file) if model_file else None,
            "sha256": raw.get("sha256"),
            "pin_order": list(pin_order),
            "physical_pin_map": dict(physical_pin_map),
            "source": raw["source"].strip(),
            "version": raw["version"].strip(),
            "license": raw["license"].strip(),
            "manufacturer": raw["manufacturer"],
            "part_number": raw["part_number"],
            "operating_conditions": operating,
            "limitations": [item.strip() for item in limitations],
            "validation_fixture": str(fixture_path),
            "validation_fixture_sha256": fixture_hash.casefold(),
        }
        entries[key] = entry
    info = {
        "path": str(path),
        "library_version": library_version.strip(),
        "sha256": _sha256_file(path),
    }
    return entries, info


def _model_library_path(spec_path: Path, value: Any) -> Path:
    if not isinstance(value, str) or not value.strip() or Path(value).is_absolute():
        raise EDAError("model_library must be a nonempty relative path")
    project_root = _project_root_for_spec(spec_path)
    try:
        resolved = (spec_path.parent / value).resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise EDAError(f"Model library is unavailable: {value}") from exc
    if not resolved.is_relative_to(project_root) or not resolved.is_file():
        raise EDAError("model_library must resolve to a file within the project root")
    return resolved


def _model_netlist_lines(netlist_path: Path) -> list[list[str]]:
    lines = []
    source = _read_limited_text(
        netlist_path, MAX_CONTAINER_SINGLE_INPUT_BYTES, "Model-mapped netlist"
    )
    for line in source.splitlines():
        clean = line.split("$", 1)[0].strip()
        if not clean or clean.startswith("*"):
            continue
        lines.append(clean.split())
    return lines


def _included_model_paths(source: str, netlist_dir: Path) -> set[Path]:
    paths = set()
    for line in source.splitlines():
        reference_info = _include_reference(line.split("$", 1)[0])
        if reference_info:
            _, _, reference = reference_info
            paths.add((netlist_dir / reference).resolve())
    return paths


def _validate_model_mappings(
    raw_models: Any,
    library: dict[str, dict[str, Any]],
    netlist_path: Path,
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]]]:
    if not isinstance(raw_models, list):
        raise EDAError("models must be a list of model-library mappings")
    source = _read_limited_text(
        netlist_path, MAX_CONTAINER_SINGLE_INPUT_BYTES, "Model-mapped netlist"
    )
    netlist_lines = _model_netlist_lines(netlist_path)
    mapping_ids: set[str] = set()
    mapped_components: set[str] = set()
    models: list[dict[str, Any]] = []
    by_id: dict[str, dict[str, Any]] = {}
    for raw in raw_models:
        required = {"id", "component", "library_ref", "connections"}
        if not isinstance(raw, dict) or set(raw) != required:
            raise EDAError(
                "Model mappings must contain only id, component, library_ref, and connections"
            )
        model_id = _valid_name(raw["id"], "model mapping id")
        key = model_id.casefold()
        if key in mapping_ids:
            raise EDAError(f"Duplicate model mapping id: {model_id}")
        mapping_ids.add(key)
        component = _valid_name(raw["component"], "model component")
        component_key = component.casefold()
        if component_key in mapped_components:
            raise EDAError(f"Duplicate model mapping component: {component}")
        mapped_components.add(component_key)
        library_ref = _valid_name(raw["library_ref"], "library model reference")
        entry = library.get(library_ref.casefold())
        if entry is None:
            raise EDAError(f"Unavailable model library reference: {library_ref}")
        connections = raw["connections"]
        physical_pin_map = entry["physical_pin_map"]
        if not isinstance(connections, dict) or set(connections) != set(
            physical_pin_map
        ):
            raise EDAError(
                f"Model mapping {model_id}.connections must map every physical pin exactly once"
            )
        if any(
            not isinstance(net, str) or not re.fullmatch(r"[A-Za-z0-9_]+", net)
            for net in connections.values()
        ):
            raise EDAError(
                f"Model mapping {model_id}.connections contains an invalid net name"
            )
        expected_nodes = [
            connections[
                next(
                    pin
                    for pin, name in physical_pin_map.items()
                    if name.casefold() == logical.casefold()
                )
            ]
            for logical in entry["pin_order"]
        ]
        instances = [
            line for line in netlist_lines if line[0].casefold() == component_key
        ]
        if len(instances) != 1:
            raise EDAError(
                f"Model mapping {model_id} must resolve to exactly one netlist component {component}"
            )
        instance = instances[0]
        if instance[0][0].casefold() != entry["component_type"].casefold():
            raise EDAError(
                f"Model mapping {model_id} component type does not match its library model"
            )
        if entry["kind"] == "subcircuit":
            node_end = 1 + len(expected_nodes)
            if (
                len(instance) <= node_end
                or instance[node_end].casefold() != entry["subckt_name"].casefold()
            ):
                raise EDAError(
                    f"Model mapping {model_id} netlist instance does not use {entry['subckt_name']}"
                )
            include_paths = _included_model_paths(source, netlist_path.parent)
            if Path(entry["file"]).resolve() not in include_paths:
                raise EDAError(
                    f"Netlist must include model file for {model_id}: {entry['file']}"
                )
            actual_nodes = instance[1:node_end]
        else:
            node_end = 1 + len(expected_nodes)
            if len(instance) < node_end:
                raise EDAError(
                    f"Model mapping {model_id} component has too few terminals"
                )
            actual_nodes = instance[1:node_end]
        if [node.casefold() for node in actual_nodes] != [
            node.casefold() for node in expected_nodes
        ]:
            raise EDAError(
                f"Model mapping {model_id} pin map for {component} does not match netlist terminals"
            )
        normalized = {
            **entry,
            "id": model_id,
            "component": component,
            "library_ref": entry["id"],
            "connections": dict(connections),
        }
        models.append(normalized)
        by_id[key] = normalized
    return models, by_id


def _normalize_waveforms(
    raw: Any, analyses: list[dict[str, str]]
) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        raise EDAError("waveforms must be a list")
    analysis_by_id = {item["id"].casefold(): item for item in analyses}
    normalized = []
    ids = set()
    for waveform in raw:
        if not isinstance(waveform, dict) or set(waveform) != {
            "id",
            "analysis",
            "signals",
        }:
            raise EDAError("Each waveform must contain only id, analysis, and signals")
        waveform_id = _valid_name(waveform.get("id"), "waveform id")
        if waveform_id.casefold() in ids:
            raise EDAError(f"Duplicate waveform id: {waveform_id}")
        ids.add(waveform_id.casefold())
        analysis_id = _valid_name(waveform.get("analysis"), "waveform analysis")
        analysis = analysis_by_id.get(analysis_id.casefold())
        if analysis is None:
            raise EDAError(f"Unknown waveform analysis: {analysis_id}")
        signals = waveform.get("signals")
        if not isinstance(signals, list) or not signals or len(signals) > 32:
            raise EDAError(
                f"Waveform {waveform_id}.signals must contain 1 to 32 vectors"
            )
        clean_signals = []
        signal_ids = set()
        for signal in signals:
            if (
                not isinstance(signal, str)
                or len(signal) > 128
                or not VALID_WAVEFORM_SIGNAL.fullmatch(signal.strip())
            ):
                raise EDAError(f"Invalid waveform signal in {waveform_id}: {signal!r}")
            signal = signal.strip()
            if signal.casefold() in signal_ids:
                raise EDAError(f"Duplicate waveform signal in {waveform_id}: {signal}")
            signal_ids.add(signal.casefold())
            clean_signals.append(signal)
        normalized.append(
            {"id": waveform_id, "analysis": analysis["id"], "signals": clean_signals}
        )
    return normalized


def _scenario_slug(value: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "_", value).strip("_")
    return slug or "value"


def _spice_time_seconds(value: str) -> float | None:
    match = re.fullmatch(
        r"([+-]?(?:\d+\.?\d*|\.\d+)(?:[Ee][+-]?\d+)?)(meg|[tgkmunpf]?)",
        value,
        re.I,
    )
    if not match:
        return None
    number = float(match.group(1))
    multiplier = SPICE_TIME_SCALES.get(match.group(2).casefold())
    if multiplier is None:
        return None
    result = number * multiplier
    return result if math.isfinite(result) else None


def _transient_step_limit(analysis: dict[str, str]) -> dict[str, Any]:
    parts = analysis["command"].split()
    if len(parts) < 3 or parts[0].casefold() != "tran":
        return {"analysis": analysis["id"], "max_step_s": None, "basis": "unparsed"}
    tstep = _spice_time_seconds(parts[1])
    tstop = _spice_time_seconds(parts[2])
    tstart = _spice_time_seconds(parts[3]) if len(parts) > 3 else None
    if tstart is None:
        tstart = 0.0
    if tstep is None or tstep <= 0 or tstop is None or tstop <= tstart:
        return {"analysis": analysis["id"], "max_step_s": None, "basis": "unparsed"}
    explicit_tmax = _spice_time_seconds(parts[4]) if len(parts) > 4 else None
    if explicit_tmax is not None and explicit_tmax > 0:
        max_step, basis = explicit_tmax, "explicit_tmax"
    else:
        max_step, basis = min(tstep, (tstop - tstart) / 50.0), "ngspice_default"
    return {
        "analysis": analysis["id"],
        "tstep_s": tstep,
        "tstart_s": tstart,
        "tstop_s": tstop,
        "max_step_s": max_step,
        "basis": basis,
    }


def _solver_log_diagnostics(log: str) -> dict[str, Any]:
    failures = []
    warnings = []
    for line in log.splitlines():
        clean = line.strip()
        if not clean:
            continue
        if any(pattern.search(clean) for pattern in SOLVER_FAILURE_PATTERNS):
            if clean not in failures:
                failures.append(clean[:500])
        elif re.search(r"\bwarning\b|\bquestionable\b", clean, re.I):
            if clean not in warnings:
                warnings.append(clean[:500])
    status = "failed" if failures else "warning" if warnings else "no_failure_reported"
    if not log.strip():
        status = "not_reported"
    return {"status": status, "failures": failures, "warnings": warnings}


def _scenario_solver_quality(
    log: str,
    analyses: list[dict[str, str]],
    waveform_artifacts: list[dict[str, Any]],
) -> dict[str, Any]:
    diagnostics = _solver_log_diagnostics(log)
    sampling = []
    failures = [
        f"ngspice solver diagnostic: {line}" for line in diagnostics["failures"]
    ]
    for analysis in analyses:
        if analysis["kind"] != "tran":
            continue
        limit = _transient_step_limit(analysis)
        waveforms = [
            waveform
            for waveform in waveform_artifacts
            if waveform["analysis"] == analysis["id"]
        ]
        if not waveforms:
            sampling.append(
                {
                    **limit,
                    "status": "not_checked_no_waveform",
                    "passed": None,
                    "waveform_count": 0,
                }
            )
            continue
        observed = max(waveform["sample_interval_max_s"] for waveform in waveforms)
        passed = limit["max_step_s"] is not None and observed <= (
            limit["max_step_s"] * (1 + 1e-6) + 1e-15
        )
        sampling.append(
            {
                **limit,
                "status": "pass" if passed else "failed",
                "passed": passed,
                "waveform_count": len(waveforms),
                "observed_max_sample_interval_s": observed,
            }
        )
        if not passed:
            failures.append(
                f"Observed waveform sample interval exceeds the transient maximum timestep for {analysis['id']}"
            )
    status = (
        "failed"
        if failures
        else "warning"
        if diagnostics["warnings"]
        else "not_checked"
        if any(item["passed"] is None for item in sampling)
        else "pass"
    )
    return {
        "status": status,
        "convergence": diagnostics,
        "transient_sampling": sampling,
        "failures": failures,
        "warnings": diagnostics["warnings"],
    }


def _expand_sweeps(
    raw: Any, params: dict[str, str], base_scenarios: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        raise EDAError("sweeps must be a list")
    result = [
        dict(
            name=item["name"],
            set=dict(item["set"]),
            category=item["category"],
        )
        for item in base_scenarios
    ]
    sweep_names = set()
    for sweep in raw:
        if not isinstance(sweep, dict) or set(sweep) != {"name", "values"}:
            raise EDAError("Each sweep must contain only name and values")
        sweep_name = _valid_name(sweep.get("name"), "sweep name")
        if sweep_name.casefold() in sweep_names:
            raise EDAError(f"Duplicate sweep: {sweep_name}")
        sweep_names.add(sweep_name.casefold())
        values = sweep.get("values")
        if not isinstance(values, dict) or not values:
            raise EDAError(f"Sweep {sweep_name}.values must be a nonempty object")
        axes = []
        for key, choices in values.items():
            _valid_name(key, "sweep parameter")
            if key not in params:
                raise EDAError(f"Unknown sweep parameter: {key}")
            if not isinstance(choices, list) or not choices:
                raise EDAError(f"Sweep values for {key} must be a nonempty list")
            if any(
                not isinstance(value, str) or not VALID_SPICE_VALUE.fullmatch(value)
                for value in choices
            ):
                raise EDAError(f"Invalid sweep value for {key}")
            axes.append((key, choices))
        combination_count = math.prod(len(choices) for _, choices in axes)
        base_count = max(1, len(base_scenarios))
        if len(result) + combination_count * base_count > 32:
            raise EDAError("Sweep expansion must produce at most 32 scenarios")
        for combination in itertools.product(*(choices for _, choices in axes)):
            overrides = dict(zip((key for key, _ in axes), combination, strict=True))
            label = "_".join(
                [
                    sweep_name,
                    *[
                        f"{key}_{_scenario_slug(value)}"
                        for key, value in overrides.items()
                    ],
                ]
            )
            for base in base_scenarios or [
                {"name": "", "set": {}, "category": "corner"}
            ]:
                name = f"{base['name']}_{label}" if base["name"] else label
                actual = {**params, **base["set"], **overrides}
                if base["category"] in {"fault", "statistical_sample", "other"}:
                    category = base["category"]
                else:
                    category = "nominal" if actual == params else "corner"
                result.append(
                    {
                        "name": name,
                        "set": {**base["set"], **overrides},
                        "category": category,
                    }
                )
    if not result or len(result) > 32:
        raise EDAError("Provide 1 to 32 scenarios after sweep expansion")
    names = set()
    for scenario in result:
        key = scenario["name"].casefold()
        if key in names:
            raise EDAError(f"Duplicate scenario: {scenario['name']}")
        names.add(key)
    return result


def load_spec(spec_path: Path) -> dict[str, Any]:
    path = spec_path.expanduser().resolve(strict=True)
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("schema_version") != 1:
        raise EDAError("Expected spec JSON object with schema_version: 1")
    _valid_name(data.get("name"), "project name")
    netlist = data.get("netlist")
    if not isinstance(netlist, str) or not netlist.strip():
        raise EDAError("netlist must be a nonempty relative path")
    netlist_path = (path.parent / netlist).resolve(strict=True)
    if not netlist_path.is_relative_to(path.parent):
        raise EDAError("netlist must stay within the specification directory")
    if not netlist_path.is_file():
        raise EDAError("netlist must be an existing file")
    params = data.get("parameters", {})
    if not isinstance(params, dict):
        raise EDAError("parameters must be an object")
    for key, value in params.items():
        _valid_name(key, "parameter")
        if not isinstance(value, str) or not VALID_SPICE_VALUE.fullmatch(value):
            raise EDAError(f"Invalid SPICE parameter value for {key}: {value!r}")
    analyses = _normalize_analyses(data.get("analyses"))
    if "model_library" in data:
        model_library_path = _model_library_path(path, data["model_library"])
        library, model_library_info = _load_model_library(model_library_path)
        models, models_by_id = _validate_model_mappings(
            data.get("models", []), library, netlist_path
        )
    else:
        raw_models = data.get("models", [])
        if isinstance(raw_models, list) and any(
            isinstance(model, dict) and "library_ref" in model for model in raw_models
        ):
            raise EDAError("Model mappings with library_ref require model_library")
        models, models_by_id = _normalize_models(raw_models)
        model_library_info = None
    untested_conditions = data.get("untested_conditions")
    if untested_conditions is None:
        untested_conditions = [
            "All conditions outside the explicitly listed scenarios and model assumptions remain untested."
        ]
    if (
        not isinstance(untested_conditions, list)
        or not untested_conditions
        or any(
            not isinstance(condition, str)
            or not condition.strip()
            or len(condition) > 1024
            for condition in untested_conditions
        )
    ):
        raise EDAError("untested_conditions must be a nonempty list of strings")
    sweeps_raw = data.get("sweeps", [])
    if "scenarios" in data:
        scenarios_raw = data["scenarios"]
    else:
        scenarios_raw = [] if sweeps_raw else [{"name": "nominal", "set": {}}]
    if not isinstance(scenarios_raw, list) or len(scenarios_raw) > 32:
        raise EDAError("Provide at most 32 explicit scenarios")
    if not scenarios_raw and not sweeps_raw:
        raise EDAError("Provide at least one scenario or sweep")
    base_scenarios = []
    base_names = set()
    for scenario in scenarios_raw:
        if not isinstance(scenario, dict):
            raise EDAError("Each scenario must be an object")
        if set(scenario) - {"name", "set", "category"}:
            raise EDAError("Scenarios accept only name, set, and category")
        sname = _valid_name(scenario.get("name"), "scenario name")
        if sname.casefold() in base_names:
            raise EDAError(f"Duplicate scenario: {sname}")
        base_names.add(sname.casefold())
        overrides = scenario.get("set", {})
        if not isinstance(overrides, dict):
            raise EDAError("scenario.set must be an object")
        for key, value in overrides.items():
            if key not in params:
                raise EDAError(f"Unknown scenario parameter: {key}")
            if not isinstance(value, str) or not VALID_SPICE_VALUE.fullmatch(value):
                raise EDAError(f"Invalid scenario value for {key}: {value!r}")
        category = scenario.get(
            "category", "nominal" if sname.casefold() == "nominal" else "corner"
        )
        if category not in SCENARIO_CATEGORIES:
            raise EDAError(f"Invalid category for scenario {sname}: {category!r}")
        base_scenarios.append(
            {"name": sname, "set": dict(overrides), "category": category}
        )
    scenarios = _expand_sweeps(sweeps_raw, params, base_scenarios)
    measures = data.get("measurements")
    if not isinstance(measures, list) or not measures:
        raise EDAError("measurements must be a nonempty array")
    measure_names = set()
    allowed_measure_fields = {
        "id",
        "directive",
        "analysis",
        "signal",
        "model_ref",
        "unit",
        "min",
        "max",
        "description",
    }
    analyses_by_id = {item["id"].casefold(): item for item in analyses}
    for m in measures:
        if not isinstance(m, dict):
            raise EDAError("Each measurement must be an object")
        if set(m) - allowed_measure_fields:
            raise EDAError("Measurement contains unsupported fields")
        mid = _valid_name(m.get("id"), "measurement id")
        if mid.casefold() in measure_names:
            raise EDAError(f"Duplicate measurement id: {mid}")
        measure_names.add(mid.casefold())
        directive = _safe_line(m.get("directive"), f"measurement {mid}", VALID_MEAS)
        # Keep the configured measurement identifier synchronized with ngspice output.
        if directive.split()[2].lower() != mid.lower():
            raise EDAError(f"Measurement directive name must match id {mid!r}")
        analysis_kind = directive.split()[1].casefold()
        requested_analysis = m.get("analysis")
        if requested_analysis is None:
            candidates = [item for item in analyses if item["kind"] == analysis_kind]
            if len(candidates) > 1:
                raise EDAError(
                    f"Measurement {mid} must name one of: {', '.join(item['id'] for item in candidates)}"
                )
            if not candidates:
                raise EDAError(
                    f"Measurement {mid} uses an analysis not present in analyses"
                )
            analysis = candidates[0]
        else:
            requested_analysis = _valid_name(
                requested_analysis, f"measurement {mid} analysis"
            )
            analysis = analyses_by_id.get(requested_analysis.casefold())
            if analysis is None:
                raise EDAError(
                    f"Unknown analysis for measurement {mid}: {requested_analysis}"
                )
            if analysis["kind"] != analysis_kind:
                raise EDAError(
                    f"Measurement {mid} kind does not match analysis {analysis['id']}"
                )
        m["analysis"] = analysis["id"]
        if "signal" in m and (
            not isinstance(m["signal"], str)
            or len(m["signal"]) > 256
            or not VALID_SIGNAL_EXPRESSION.fullmatch(m["signal"].strip())
        ):
            raise EDAError(f"Invalid signal expression for measurement {mid}")
        if "signal" in m:
            m["signal"] = m["signal"].strip()
            if (
                re.sub(r"\s+", "", m["signal"]).casefold()
                not in re.sub(r"\s+", "", directive).casefold()
            ):
                raise EDAError(
                    f"Measurement {mid}.signal does not occur in its directive"
                )
        if "model_ref" in m:
            model_ref = _valid_name(
                m["model_ref"], f"measurement {mid} model reference"
            )
            model = models_by_id.get(model_ref.casefold())
            if model is None:
                raise EDAError(
                    f"Unknown model reference for measurement {mid}: {model_ref}"
                )
            m["model_ref"] = model["id"]
        for field in ("unit", "description"):
            if field in m and not isinstance(m[field], str):
                raise EDAError(f"{mid}.{field} must be a string")
        for bound in ("min", "max"):
            if bound in m and (
                not isinstance(m[bound], (int, float))
                or isinstance(m[bound], bool)
                or not math.isfinite(m[bound])
            ):
                raise EDAError(f"{mid}.{bound} must be finite number")
        if (
            m.get("min") is not None
            and m.get("max") is not None
            and m["min"] > m["max"]
        ):
            raise EDAError(f"{mid}: min exceeds max")
    waveforms = _normalize_waveforms(data.get("waveforms", []), analyses)
    data["_spec_path"] = str(path)
    data["_netlist_path"] = str(netlist_path)
    data["scenarios"] = scenarios
    data["_analyses"] = analyses
    data["_waveforms"] = waveforms
    data["_models"] = {key: value for key, value in models_by_id.items()}
    data["_model_library"] = model_library_info
    data["_untested_conditions"] = [item.strip() for item in untested_conditions]
    data["models"] = models
    return data


def render_deck(
    template: str,
    params: dict[str, str],
    analyses: list[str] | list[dict[str, str]],
    measurements: list[dict[str, Any]],
    waveforms: list[dict[str, Any]] | None = None,
    waveform_paths: dict[str, Path | PurePosixPath] | None = None,
    waveform_base_dir: Path | None = None,
    *,
    container_paths: bool = False,
) -> str:
    if re.search(r"^\s*\.control\b", template, re.I | re.M):
        raise EDAError(
            "Input netlist must not contain .control sections; runner supplies its own"
        )
    # Disallow the .end directive in the middle. Original .end at EOF is removed.
    lines = template.rstrip().splitlines()
    if lines and re.fullmatch(r"\s*\.end\s*", lines[-1], re.I):
        lines.pop()
    if any(re.fullmatch(r"\s*\.end\s*", x, re.I) for x in lines):
        raise EDAError("Input netlist contains .end before the end of the file")

    def repl(match: re.Match[str]) -> str:
        key = match.group(1)
        if key not in params:
            raise EDAError(f"Unresolved parameter {{{{{key}}}}}")
        return params[key]

    base = PLACEHOLDER.sub(repl, "\n".join(lines))
    if "{{" in base or "}}" in base:
        raise EDAError("Unresolved or malformed template placeholder")
    normalized_analyses = _normalize_analyses(analyses)
    analysis_by_id = {item["id"].casefold(): item for item in normalized_analyses}
    command_by_analysis: dict[str, list[dict[str, Any]]] = {}
    for m in measurements:
        analysis_id = m.get("analysis")
        if analysis_id is None:
            kind = m["directive"].split()[1].casefold()
            candidates = [item for item in normalized_analyses if item["kind"] == kind]
            if len(candidates) != 1:
                raise EDAError(
                    f"Measurement {m.get('id', '?')} must name one of its analyses"
                )
            analysis_id = candidates[0]["id"]
        analysis = analysis_by_id.get(analysis_id.casefold())
        if analysis is None or analysis["kind"] != m["directive"].split()[1].casefold():
            raise EDAError(
                f"Measurement {m.get('id', '?')} uses an analysis not present in analyses"
            )
        command_by_analysis.setdefault(analysis["id"].casefold(), []).append(m)
    waveform_by_analysis: dict[str, list[dict[str, Any]]] = {}
    for waveform in waveforms or []:
        analysis_id = waveform["analysis"].casefold()
        if analysis_id not in analysis_by_id:
            raise EDAError(
                f"Waveform {waveform.get('id', '?')} uses an analysis not present in analyses"
            )
        if waveform_paths is None or waveform["id"] not in waveform_paths:
            raise EDAError(f"Missing output path for waveform {waveform['id']}")
        waveform_by_analysis.setdefault(analysis_id, []).append(waveform)
    current_vectors = any(
        re.search(r"(?i)\bi\s*\(|@[A-Za-z][A-Za-z0-9_]*\[i\]", item["directive"])
        for item in measurements
    ) or any(
        re.search(r"(?i)\bi\s*\(|@[A-Za-z][A-Za-z0-9_]*\[i\]", signal)
        for waveform in (waveforms or [])
        for signal in waveform["signals"]
    )
    if current_vectors and not re.search(
        r"(?mi)^\s*\.options\s+[^\r\n]*\bsavecurrents\b", base
    ):
        base += "\n.options savecurrents"
    ordered: list[str] = [".control", "set noaskquit"]
    if waveforms:
        ordered.extend(["set wr_singlescale", "set wr_vecnames", "option numdgt=15"])
    for analysis in normalized_analyses:
        ordered.append(analysis["command"])
        for measurement in command_by_analysis.get(analysis["id"].casefold(), []):
            pre_commands, directive = _materialize_measurement(measurement)
            ordered.extend(pre_commands)
            ordered.append(directive)
        for waveform in waveform_by_analysis.get(analysis["id"].casefold(), []):
            target_path = waveform_paths[waveform["id"]]
            if container_paths:
                path = target_path.as_posix()
            else:
                target_path = Path(target_path).resolve()
                try:
                    path = Path(
                        os.path.relpath(
                            target_path, (waveform_base_dir or Path.cwd()).resolve()
                        )
                    ).as_posix()
                except ValueError:
                    path = str(target_path)
            if not re.fullmatch(r"[A-Za-z0-9_./:\\-]+", path):
                raise EDAError(f"Unsafe waveform output path for {waveform['id']}")
            signal_list = " ".join(
                _ngspice_vector_expression(signal) for signal in waveform["signals"]
            )
            ordered.append(f"wrdata {path} {signal_list}")
    ordered.extend([".endc", ".end", ""])
    return base + "\n" + "\n".join(ordered)


def extract_measurements(log_text: str) -> dict[str, float]:
    return {
        key: record["value"]
        for key, record in extract_measurement_records(log_text).items()
    }


def extract_measurement_records(log_text: str) -> dict[str, dict[str, float]]:
    result: dict[str, dict[str, float]] = {}
    for line in log_text.splitlines():
        match = MEAS_PATTERN.match(line)
        if not match:
            continue
        record = {"value": float(match.group(2))}
        at_match = re.search(
            r"\bat\s*=\s*([+\-]?(?:\d+\.?\d*|\.\d+)(?:[Ee][+\-]?\d+)?)", line, re.I
        )
        if at_match:
            at_time = float(at_match.group(1))
            if math.isfinite(at_time):
                record["time_s"] = at_time
        result[match.group(1).lower()] = record
    return result


def _convert_waveform(
    raw_path: Path, csv_path: Path, signals: list[str]
) -> dict[str, Any]:
    if not raw_path.is_file():
        raise EDAError(f"Waveform export is missing: {raw_path}")
    text = raw_path.read_text(encoding="utf-8", errors="replace")
    lines = [line.split() for line in text.splitlines() if line.strip()]
    if len(lines) < 3 or not lines[0] or lines[0][0].casefold() != "time":
        raise EDAError(f"Invalid waveform header or empty data: {raw_path}")
    header = lines[0]
    lookup: dict[str, int] = {}
    for index, name in enumerate(header):
        key = name.casefold()
        if key in lookup:
            raise EDAError(f"Duplicate waveform column {name!r}: {raw_path}")
        lookup[key] = index
    selected = []
    for signal in signals:
        candidates = [signal.casefold(), _ngspice_vector_expression(signal).casefold()]
        current_match = re.fullmatch(r"(?i)i\(\s*([A-Za-z][A-Za-z0-9_]*)\s*\)", signal)
        if current_match:
            candidates.append(f"@{current_match.group(1).lower()}[i]")
        differential_match = re.fullmatch(
            r"(?i)v\(\s*([A-Za-z][A-Za-z0-9_]*)\s*,\s*([A-Za-z][A-Za-z0-9_]*)\s*\)",
            signal,
        )
        if differential_match:
            candidates.append(
                f"v({differential_match.group(1)})-v({differential_match.group(2)})"
            )
        index = next((lookup[key] for key in candidates if key in lookup), None)
        if index is None:
            raise EDAError(f"Waveform column missing for {signal}: {raw_path}")
        selected.append((signal, index))
    rows: list[list[float]] = []
    previous_time = -math.inf
    sample_intervals = []
    for line_number, fields in enumerate(lines[1:], start=2):
        if len(fields) != len(header):
            raise EDAError(
                f"Waveform row {line_number} has {len(fields)} columns, expected {len(header)}"
            )
        try:
            row = [float(value) for value in fields]
        except ValueError as exc:
            raise EDAError(
                f"Waveform row {line_number} contains a nonnumeric value"
            ) from exc
        if any(not math.isfinite(value) for value in row):
            raise EDAError(f"Waveform row {line_number} contains a non-finite value")
        if row[0] <= previous_time:
            raise EDAError(
                f"Waveform time values must be strictly increasing (row {line_number})"
            )
        if math.isfinite(previous_time):
            sample_intervals.append(row[0] - previous_time)
        previous_time = row[0]
        rows.append(row)
    if len(rows) < 2:
        raise EDAError(f"Waveform requires at least two samples: {raw_path}")
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    columns = ["time_s", *[signal for signal, _ in selected]]
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(columns)
        for row in rows:
            writer.writerow([row[0], *[row[index] for _, index in selected]])
    csv_bytes = csv_path.read_bytes()
    raw_bytes = raw_path.read_bytes()
    return {
        "samples": len(rows),
        "columns": columns,
        "time_start_s": rows[0][0],
        "time_end_s": rows[-1][0],
        "sample_interval_min_s": min(sample_intervals),
        "sample_interval_median_s": statistics.median(sample_intervals),
        "sample_interval_max_s": max(sample_intervals),
        "raw_sha256": hashlib.sha256(raw_bytes).hexdigest(),
        "csv_sha256": hashlib.sha256(csv_bytes).hexdigest(),
    }


def evaluate_measurements(
    measure_specs: list[dict[str, Any]], values: dict[str, float]
) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    for m in measure_specs:
        mid = m["id"]
        value = values.get(mid.lower())
        reason = ""
        if value is None or not math.isfinite(value):
            reason = "missing or non-finite measurement"
        elif m.get("min") is not None and value < m["min"]:
            reason = f"below minimum {m['min']}"
        elif m.get("max") is not None and value > m["max"]:
            reason = f"above maximum {m['max']}"
        checks.append(
            {
                "id": mid,
                "value": value if value is not None and math.isfinite(value) else None,
                "unit": m.get("unit", ""),
                "min": m.get("min"),
                "max": m.get("max"),
                "passed": not reason,
                "reason": reason,
                "description": m.get("description", ""),
                "analysis": m.get("analysis"),
                "signal": m.get("signal"),
                "model_ref": m.get("model_ref"),
            }
        )
    return checks


def executable_path(program: str | None) -> str | None:
    if not program:
        return None
    resolved = shutil.which(program) or (
        str(Path(program).expanduser().resolve())
        if Path(program).expanduser().is_file()
        else None
    )
    if resolved and sys.platform == "win32":
        path = Path(resolved)
        if path.name.casefold() == "ngspice.exe":
            console_binary = path.with_name("ngspice_con.exe")
            if console_binary.is_file():
                return str(console_binary)
    return resolved


def ngspice_version(program: str | Sequence[str]) -> str:
    try:
        command = [program] if isinstance(program, str) else list(program)
        out = subprocess.run(
            [*command, "-v"], capture_output=True, text=True, timeout=8
        )
        return (out.stdout + out.stderr).strip()[:1200]
    except (OSError, subprocess.TimeoutExpired):
        return "unknown"


def _validate_container_options(
    isolation: str,
    image: str,
    *,
    memory_limit_mb: int = 1024,
    cpu_limit: float = 1.0,
    pids_limit: int = 64,
    storage_limit_mb: int = 512,
    input_limit_mb: int = 128,
) -> dict[str, Any]:
    if isolation not in {"host", "docker"}:
        raise EDAError("isolation must be 'host' or 'docker'")
    if isolation == "docker" and (
        not isinstance(image, str)
        or not re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9._/:~-]*@sha256:[0-9a-fA-F]{64}", image
        )
    ):
        raise EDAError("container image must be pinned by a sha256 digest")
    for name, value, minimum, maximum in (
        ("memory_limit_mb", memory_limit_mb, 128, 8192),
        ("pids_limit", pids_limit, 16, 4096),
        ("storage_limit_mb", storage_limit_mb, 16, 4096),
        ("input_limit_mb", input_limit_mb, 4, 1024),
    ):
        if (
            isinstance(value, bool)
            or not isinstance(value, int)
            or not minimum <= value <= maximum
        ):
            raise EDAError(f"{name} must be an integer between {minimum} and {maximum}")
    if (
        isinstance(cpu_limit, bool)
        or not isinstance(cpu_limit, (int, float))
        or not math.isfinite(cpu_limit)
        or not 0.1 <= cpu_limit <= 32.0
    ):
        raise EDAError("cpu_limit must be a finite number between 0.1 and 32")
    return {
        "isolation": isolation,
        "image": image,
        "memory_limit_mb": memory_limit_mb,
        "cpu_limit": float(cpu_limit),
        "pids_limit": pids_limit,
        "storage_limit_mb": storage_limit_mb,
        "input_limit_mb": input_limit_mb,
    }


def _docker_security_flags(
    memory_limit_mb: int, cpu_limit: float, pids_limit: int
) -> list[str]:
    return [
        "--network=none",
        "--read-only",
        "--user=65534:65534",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges:true",
        f"--pids-limit={pids_limit}",
        f"--memory={memory_limit_mb}m",
        f"--cpus={cpu_limit:g}",
    ]


def _include_reference(line: str) -> tuple[re.Match[str], str, str] | None:
    line_without_newline = line.rstrip("\r\n")
    match = SPICE_INCLUDE_LINE.match(line_without_newline)
    if not match:
        return None
    directive_line = line_without_newline.split("$", 1)[0]
    directive_match = SPICE_INCLUDE_LINE.match(directive_line)
    if not directive_match:
        return None
    # A one-argument .lib starts an internal library section; only the
    # two-argument form names an external file and section.
    if (
        directive_match.group("directive").casefold() == "lib"
        and not directive_match.group("tail").strip()
    ):
        return None
    token = match.group("token")
    if token.startswith(('"', "'")):
        quote, reference = token[0], token[1:-1]
    else:
        quote, reference = "", token
    return match, quote, reference


def _resolve_container_include(
    reference: str, netlist_dir: Path, project_root: Path
) -> Path:
    normalized = reference.replace("\\", "/")
    if (
        not normalized
        or normalized.startswith("/")
        or re.match(r"^[A-Za-z]:", normalized)
        or any(char in normalized for char in ("$", "{", "}", "*", "?"))
    ):
        raise EDAError(
            f"Container isolation requires a static relative include path: {reference!r}"
        )
    try:
        resolved = (netlist_dir / Path(*normalized.split("/"))).resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise EDAError(f"Container include is unavailable: {reference!r}") from exc
    if not resolved.is_file():
        raise EDAError(f"Container include is not a file: {reference!r}")
    if not resolved.is_relative_to(project_root):
        raise EDAError(
            f"Container include must resolve within the project root: {reference!r}"
        )
    return resolved


def _rewrite_container_include_paths(
    content: str, netlist_dir: Path, project_root: Path
) -> tuple[str, list[Path]]:
    output_lines: list[str] = []
    targets: list[Path] = []
    for line in content.splitlines(keepends=True):
        reference_info = _include_reference(line)
        if not reference_info:
            output_lines.append(line)
            continue
        match, quote, reference = reference_info
        target = _resolve_container_include(reference, netlist_dir, project_root)
        targets.append(target)
        relative = Path(os.path.relpath(target, netlist_dir)).as_posix()
        newline = (
            "\r\n" if line.endswith("\r\n") else "\n" if line.endswith("\n") else ""
        )
        output_lines.append(
            match.group("prefix")
            + (quote + relative + quote if quote else relative)
            + match.group("tail")
            + newline
        )
    return "".join(output_lines), targets


def _collect_container_inputs(
    netlist_path: Path,
    project_root: Path,
    stage_root: Path,
    *,
    input_limit_mb: int = 128,
) -> int:
    netlist_path = netlist_path.resolve(strict=True)
    project_root = project_root.resolve(strict=True)
    if not netlist_path.is_relative_to(project_root):
        raise EDAError("Container netlist must remain within the project root")
    pending = [netlist_path]
    staged: dict[Path, bytes] = {}
    total_bytes = 0
    limit_bytes = input_limit_mb * 1024 * 1024
    while pending:
        source = pending.pop()
        if source in staged:
            continue
        if len(staged) >= MAX_CONTAINER_INPUT_FILES:
            raise EDAError(
                f"Container input closure exceeds {MAX_CONTAINER_INPUT_FILES} files"
            )
        raw = _read_limited_regular_file(
            source,
            MAX_CONTAINER_SINGLE_INPUT_BYTES,
            "Container input",
            limit_description="32 MiB per-file limit",
        )
        total_bytes += len(raw)
        if total_bytes > limit_bytes:
            raise EDAError(
                f"Container input closure exceeds the {input_limit_mb} MiB input limit"
            )
        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise EDAError(f"Container input must be UTF-8 text: {source}") from exc
        rewritten, include_targets = _rewrite_container_include_paths(
            content, netlist_path.parent, project_root
        )
        pending.extend(include_targets)
        staged[source] = rewritten.encode("utf-8")
    for source, content in staged.items():
        destination = stage_root / source.relative_to(project_root)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
    return len(staged)


def _docker_call(
    docker: str,
    args: list[str],
    *,
    timeout: float = 10,
    binary: bool = False,
    max_output_bytes: int | None = None,
) -> subprocess.CompletedProcess:
    command = [docker, *args]
    if max_output_bytes is None:
        max_output_bytes = MAX_DOCKER_STDOUT_BYTES
    if max_output_bytes < 0:
        raise ValueError("max_output_bytes must not be negative")
    try:
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except OSError:
        raise
    stdout = bytearray()
    stderr = bytearray()
    exceeded = threading.Event()

    def drain(stream: Any, destination: bytearray, limit: int) -> None:
        try:
            while True:
                chunk = stream.read(65536)
                if not chunk:
                    return
                room = max(0, limit - len(destination))
                if room:
                    destination.extend(chunk[:room])
                if len(chunk) > room:
                    exceeded.set()
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass
        finally:
            stream.close()

    stdout_thread = threading.Thread(
        target=drain, args=(process.stdout, stdout, max_output_bytes), daemon=True
    )
    stderr_thread = threading.Thread(
        target=drain, args=(process.stderr, stderr, MAX_DOCKER_STDERR_BYTES), daemon=True
    )
    stdout_thread.start()
    stderr_thread.start()
    timed_out = False
    timeout_error: subprocess.TimeoutExpired | None = None
    try:
        returncode = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        timeout_error = exc
        process.kill()
        returncode = process.wait()
    stdout_thread.join()
    stderr_thread.join()
    if timed_out:
        raise subprocess.TimeoutExpired(
            command,
            timeout,
            output=bytes(stdout),
            stderr=bytes(stderr),
        ) from timeout_error
    if exceeded.is_set():
        returncode = 125
        stderr.extend(
            f"Docker command exceeded the host output limit ({max_output_bytes} stdout / {MAX_DOCKER_STDERR_BYTES} stderr bytes)".encode()
        )
    raw_stdout, raw_stderr = bytes(stdout), bytes(stderr)
    if binary:
        result_stdout, result_stderr = raw_stdout, raw_stderr
    else:
        result_stdout = raw_stdout.decode(errors="replace")
        result_stderr = raw_stderr.decode(errors="replace")
    return subprocess.CompletedProcess(command, returncode, result_stdout, result_stderr)


_DOCKER_READ_FILE_SCRIPT = (
    'path=$1; count=$2; '
    'if [ -L "$path" ] || { [ -e "$path" ] && [ ! -f "$path" ]; }; then '
    'echo "refusing non-regular container output" >&2; exit 74; fi; '
    'if [ ! -e "$path" ]; then exit 75; fi; '
    'if [ ! -f "$path" ]; then '
    'echo "refusing non-regular container output" >&2; exit 74; fi; '
    'exec head -c "$count" "$path"'
)


def _docker_read_file(
    docker: str,
    container_name: str,
    container_path: str,
    max_bytes: int,
    *,
    timeout: float = 20,
) -> bytes | None:
    if max_bytes < 0:
        raise ValueError("max_bytes must not be negative")
    result = _docker_call(
        docker,
        [
            "exec",
            container_name,
            "/bin/sh",
            "-c",
            _DOCKER_READ_FILE_SCRIPT,
            "edastack-read-file",
            container_path,
            str(max_bytes + 1),
        ],
        timeout=timeout,
        binary=True,
        max_output_bytes=max_bytes + 1,
    )
    stderr_bytes = (
        result.stderr
        if isinstance(result.stderr, bytes)
        else str(result.stderr).encode()
    )
    if result.returncode == 75:
        return None
    if result.returncode == 74:
        raise EDAError(f"Container output must be a regular file, not a symlink or special file: {container_path}")
    if result.returncode == 125 and b"host output limit" in stderr_bytes:
        raise EDAError(f"Container output exceeded the host output limit: {container_path}")
    if result.returncode:
        detail = stderr_bytes.decode(errors="replace").strip()
        raise EDAError(f"Could not safely read container output {container_path}: {detail}")
    if len(result.stdout) > max_bytes:
        raise EDAError(f"Container output exceeds the {max_bytes}-byte limit: {container_path}")
    return result.stdout


def _validate_docker_container_inspect(
    inspected: dict[str, Any],
    options: dict[str, Any],
    project_stage: Path,
    scenario_dir: Path,
) -> None:
    host = inspected.get("HostConfig", {})
    required_options = {
        "digest-pinned image": inspected.get("Config", {}).get("Image")
        == options["image"],
        "network": host.get("NetworkMode") == "none",
        "read-only root filesystem": host.get("ReadonlyRootfs") is True,
        "unprivileged user": inspected.get("Config", {}).get("User") == "65534:65534",
        "capability drop": "ALL" in host.get("CapDrop", []),
        "no-new-privileges": any(
            item == "no-new-privileges:true" for item in host.get("SecurityOpt", [])
        ),
        "disabled Docker daemon logging": host.get("LogConfig", {}).get("Type")
        == "none",
        "memory limit": host.get("Memory") == options["memory_limit_mb"] * 1024 * 1024,
        "CPU limit": host.get("NanoCpus") == int(options["cpu_limit"] * 1_000_000_000),
        "process limit": host.get("PidsLimit") == options["pids_limit"],
    }
    mounts = {
        mount.get("Destination"): mount
        for mount in inspected.get("Mounts", [])
        if mount.get("Destination") in {"/project", "/input"}
    }
    bind_targets = {
        mount.get("Destination")
        for mount in inspected.get("Mounts", [])
        if mount.get("Type") == "bind"
    }
    required_options["minimal bind mounts"] = bind_targets == {"/project", "/input"}
    for target, source in (("/project", project_stage), ("/input", scenario_dir)):
        mount = mounts.get(target)
        required_options[f"read-only {target} mount"] = bool(
            mount
            and (mount.get("ReadOnly") is True or mount.get("RW") is False)
            and os.path.normcase(os.path.normpath(mount.get("Source", "")))
            == os.path.normcase(os.path.normpath(str(source)))
        )
    tmpfs = host.get("Tmpfs", {})
    required_options["bounded output tmpfs"] = (
        f"size={options['storage_limit_mb']}m" in tmpfs.get("/work", "")
        and "noexec" in tmpfs.get("/work", "")
        and "nosuid" in tmpfs.get("/work", "")
        and "nodev" in tmpfs.get("/work", "")
    )
    required_options["bounded temporary tmpfs"] = (
        "size=64m" in tmpfs.get("/tmp", "")
        and "noexec" in tmpfs.get("/tmp", "")
        and "nosuid" in tmpfs.get("/tmp", "")
        and "nodev" in tmpfs.get("/tmp", "")
    )
    failed = [label for label, passed in required_options.items() if not passed]
    if failed:
        raise EDAError(
            "Docker scenario container did not retain required isolation settings: "
            + ", ".join(failed)
        )


def _docker_version(docker: str, options: dict[str, Any]) -> str:
    flags = _docker_security_flags(
        options["memory_limit_mb"], options["cpu_limit"], options["pids_limit"]
    )
    command = [
        "run",
        "--pull=never",
        "--rm",
        *flags,
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
        "--entrypoint",
        "/usr/bin/ngspice",
        options["image"],
        "-v",
    ]
    try:
        result = _docker_call(docker, command, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise EDAError(f"Docker isolation preflight failed: {exc}") from exc
    version = (result.stdout + result.stderr).strip()[:1200]
    if result.returncode:
        detail = version or f"docker exited with code {result.returncode}"
        raise EDAError(f"Docker could not run the pinned ngspice image: {detail}")
    return version or "unknown"


def _docker_run_scenario(
    docker: str,
    options: dict[str, Any],
    project_stage: Path,
    project_workdir: str,
    scenario_dir: Path,
    log_file: Path,
    waveform_outputs: dict[str, Path],
    timeout: int,
) -> tuple[str, str, int, bool]:
    for path in (project_stage, scenario_dir):
        if "," in str(path):
            raise EDAError("Docker bind-mount paths may not contain commas")
    name = f"edastack-{uuid.uuid4().hex}"
    flags = _docker_security_flags(
        options["memory_limit_mb"], options["cpu_limit"], options["pids_limit"]
    )
    create_args = [
        "create",
        "--pull=never",
        "--name",
        name,
        *flags,
        "--log-driver=none",
        "--mount",
        f"type=bind,source={project_stage},target=/project,readonly",
        "--mount",
        f"type=bind,source={scenario_dir},target=/input,readonly",
        "--tmpfs",
        f"/work:rw,noexec,nosuid,nodev,size={options['storage_limit_mb']}m,mode=1777",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
        "--workdir",
        project_workdir,
        "--entrypoint",
        "/bin/sh",
        options["image"],
        "-c",
        DOCKER_COMMAND,
    ]
    created = False
    stdout = ""
    stderr = ""
    return_code = 125
    timed_out = False
    try:
        create = _docker_call(docker, create_args, timeout=20)
        if create.returncode:
            raise EDAError(
                "Docker could not create an isolated scenario container: "
                + (create.stderr or create.stdout).strip()
            )
        created = True
        inspected = _docker_call(
            docker, ["inspect", "--format", "{{json .}}", name], timeout=10
        )
        if inspected.returncode:
            raise EDAError("Docker could not inspect the isolated scenario container")
        try:
            inspect_data = json.loads(inspected.stdout)
        except json.JSONDecodeError as exc:
            raise EDAError("Docker returned invalid container inspection data") from exc
        _validate_docker_container_inspect(
            inspect_data, options, project_stage, scenario_dir
        )
        started = _docker_call(docker, ["start", name], timeout=20)
        if started.returncode:
            raise EDAError(
                "Docker could not start an isolated scenario container: "
                + (started.stderr or started.stdout).strip()
            )
        deadline = time.monotonic() + timeout
        while True:
            status = _docker_read_file(
                docker, name, "/work/exit-code", MAX_CONTAINER_STATUS_BYTES, timeout=5
            )
            if status is not None:
                try:
                    return_code = int(status.decode("ascii").strip())
                    if not 0 <= return_code <= 255:
                        raise ValueError("exit code must be between 0 and 255")
                except (UnicodeDecodeError, ValueError) as exc:
                    raise EDAError(
                        "Isolated simulator returned an invalid exit code"
                    ) from exc
                break
            inspect = _docker_call(
                docker,
                ["inspect", "--format", "{{.State.Running}}|{{.State.ExitCode}}", name],
                timeout=5,
            )
            if inspect.returncode:
                raise EDAError("Docker lost the isolated simulator container")
            running, _, exited_code = inspect.stdout.strip().partition("|")
            if running.casefold() != "true":
                return_code = int(exited_code or 125)
                stderr = "Isolated simulator container stopped before writing its exit status"
                break
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                timed_out = True
                return_code = -1
                break
            time.sleep(min(0.2, remaining))
        for container_path, host_path, output_limit in [
            (
                "/work/ngspice.log",
                log_file,
                min(MAX_CONTAINER_LOG_BYTES, options["storage_limit_mb"] * 1024 * 1024),
            ),
            *(
                (
                    f"/work/{key}.dat",
                    path,
                    min(
                        MAX_CONTAINER_WAVEFORM_BYTES,
                        options["storage_limit_mb"] * 1024 * 1024,
                    ),
                )
                for key, path in waveform_outputs.items()
            ),
        ]:
            output = _docker_read_file(
                docker, name, container_path, output_limit, timeout=20
            )
            if output is not None:
                host_path.write_bytes(output)
    except (OSError, subprocess.TimeoutExpired) as exc:
        stderr = f"Docker isolation runtime failed: {exc}"
        return_code = 125
    except EDAError as exc:
        stderr = str(exc)
        return_code = 125
    finally:
        if created:
            removed = _docker_call(docker, ["rm", "--force", name], timeout=20)
            if removed.returncode:
                stderr = "\n".join(
                    part
                    for part in (
                        stderr,
                        "Docker failed to remove the isolated scenario container: "
                        + (removed.stderr or removed.stdout).strip(),
                    )
                    if part
                )
                return_code = 125
    return stdout, stderr, return_code, timed_out


def run_project(
    spec_path: Path,
    out_dir: Path,
    binary: str | Sequence[str] | None = None,
    timeout: int = 90,
    *,
    isolation: str = "host",
    docker_image: str = DEFAULT_DOCKER_IMAGE,
    docker_binary: str | None = None,
    memory_limit_mb: int = 1024,
    cpu_limit: float = 1.0,
    pids_limit: int = 64,
    storage_limit_mb: int = 512,
    input_limit_mb: int = 128,
) -> dict[str, Any]:
    spec = load_spec(spec_path)
    container_options = _validate_container_options(
        isolation,
        docker_image,
        memory_limit_mb=memory_limit_mb,
        cpu_limit=cpu_limit,
        pids_limit=pids_limit,
        storage_limit_mb=storage_limit_mb,
        input_limit_mb=input_limit_mb,
    )
    docker = None
    command: list[str] | None = None
    if isolation == "docker":
        requested_docker = docker_binary or os.environ.get("DOCKER_EXE") or "docker"
        docker = executable_path(requested_docker)
        if not docker:
            raise EDAError(
                f"Docker executable not found: {requested_docker!r}; install Docker and pull {docker_image!r}"
            )
        ver = _docker_version(docker, container_options)
    else:
        if binary is None:
            binary = os.environ.get("NGSPICE_EXE") or "ngspice"
        if isinstance(binary, str):
            requested_binary, command_args = binary, []
        elif (
            isinstance(binary, Sequence)
            and binary
            and all(isinstance(arg, str) and arg for arg in binary)
        ):
            requested_binary, command_args = binary[0], list(binary[1:])
        else:
            raise EDAError(
                "ngspice command must be a path or a nonempty sequence of arguments"
            )
        actual_binary = executable_path(requested_binary)
        if not actual_binary:
            raise EDAError(
                f"ngspice executable not found: {requested_binary!r}. Install ngspice and use --ngspice PATH if necessary."
            )
        command = [actual_binary, *command_args]
        ver = ngspice_version(command)
    timeout = int(timeout)
    if timeout < 1 or timeout > 600:
        raise EDAError("timeout must be between 1 and 600 seconds")
    output_root = out_dir.expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    run_id = uuid.uuid4().hex
    run_started_at = (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )
    run_directory = output_root / "runs" / run_id
    run_directory.mkdir(parents=True)
    netlist_path = Path(spec["_netlist_path"])
    template = (
        _read_limited_text(
            netlist_path, MAX_CONTAINER_SINGLE_INPUT_BYTES, "Container netlist"
        )
        if isolation == "docker"
        else netlist_path.read_text(encoding="utf-8")
    )
    results: list[dict[str, Any]] = []
    project_root = _project_root_for_spec(Path(spec["_spec_path"]))
    project_stage = run_directory / "sandbox-project"
    project_workdir = "/project"
    if isolation == "docker":
        _collect_container_inputs(
            netlist_path,
            project_root,
            project_stage,
            input_limit_mb=container_options["input_limit_mb"],
        )
        relative_workdir = netlist_path.parent.relative_to(project_root)
        if relative_workdir.parts:
            project_workdir += "/" + relative_workdir.as_posix()
    execution = {
        "isolation": isolation,
        "container_image": container_options["image"]
        if isolation == "docker"
        else None,
        "limits": (
            {
                "memory_limit_mb": container_options["memory_limit_mb"],
                "cpu_limit": container_options["cpu_limit"],
                "pids_limit": container_options["pids_limit"],
                "storage_limit_mb": container_options["storage_limit_mb"],
                "input_limit_mb": container_options["input_limit_mb"],
                "timeout_seconds_per_scenario": timeout,
            }
            if isolation == "docker"
            else None
        ),
    }
    for scenario in spec["scenarios"]:
        name = scenario["name"]
        directory = run_directory / name
        directory.mkdir(parents=True, exist_ok=True)
        params = {**spec.get("parameters", {}), **scenario.get("set", {})}
        waveform_paths: dict[str, Path | PurePosixPath] = {
            item["id"]: (
                PurePosixPath("/work") / f"{item['id']}.dat"
                if isolation == "docker"
                else netlist_path.parent
                / f".edastack_wave_{run_id}_{name}_{item['id']}.dat"
            )
            for item in spec["_waveforms"]
        }
        waveform_csv_paths = {
            item["id"]: directory / f"{item['id']}.csv" for item in spec["_waveforms"]
        }
        artifact_waveform_paths = {
            item["id"]: directory / f"{item['id']}.dat" for item in spec["_waveforms"]
        }
        if isolation == "host":
            for path in waveform_paths.values():
                Path(path).unlink(missing_ok=True)
        deck = render_deck(
            template,
            params,
            spec["_analyses"],
            spec["measurements"],
            spec["_waveforms"],
            waveform_paths,
            netlist_path.parent,
            container_paths=isolation == "docker",
        )
        if isolation == "docker":
            deck, _ = _rewrite_container_include_paths(
                deck, netlist_path.parent, project_root
            )
        deck_file = directory / "input.cir"
        log_file = directory / "ngspice.log"
        deck_bytes = deck.encode("utf-8")
        deck_file.write_bytes(deck_bytes)
        # Never reuse a stale log from a prior run if ngspice exits before writing.
        log_file.unlink(missing_ok=True)
        # log path is absolute; no '-r' flag, as it disables .meas access in batch.
        started = time.monotonic()
        try:
            if isolation == "docker":
                stdout, stderr, rc, timed_out = _docker_run_scenario(
                    docker,
                    container_options,
                    project_stage,
                    project_workdir,
                    directory,
                    log_file,
                    artifact_waveform_paths,
                    timeout,
                )
            else:
                cp = subprocess.run(
                    [*command, "-b", "-o", str(log_file), str(deck_file)],
                    cwd=netlist_path.parent,
                    capture_output=True,
                    text=True,
                    timeout=timeout,
                    check=False,
                )
                stdout, stderr, rc, timed_out = (
                    cp.stdout,
                    cp.stderr,
                    cp.returncode,
                    False,
                )
            elapsed = round(time.monotonic() - started, 3)
        except subprocess.TimeoutExpired as exc:
            elapsed = round(time.monotonic() - started, 3)
            stdout = (
                (exc.stdout or b"").decode(errors="replace")
                if isinstance(exc.stdout, bytes)
                else (exc.stdout or "")
            )
            stderr = (
                (exc.stderr or b"").decode(errors="replace")
                if isinstance(exc.stderr, bytes)
                else (exc.stderr or "")
            )
            rc, timed_out = -1, True
        except EDAError as exc:
            elapsed = round(time.monotonic() - started, 3)
            stdout, stderr, rc, timed_out = "", str(exc), 125, False
        if isolation == "host":
            for waveform_id, stage_path in waveform_paths.items():
                if isinstance(stage_path, Path) and stage_path.is_file():
                    shutil.copyfile(stage_path, artifact_waveform_paths[waveform_id])
                    stage_path.unlink(missing_ok=True)
        if isolation == "docker" and log_file.exists():
            log = _read_limited_text(
                log_file, MAX_CONTAINER_LOG_BYTES, "Container simulator log"
            )
        else:
            log = (
                log_file.read_text(encoding="utf-8", errors="replace")
                if log_file.exists()
                else ""
            )
        combined = "\n".join((log, stdout, stderr))
        records = extract_measurement_records(combined)
        measured = {key: value["value"] for key, value in records.items()}
        checks = evaluate_measurements(spec["measurements"], measured)
        errors = []
        if timed_out:
            errors.append(f"ngspice exceeded timeout of {timeout}s")
        if rc != 0:
            errors.append(f"ngspice exited with code {rc}")
            if stderr.strip():
                errors.append(stderr.strip()[:1200])
        if re.search(r"(?mi)^\s*(?:error|fatal error)\s*:", combined):
            errors.append("ngspice reported an error; inspect ngspice.log")
        if any(
            "failed" in line.lower()
            for line in combined.splitlines()
            if re.search(r"(?i)measurement", line)
        ):
            errors.append("ngspice reported a failed measurement")
        models_by_id = spec["_models"]
        for check in checks:
            check["case"] = name
            check["parameters"] = params
            record = records.get(check["id"].casefold())
            if record and "time_s" in record:
                check["time_s"] = record["time_s"]
            model_ref = check.get("model_ref")
            if model_ref:
                check["model"] = models_by_id[model_ref.casefold()]
            directive = next(
                item["directive"]
                for item in spec["measurements"]
                if item["id"] == check["id"]
            )
            check["operator"] = directive.split()[3].upper()
        waveform_artifacts = []
        for waveform in spec["_waveforms"]:
            raw_path = artifact_waveform_paths[waveform["id"]]
            csv_path = waveform_csv_paths[waveform["id"]]
            try:
                summary = _convert_waveform(raw_path, csv_path, waveform["signals"])
                waveform_artifacts.append(
                    {
                        "id": waveform["id"],
                        "analysis": waveform["analysis"],
                        "signals": waveform["signals"],
                        "raw": str(raw_path),
                        "csv": str(csv_path),
                        **summary,
                    }
                )
            except EDAError as exc:
                errors.append(str(exc))
        solver_quality = _scenario_solver_quality(
            log, spec["_analyses"], waveform_artifacts
        )
        errors.extend(solver_quality["failures"])
        passed = not errors and all(x["passed"] for x in checks)
        results.append(
            {
                "scenario": name,
                "category": scenario["category"],
                "parameters": params,
                "status": "pass" if passed else "fail",
                "passed": passed,
                "checks": checks,
                "errors": errors,
                "returncode": rc,
                "timed_out": timed_out,
                "duration_s": elapsed,
                "deck_sha256": hashlib.sha256(deck_bytes).hexdigest(),
                "solver_quality": solver_quality,
                "artifacts": {
                    "netlist": str(deck_file),
                    "log": str(log_file),
                    "waveforms": waveform_artifacts,
                },
            }
        )
    category_names = {
        category: [
            scenario["scenario"]
            for scenario in results
            if scenario["category"] == category
        ]
        for category in sorted(SCENARIO_CATEGORIES)
    }
    coverage = {
        "category_counts": {
            category: len(names) for category, names in category_names.items() if names
        },
        "nominal_scenarios": category_names["nominal"],
        "tested_corners": category_names["corner"],
        "fault_scenarios": category_names["fault"],
        "statistical_samples": category_names["statistical_sample"],
        "statistical_sampling_performed": False,
        "global_worst_case_claim": False,
        "untested_conditions": spec["_untested_conditions"],
    }
    report = {
        "schema_version": 1,
        "project": spec["name"],
        "passed": all(r["passed"] for r in results),
        "run_id": run_id,
        "run_started_at_utc": run_started_at,
        "run_completed_at_utc": datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z"),
        "simulator": "ngspice",
        "simulator_version": ver,
        "execution": execution,
        "specification": spec["_spec_path"],
        "source_netlist": spec["_netlist_path"],
        "analyses": spec["_analyses"],
        "models": list(spec["_models"].values()),
        "model_library": spec.get("_model_library"),
        "coverage": coverage,
        "limitations": [
            "The deterministic scenarios cover only the listed points and do not establish a global worst case.",
            "The verifier does not generate statistical or Monte Carlo samples.",
            "Temperature, physical model fidelity, parasitics, and fault behavior are only represented when explicitly modeled and listed.",
            "Transient timestep checks require waveform exports; an absent export leaves that analysis unchecked.",
            "A clean solver log and passing measurements do not prove hardware safety or model validity.",
            *(
                [
                    "Docker isolation limits network access, filesystem visibility, CPU, memory, process count, temporary output size, and per-scenario runtime; the Docker daemon and host kernel remain trusted components.",
                ]
                if isolation == "docker"
                else []
            ),
        ],
        "sweep_strategy": "explicit_cartesian_grid"
        if spec.get("sweeps")
        else "listed_scenarios",
        "sweeps": spec.get("sweeps", []),
        "statistical_sampling": False,
        "scenarios": results,
        "disclaimer": "Simulation limits are only as reliable as device models, scenarios and simulator settings. Not hardware certification.",
    }
    write_reports(output_root, report)
    write_reports(run_directory, report)
    return report


def write_reports(root: Path, report: dict[str, Any]) -> None:
    (root / "report.json").write_text(
        json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )
    manifest = {
        "schema_version": 1,
        "run_id": report["run_id"],
        "run_started_at_utc": report["run_started_at_utc"],
        "run_completed_at_utc": report["run_completed_at_utc"],
        "simulator": report["simulator"],
        "simulator_version": report["simulator_version"],
        "execution": report.get("execution"),
        "specification": report["specification"],
        "source_netlist": report["source_netlist"],
        "sweep_strategy": report.get("sweep_strategy"),
        "sweeps": report.get("sweeps", []),
        "models": report.get("models", []),
        "model_library": report.get("model_library"),
        "coverage": report.get("coverage"),
        "limitations": report.get("limitations", []),
        "scenarios": [
            {
                "name": scenario["scenario"],
                "category": scenario["category"],
                "parameters": scenario["parameters"],
                "status": scenario["status"],
                "deck_sha256": scenario["deck_sha256"],
                "solver_quality": scenario["solver_quality"],
                "artifacts": scenario["artifacts"],
            }
            for scenario in report["scenarios"]
        ],
    }
    (root / "run_manifest.json").write_text(
        json.dumps(manifest, indent=2, allow_nan=False) + "\n", encoding="utf-8"
    )
    lines = [
        f"# {report['project']}: {'PASS' if report['passed'] else 'FAIL'}",
        "",
        f"Run ID: `{report['run_id']}`",
        "",
        f"Simulator: {report['simulator']}",
        "",
        f"Execution isolation: {report.get('execution', {}).get('isolation', 'host')}",
        "",
        f"Sweep strategy: {report.get('sweep_strategy', 'listed_scenarios')}",
        "",
        "## Scenario coverage",
        "",
        f"Nominal: {len(report['coverage']['nominal_scenarios'])}; tested corners: {len(report['coverage']['tested_corners'])}; faults: {len(report['coverage']['fault_scenarios'])}; listed statistical samples: {len(report['coverage']['statistical_samples'])}.",
        "Statistical sampling performed by this runner: no. Global worst-case claim: no.",
        "",
        "Untested conditions:",
        *[f"- {condition}" for condition in report["coverage"]["untested_conditions"]],
        "",
        "## Solver quality",
        "",
        *[
            f"- {scenario['scenario']}: {scenario['solver_quality']['status']}"
            + (
                f"; transient sampling {', '.join(item['analysis'] + '=' + item['status'] for item in scenario['solver_quality']['transient_sampling'])}"
                if scenario["solver_quality"]["transient_sampling"]
                else ""
            )
            for scenario in report["scenarios"]
        ],
        "",
        "Limitations:",
        *[f"- {limitation}" for limitation in report["limitations"]],
        "",
        "| Category | Case | Measure | Value | Unit | Limit | Analysis | Source model | Result |",
        "|---|---|---|---:|---|---|---|---|---|",
    ]
    with (root / "measurements.csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(
            [
                "category",
                "case",
                "measure",
                "analysis",
                "operator",
                "signal",
                "model_ref",
                "value",
                "unit",
                "min",
                "max",
                "time_s",
                "passed",
                "reason",
            ]
        )
        for scenario in report["scenarios"]:
            for m in scenario["checks"]:

                def val(v: Any) -> str:
                    return "" if v is None else str(v)

                limit = (
                    ", ".join(
                        part
                        for part in [
                            f"min {m['min']}" if m.get("min") is not None else "",
                            f"max {m['max']}" if m.get("max") is not None else "",
                        ]
                        if part
                    )
                    or "none"
                )
                model = m.get("model")
                source_model = (
                    f"{model['id']} ({model['component']}; {model['source']})"
                    if model
                    else ""
                )
                passed = m["passed"] and not scenario["errors"]
                lines.append(
                    f"| {scenario['category']} | {scenario['scenario']} | {m['id']} | {val(m['value'])} | {m['unit']} | "
                    f"{limit} | {val(m.get('analysis'))} | {source_model} | {'PASS' if passed else 'FAIL'} |"
                )
                writer.writerow(
                    [
                        scenario["category"],
                        scenario["scenario"],
                        m["id"],
                        val(m.get("analysis")),
                        val(m.get("operator")),
                        val(m.get("signal")),
                        val(m.get("model_ref")),
                        val(m["value"]),
                        m["unit"],
                        val(m["min"]),
                        val(m["max"]),
                        val(m.get("time_s")),
                        passed,
                        m["reason"],
                    ]
                )
            if scenario["errors"]:
                lines.extend(
                    [
                        "",
                        f"Errors in **{scenario['scenario']}**:",
                        *[f"- {e}" for e in scenario["errors"]],
                    ]
                )
    lines.extend(["", "## Interpretation warning", "", report["disclaimer"], ""])
    (root / "report.md").write_text("\n".join(lines), encoding="utf-8")

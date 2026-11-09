"""Structural JSON Schema checks for the committed example specs."""

import json
import unittest
from pathlib import Path

try:
    from jsonschema import Draft202012Validator
except ImportError:  # Schema tooling is an optional development dependency.
    Draft202012Validator = None

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "schemas" / "verification-spec.schema.json"
MODEL_SCHEMA_PATH = ROOT / "schemas" / "model-library.schema.json"
TSCIRCUIT_SCHEMA_PATH = ROOT / "schemas" / "tscircuit-project.schema.json"
PROJECT_FIXTURES_PATH = ROOT / "benchmarks" / "fixtures"


@unittest.skipUnless(Draft202012Validator is not None, "requires requirements-dev.txt")
class SpecSchemaTests(unittest.TestCase):
    def test_tscircuit_project_contract_schemas_are_valid_and_fixtures_match(self):
        schema_names = {
            "eda.project.json": TSCIRCUIT_SCHEMA_PATH,
            "requirements.json": ROOT / "schemas" / "requirements.schema.json",
            "parts.lock.json": ROOT / "schemas" / "parts-lock.schema.json",
            "pcb.constraints.json": ROOT / "schemas" / "pcb-constraints.schema.json",
        }
        validators = {}
        for filename, schema_path in schema_names.items():
            with self.subTest(schema=schema_path.name):
                schema = json.loads(schema_path.read_text(encoding="utf-8"))
                Draft202012Validator.check_schema(schema)
                validators[filename] = Draft202012Validator(schema)

        for fixture_path in sorted(path for path in PROJECT_FIXTURES_PATH.iterdir() if path.is_dir()):
            for filename, validator in validators.items():
                with self.subTest(fixture=fixture_path.name, metadata=filename):
                    value = json.loads((fixture_path / filename).read_text(encoding="utf-8"))
                    self.assertEqual(list(validator.iter_errors(value)), [])

    def test_schema_is_valid_and_examples_match(self):
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        Draft202012Validator.check_schema(schema)
        validator = Draft202012Validator(schema)
        for spec_path in sorted((ROOT / "examples").glob("*/spec.json")):
            with self.subTest(spec=spec_path.parent.name):
                spec = json.loads(spec_path.read_text(encoding="utf-8"))
                self.assertEqual(list(validator.iter_errors(spec)), [])

    def test_model_library_schema_and_checked_in_library_match(self):
        schema = json.loads(MODEL_SCHEMA_PATH.read_text(encoding="utf-8"))
        Draft202012Validator.check_schema(schema)
        validator = Draft202012Validator(schema)
        library = json.loads(
            (ROOT / "models" / "library.json").read_text(encoding="utf-8")
        )
        self.assertEqual(list(validator.iter_errors(library)), [])

    def test_checked_in_model_fixture_spec_matches_verification_schema(self):
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        validator = Draft202012Validator(schema)
        spec = json.loads(
            (ROOT / "models" / "fixtures" / "ideal_two_pin_spec.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(list(validator.iter_errors(spec)), [])


if __name__ == "__main__":
    unittest.main()

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


@unittest.skipUnless(Draft202012Validator is not None, "requires requirements-dev.txt")
class SpecSchemaTests(unittest.TestCase):
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

"""Model-library identity, checksum, and pin-map validation tests."""

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from edastack.core import EDAError, load_spec


class ModelLibraryTests(unittest.TestCase):
    def test_checksum_pinned_model_fixtures_disable_eol_conversion(self):
        root = Path(__file__).resolve().parents[1]
        rules = (root / ".gitattributes").read_text(encoding="utf-8").splitlines()
        for relative_path in (
            "models/fixtures/ideal_resistor_validation.cir",
            "models/fixtures/ideal_two_pin_fixture.cir",
            "models/fixtures/ideal_two_pin_resistor.lib",
        ):
            self.assertTrue(
                any(
                    rule.split()[:1] == [relative_path] and "-text" in rule.split()[1:]
                    for rule in rules
                ),
                f"Git must preserve bytes for checksum-pinned fixture {relative_path}",
            )

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.models = self.root / "models"
        self.models.mkdir()
        self.model_file = self.models / "fixture.lib"
        self.model_file.write_text(
            "* Local pin-order fixture; not a vendor model.\n"
            ".SUBCKT TESTRES P N\nR1 P N 1k\n.ENDS TESTRES\n"
        )
        self.validation_fixture = self.models / "fixture_validation.txt"
        self.validation_fixture.write_text("local 1k two-pin fixture\n")
        self.library = {
            "schema_version": 1,
            "library_version": "1.0.0",
            "models": [
                {
                    "id": "test_resistor",
                    "kind": "subcircuit",
                    "subckt_name": "TESTRES",
                    "file": "fixture.lib",
                    "sha256": self._sha256(self.model_file),
                    "pin_order": ["P", "N"],
                    "physical_pin_map": {"1": "P", "2": "N"},
                    "source": "Local validation fixture",
                    "version": "1.0.0",
                    "license": "MIT",
                    "manufacturer": None,
                    "part_number": None,
                    "operating_conditions": {
                        "temperature_C": {
                            "min": 27,
                            "max": 27,
                            "basis": "fixture only",
                        },
                        "voltage_V": {"min": -1, "max": 1, "basis": "fixture only"},
                        "assumptions": [
                            "Ideal 1 kohm resistor inside a two-pin subcircuit."
                        ],
                    },
                    "limitations": [
                        "Local electrical fixture; not vendor characterized."
                    ],
                    "validation_fixture": "fixture_validation.txt",
                    "validation_fixture_sha256": self._sha256(self.validation_fixture),
                }
            ],
        }
        self.library_path = self.models / "library.json"
        self._write_library()
        self.netlist_path = self.root / "test.cir"
        self.netlist_path.write_text(
            "Two-pin fixture test\n"
            '.include "models/fixture.lib"\n'
            "V1 P 0 1\nRLOAD N 0 1k\nXU1 P N TESTRES\n.end\n"
        )
        self.spec_path = self.root / "spec.json"
        self.spec = {
            "schema_version": 1,
            "name": "model_fixture",
            "netlist": "test.cir",
            "model_library": "models/library.json",
            "parameters": {},
            "scenarios": [{"name": "nominal", "set": {}}],
            "analyses": ["tran 1n 1u"],
            "measurements": [
                {
                    "id": "voltage",
                    "directive": "meas tran voltage FIND v(P) AT=1u",
                    "model_ref": "U1_model",
                }
            ],
            "models": [
                {
                    "id": "U1_model",
                    "component": "XU1",
                    "library_ref": "test_resistor",
                    "connections": {"1": "P", "2": "N"},
                }
            ],
        }
        self._write_spec()

    def _sha256(self, path):
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def _write_library(self):
        self.library_path.write_text(json.dumps(self.library))

    def _write_spec(self):
        self.spec_path.write_text(json.dumps(self.spec))

    def test_library_model_checksum_pin_map_and_provenance_are_loaded(self):
        spec = load_spec(self.spec_path)
        model = spec["_models"]["u1_model"]
        self.assertEqual(model["library_ref"], "test_resistor")
        self.assertEqual(model["pin_order"], ["P", "N"])
        self.assertEqual(model["connections"], {"1": "P", "2": "N"})
        self.assertEqual(model["sha256"], self._sha256(self.model_file))
        self.assertEqual(model["license"], "MIT")
        self.assertEqual(model["operating_conditions"]["temperature_C"]["min"], 27)

    def test_wrong_component_pin_map_is_rejected(self):
        self.spec["models"][0]["connections"] = {"1": "N", "2": "P"}
        self._write_spec()
        with self.assertRaisesRegex(EDAError, "pin map.*does not match"):
            load_spec(self.spec_path)

    def test_tampered_model_file_is_rejected(self):
        self.model_file.write_text(self.model_file.read_text() + "* changed\n")
        with self.assertRaisesRegex(EDAError, "SHA-256 mismatch"):
            load_spec(self.spec_path)

    def test_wrong_subcircuit_header_order_is_rejected(self):
        self.library["models"][0]["pin_order"] = ["N", "P"]
        self._write_library()
        with self.assertRaisesRegex(EDAError, "pin order.*does not match"):
            load_spec(self.spec_path)

    def test_model_file_must_be_included_by_the_netlist(self):
        self.netlist_path.write_text(
            "Two-pin fixture test\nV1 P 0 1\nRLOAD N 0 1k\nXU1 P N TESTRES\n.end\n"
        )
        with self.assertRaisesRegex(EDAError, "must include model file"):
            load_spec(self.spec_path)

    def test_model_file_may_be_loaded_with_a_lib_directive(self):
        self.netlist_path.write_text(
            "Two-pin fixture test\n"
            '.lib "models/fixture.lib" nominal\n'
            "V1 P 0 1\nRLOAD N 0 1k\nXU1 P N TESTRES\n.end\n"
        )
        self.assertEqual(
            load_spec(self.spec_path)["_models"]["u1_model"]["id"], "U1_model"
        )

    def test_unavailable_library_reference_is_rejected(self):
        self.spec["models"][0]["library_ref"] = "missing_model"
        self._write_spec()
        with self.assertRaisesRegex(EDAError, "Unavailable model library reference"):
            load_spec(self.spec_path)

    def test_tampered_validation_fixture_is_rejected(self):
        self.validation_fixture.write_text("changed local fixture\n")
        with self.assertRaisesRegex(EDAError, "validation fixture SHA-256 mismatch"):
            load_spec(self.spec_path)


if __name__ == "__main__":
    unittest.main()

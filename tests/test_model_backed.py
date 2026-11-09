"""Unit tests for source-derived SPICE model binding, without network/model downloads."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from edastack.adapters.model_backed import ModelBackedError, build_open_drain_spice


class ModelBackedTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.build = self.root / "source"
        self.build.mkdir()
        self.catalog = self.root / "vendor-catalog.json"
        self.model = self.root / "model.txt"
        # Deliberately synthetic model bytes; these tests verify wiring and hashes,
        # not 2N7002 electrical behavior (that needs the downloaded vendor model).
        model_bytes = b"* Synthetic pin-order fixture, not a vendor model\n.SUBCKT N7002 10 20 30\nR1 10 30 1k\n.ENDS\n"
        self.model.write_bytes(model_bytes)
        catalog = {"schema_version": 1, "models": [{
            "id": "diodes-2n7002-2017",
            "sha256": hashlib.sha256(model_bytes).hexdigest(),
            "terminal_order": ["D", "G", "S"],
            "sot23_physical_pin_map": {"D": "3", "G": "1", "S": "2"},
        }]}
        self.catalog.write_text(json.dumps(catalog))
        components = [
            {"reference": ref, "component_type": kind,
             "properties": props}
            for ref, kind, props in [
                ("J1", "connector", {}),
                ("J2", "connector", {}),
                ("Q1", "simple_chip", {}),
                ("R1", "simple_resistor", {"resistance": 10000}),
                ("R2", "simple_resistor", {"resistance": 1000}),
                ("R3", "simple_resistor", {"resistance": 100000}),
                ("C1", "simple_capacitor", {"capacitance": 1e-8}),
            ]
        ]
        assignments = {
            "CTRL": ["J1:2", "R2:1"],
            "GATE_FILTERED": ["C1:1", "Q1:1", "R2:2", "R3:1"],
            "GND": ["C1:2", "J1:3", "J2:2", "Q1:2", "R3:2"],
            "OUT": ["J2:1", "Q1:3", "R1:2"],
            "VIN5": ["J1:1", "R1:1"],
        }
        self.graph = {
            "schema_version": 1,
            "components": components,
            "nets": [{"id": f"N{i}", "names": [name], "pins": pins}
                     for i, (name, pins) in enumerate(assignments.items())],
        }
        self._save()
        self.parts = {"schema_version": 1, "status": "partially_verified",
                      "entries": [
                          {"reference": ref, "model_id": "diodes-2n7002-2017" if ref == "Q1" else None,
                           "model_verified": ref == "Q1"}
                          for ref in ("J1", "J2", "Q1", "R1", "R2", "R3", "C1")]}
        self._save_parts()

    def _save(self):
        (self.build / "source-graph.json").write_text(json.dumps(self.graph))

    def _save_parts(self):
        (self.build / "parts-validation.json").write_text(json.dumps(self.parts))

    def _run(self):
        return build_open_drain_spice(self.build, self.model, self.catalog, self.root / "generated")

    def test_generates_netlist_from_source_and_authenticated_terminal_mapping(self):
        result = self._run()
        text = (self.root / "generated" / "open_drain.cir").read_text()
        self.assertIn("XQ1 n_out n_gate_filtered 0 N7002", text)
        self.assertIn("R1 n_vin5 n_out 10000", text)
        self.assertTrue(Path(result["spec"]).is_file())
        self.assertEqual(len(json.loads((self.root / "generated" / "spec.json").read_text())["measurements"]), 4)

    def test_rejects_modified_model_checksum(self):
        self.model.write_text(self.model.read_text() + "* changed\n")
        with self.assertRaisesRegex(ModelBackedError, "SHA-256"):
            self._run()

    def test_rejects_swapped_ground_pin(self):
        for net in self.graph["nets"]:
            if net["names"] == ["GND"]:
                net["pins"].remove("Q1:2")
            elif net["names"] == ["OUT"]:
                net["pins"].append("Q1:2")
        self._save()
        with self.assertRaisesRegex(ModelBackedError, "connectivity"):
            self._run()

    def test_rejects_unrecognized_source_components(self):
        self.graph["components"].append(
            {"reference": "U1", "component_type": "simple_chip", "properties": {}})
        self._save()
        with self.assertRaisesRegex(ModelBackedError, "Unsupported source components"):
            self._run()


if __name__ == "__main__":
    unittest.main()

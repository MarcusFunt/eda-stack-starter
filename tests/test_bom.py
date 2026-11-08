import json
import unittest
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
BOM_PATH = ROOT / "examples" / "rc_operating_cases" / "bom.json"


class SourceLinkedBomTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bom = json.loads(BOM_PATH.read_text(encoding="utf-8"))
        cls.items = {item["reference"]: item for item in cls.bom["items"]}

    def test_supplier_snapshot_has_local_timestamp_and_exact_parts(self):
        snapshot = datetime.fromisoformat(
            self.bom["snapshot_time_utc"].replace("Z", "+00:00")
        )
        self.assertIsNotNone(snapshot.tzinfo)
        self.assertEqual(self.bom["sourcing"]["supplier"], "JLCPCB/LCSC")
        self.assertFalse(self.bom["sourcing"]["supplier_response_has_timestamp"])
        self.assertIsNone(self.bom["sourcing"]["lead_time"])
        self.assertEqual(set(self.items), {"R1", "C1"})
        for item in self.items.values():
            part = item["selected_part"]
            self.assertEqual(
                part["availability_price_snapshot_utc"], self.bom["snapshot_time_utc"]
            )
            self.assertEqual(part["supplier"], "JLCPCB/LCSC")
            self.assertGreater(part["supplier_stock_quantity"], 0)
            self.assertTrue(part["supplier_record"].startswith("https://"))
            self.assertIn("C", part["supplier_part_number"])

    def test_selected_parts_match_manufacturer_data_and_derating_limits(self):
        requirements = self.bom["requirements"]
        resistor = self.items["R1"]
        resistor_part = resistor["manufacturer_verified_properties"]
        resistor_datasheet = resistor["selected_part"]["manufacturer_datasheet"]
        self.assertEqual(urlparse(resistor_datasheet).hostname, "yageogroup.com")
        self.assertEqual(resistor_part["resistance_ohm"], 1000)
        self.assertEqual(resistor_part["tolerance_pct"], 1)
        self.assertIn("0603", resistor_part["package"])
        self.assertIn("0603", requirements["R1"]["package"])
        self.assertIn("1608", resistor_part["package"])
        self.assertIn("1608", requirements["R1"]["package"])
        rmin = resistor_part["resistance_ohm"] * (
            1 - resistor_part["tolerance_pct"] / 100
        )
        worst_case_power = requirements["R1"]["maximum_component_voltage_V"] ** 2 / rmin
        power_fraction = worst_case_power / resistor_part["rated_power_W_at_70C"]
        self.assertLessEqual(
            worst_case_power, requirements["R1"]["continuous_power_W_min_at_70C"]
        )
        self.assertLessEqual(
            power_fraction,
            requirements["R1"]["maximum_power_fraction_of_rating_at_70C"],
        )

        capacitor = self.items["C1"]
        capacitor_part = capacitor["manufacturer_verified_properties"]
        capacitor_datasheet = capacitor["selected_part"]["manufacturer_datasheet"]
        self.assertEqual(urlparse(capacitor_datasheet).hostname, "yageogroup.com")
        self.assertEqual(capacitor_part["capacitance_F"], 1e-7)
        self.assertEqual(capacitor_part["tolerance_pct"], 10)
        self.assertEqual(capacitor_part["dielectric"], "X7R")
        self.assertIn("0603", capacitor_part["package"])
        self.assertIn("0603", requirements["C1"]["package"])
        self.assertIn("1608", capacitor_part["package"])
        self.assertIn("1608", requirements["C1"]["package"])
        voltage_fraction = (
            requirements["C1"]["maximum_component_voltage_V"]
            / capacitor_part["rated_dc_voltage_V"]
        )
        self.assertLessEqual(
            voltage_fraction, requirements["C1"]["maximum_voltage_fraction_of_rating"]
        )

    def test_footprint_and_model_pin_mappings_are_pinned(self):
        expected = {
            "R1": {
                "footprint": "Resistor_SMD:R_0603_1608Metric",
                "sha256": "7190ac4a00125b807e54129ef0d87d87f2a658eeb74d025a7028203419b09f23",
                "pad_centers_x_mm": [-0.825, 0.825],
                "pad_size_mm": [0.8, 0.95],
            },
            "C1": {
                "footprint": "Capacitor_SMD:C_0603_1608Metric",
                "sha256": "fe0dbfefbb181a0466f93a8de52d84ba7b00fcd9acdbb69575f4128a0af4e405",
                "pad_centers_x_mm": [-0.775, 0.775],
                "pad_size_mm": [0.9, 0.95],
            },
        }
        for reference, fixture in expected.items():
            mapping = self.items[reference]["footprint_and_pin_map"]
            self.assertEqual(mapping["footprint"], fixture["footprint"])
            self.assertEqual(
                mapping["symbol_pin_to_footprint_pad"], {"1": "1", "2": "2"}
            )
            library_evidence = mapping["kicad_library_evidence"]
            self.assertEqual(self.bom["mapping_review"]["kicad_version"], "10.0.8")
            self.assertEqual(library_evidence["footprint_sha256"], fixture["sha256"])
            self.assertEqual(
                library_evidence["pad_centers_x_mm"], fixture["pad_centers_x_mm"]
            )
            self.assertEqual(library_evidence["pad_size_mm"], fixture["pad_size_mm"])
            model = self.items[reference]["simulation_model_mapping"]
            self.assertFalse(model["vendor_model_used"])
            self.assertEqual(
                set(model["physical_pin_to_spice_terminal"]),
                {"footprint_pad_1", "footprint_pad_2"},
            )


if __name__ == "__main__":
    unittest.main()

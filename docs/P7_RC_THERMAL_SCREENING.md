# P7 RC resistor thermal screening

**Status: electrical power/derating screen complete; component temperature rise is not estimated.** This is a fixture-specific screening note, not thermal simulation or hardware qualification.

## Inputs and evidence

- The RC BOM sets a 4.5–5.5 V supply range, 1 kΩ ±1% R1, a 100 mW R1 rating at 70 °C, and a project limit of 50% of that rating. The exact selected part is YAGEO `RC0603FR-071KL` ([manufacturer product specification](https://yageogroup.com/component-documentation/download/specsheet/RC0603FR-071KL)). The BOM records that its current SPICE model is an ideal resistor with no self-heating or temperature model.
- The real ngspice 47 start-up power sweep at 5 V measured 24.9997 mW peak at R1. Its report and waveform are in `build/p2_1_resistor_overstress/`; it uses an ideal 1 kΩ resistor and is electrical evidence only.
- The validated native board is 14 × 8 mm, 1.6 mm thick, with two copper layers. KiCad 10.0.8 reports 11.066 mm² front copper and 0.00 mm² back copper. R1 is a standard 0603 footprint. The data is in `build/tscircuit-rc/kicad-validation/summary.json` and `board-stats.json`.

## Power screen

At the upper supply limit and minimum resistance from the initial ±1% tolerance, the tolerance-only resistor power screen is:

```text
P = V² / Rmin = (5.5 V)² / (1,000 Ω × 0.99) = 30.56 mW
```

This tolerance-only result is 30.6% of the part's 100 mW rating at 70 °C and 61.1% of the project's 50 mW (50% rating) acceptance budget. It leaves 19.44 mW to that project limit. It does not include the resistor's temperature coefficient, so it is not a complete continuous worst-case bound.

The BOM records a ±100 ppm/°C temperature coefficient. As an illustrative correction, if the resistor element were at 70 °C (45 °C above the 25 °C reference) and had the negative TCR, the combined minimum resistance would be 985.545 Ω and the calculated power would be 30.69 mW, or 61.4% of the project's 50 mW budget. This assumes the element is no hotter than ambient and does not include self-heating; no thermal impedance or element temperature is available to justify that assumption for the real board. The 5 V startup simulation's 24.9997 mW observed peak is consistent with the nominal ideal-R value, but does not include the selected resistor's tolerance, temperature coefficient, or self-heating.

For the ideal RC circuit, this upper bound assumes the full supply is continuously across R1, such as a held low output or fault. During a single ideal step, resistor power begins at that bound and decays as the capacitor charges; long-term dissipation depends on operating and repetition conditions that are not specified here. At settled DC with an ideal capacitor and no output load, current and resistor dissipation are zero.

## Thermal interpretation and limits

The board geometry is recorded, but its small front-copper area and absent back copper do not provide a defensible thermal impedance. The available part specification states the power rating at 70 °C; this screening does not apply a temperature derating curve above 70 °C or estimate element temperature rise from the PCB. No heatsink, airflow, enclosure, nearby heat sources, duty cycle, or measured temperature is specified. A package-to-board thermal model or instrumented board test is required before making temperature or release claims.

The electrical power screen passes the BOM's 50%-of-rating limit under the tolerance-only calculation and remains below the limit in the illustrative 70 °C TCR calculation. A conservative continuous bound including actual element temperature has not been established. The screen does not establish board thermal performance, long-term reliability, fabrication readiness, or hardware safety.

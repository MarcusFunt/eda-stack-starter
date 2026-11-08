# Source-linked BOM snapshot

This small BOM maps the ideal R/C values in `spec.json` and `operating_cases.cir` to orderable YAGEO parts. It is a sourcing and pin-mapping record; the example netlist remains ideal and no KiCad schematic or PCB is included.

| Ref | Required value | Selected manufacturer part | JLCPCB/LCSC part | Price returned by Traces | Stock returned by Traces |
|---|---|---|---|---:|---:|
| R1 | 1 kΩ, ±1%, ≥100 mW, 0603 | YAGEO RC0603FR-071KL | C22548 | $0.0036 each | 14,118,671 |
| C1 | 100 nF, ±10% at 25°C, X7R, 50 V, 0603 | YAGEO CC0603KRX7R9BB104 | C14663 | $0.0155 each | 34,035,481 |

Traces 3.4.2, using local Ollama `gemma4`, returned these prices and stock counts from its JLCPCB/LCSC source on **2026-11-08 02:01:05 UTC** for exact manufacturer part-number queries. The responses did not provide supplier timestamps, a price break, minimum order quantity, standard pack size, or lead time; the UTC value above is the local capture time. Treat these as an API snapshot, not a purchase quote; refresh supplier data before procurement. JLCPCB/LCSC sourcing worked without supplier credentials. Mouser and Digi-Key were not queried.

## Datasheet review and derating

- **R1:** YAGEO's [manufacturer spec sheet](https://yageogroup.com/component-documentation/download/specsheet/RC0603FR-071KL) states 1 kΩ ±1%, 100 mW at 70°C, ±100 ppm/°C, 75 V maximum continuous voltage at full rated power, −55°C to +155°C, and a 0603/1608 package measuring 1.6 × 0.8 × 0.45 mm. At the example's 5.5 V maximum supply and the resistor's 990 Ω minimum from initial tolerance, the tolerance-only power screen is 30.56 mW, or 30.6% of its 100 mW rating. It excludes TCR and self-heating, so it is not a complete continuous worst-case bound. Applying the negative 100 ppm/°C TCR from 25°C to 70°C, while assuming the element itself stays at 70°C, gives 985.545 Ω and 30.69 mW (61.4% of the example's 50 mW budget). That illustrative assumption does not establish the actual board's element temperature; above 70°C ambient, use the manufacturer's full series derating curve and repeat the calculation.
- **C1:** YAGEO's [manufacturer spec sheet](https://yageogroup.com/download/specsheet/CC0603KRX7R9BB104) states 100 nF ±10%, X7R, 50 VDC, −55°C to +125°C, and a 0603/1608 package measuring 1.6 × 0.8 × 0.8 mm. The maximum 5.5 V applied in this example is 11% of the rated voltage, below the 25% design target. The nominal ±10% tolerance is not a complete allowance for DC-bias, temperature, aging, ESR, ESL, or leakage effects; those effects are not modeled by the ideal capacitor.

For both parts, the KiCad mapping is two-terminal and non-polarized: symbol pin 1 maps to footprint pad 1 and SPICE terminal 1; pin 2 maps to pad 2 and SPICE terminal 2. The selected standard footprints are `Resistor_SMD:R_0603_1608Metric` and `Capacitor_SMD:C_0603_1608Metric`. I checked their library files from the KiCad 10.0.8 pinned image used for interchange validation. The resistor footprint has pads 1/2 at x = −0.825/+0.825 mm, each 0.8 × 0.95 mm; the capacitor footprint has pads 1/2 at x = −0.775/+0.775 mm, each 0.9 × 0.95 mm. Their fabrication outlines are 1.6 × 0.825 mm and 1.6 × 0.8 mm, respectively, matching the YAGEO 0603 body dimensions within the library outline conventions. The exact file hashes and image digest are recorded in `bom.json`. The net mapping is R1: `IN` → `OUT`; C1: `OUT` → `GND`.

## Model and substitution policy

The physical parts have no vendor SPICE model attached to this example. R1 maps to the ngspice ideal `R` primitive; C1 maps to the ideal `C` primitive. The existing operating-case simulation is not evidence that the selected parts' tolerance, temperature, DC-bias, parasitics, or thermal behavior were simulated.

No alternate MPN is approved. A proposed substitute must be checked against its own manufacturer datasheet, meet the stated value/tolerance/package/rating requirements, have its physical pin and footprint mapping checked, receive a fresh supplier snapshot, and pass the applicable verification cases. The machine-readable snapshot and detailed field provenance are in [`bom.json`](bom.json).

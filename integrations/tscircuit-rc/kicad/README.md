# Native RC test fixture

This project is the KiCad handoff for the passive RC network used by the tscircuit simulation example. TP1 is the input, TP2 is the output, and TP3 is ground. The voltage source in the simulation is external to the board.

The board is 14 × 8 mm with two copper layers, one 0603 resistor, one 0603 capacitor, and three 1.5 mm test pads. Its KiCad library links use the installed KiCad 10 standard libraries. The test point at the input was moved outward to avoid overlapping the resistor courtyard. The test point reference text was placed clear of the pad outlines.

The checked project passes KiCad 10.0.8 ERC, DRC, and schematic/PCB parity with zero findings. Run npm run kicad:validate from integrations/tscircuit-rc/ to repeat those checks and compare the net connections with the generated SPICE source manifest.

This is a small, low-frequency RC reference design. Its ERC/DRC result and geometry review do not verify board fabrication, solderability, assembled component fit, or measured hardware. The container 3D preview has no resistor/capacitor body models.

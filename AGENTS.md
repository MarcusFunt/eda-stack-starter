# Agent instructions for EDA Stack Starter

This is a **verification harness**, not a general-purpose PCB design agent.

- Treat SPICE models, measurements and source designs as engineering inputs, not authoritative evidence of real-world safety.
- Never invent ngspice outputs. Run the actual simulator or report `ngspice not available`.
- Never mark an electrical check as passed if it is missing, non-finite, timed out or outside its bounds.
- When adjusting a circuit, change the source design/netlist in a reviewed diff, not the measurement bounds merely to pass tests.
- Record which corners/conditions were actually simulated. Do not call a finite set of corners a mathematically global worst case.
- Use the reviewed `.tsx` design or native schematic/netlist as the design source of truth. Generated SPICE models must be compared pin-for-pin to the source netlist.
- Before ordering hardware, require verified vendor models, datasheets, component derating, ERC/DRC, thermal/layout considerations and physical validation.

Use `edastack verify examples/rc_filter/spec.json --out build/rc_filter` for an initial smoke test. See `docs/AGENTS.md` for MCP integration and `docs/VERIFICATION.md` for engineering gates.

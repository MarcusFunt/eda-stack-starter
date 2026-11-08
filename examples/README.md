# Demonstration SPICE circuits

`rc_filter/` demonstrates parameter corners, simulated peak voltage and a timed step-response sample. Its nominal ideal response at 100 µs is approximately 3.1606 V, derived analytically (not measured in this environment).

`diode_clamp/` demonstrates nonlinear diode simulation with model-limited peak checking. It is not a validated design for actual surge or ESD protection.

Both examples are suitable for exercising the automation harness once ngspice has been installed. They are not complete manufacturable schematics or PCB designs.

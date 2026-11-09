/**
 * New low-voltage reference design generated from requirements.json.
 * Experimental TSX route candidate. Not a fabrication release.
 */
export default () => (
  <board width="36mm" height="24mm" layers={2}>
    <net name="VIN5" />
    <net name="CTRL" />
    <net name="GND" />
    <net name="GATE_FILTERED" />
    <net name="OUT" />
    <connector name="J1" pinCount={3} footprint="pinrow3" pcbX={-13} pcbY={0} />
    <connector name="J2" pinCount={2} footprint="pinrow2" pcbX={14} pcbY={0} />
    <chip name="Q1" footprint="sot23" pinLabels={{ pin1: "G", pin2: "S", pin3: "D" }} pcbX={4} pcbY={-3} />
    <resistor name="R1" resistance="10k" footprint="0603" pcbX={9} pcbY={4} />
    <resistor name="R2" resistance="1k" footprint="0603" pcbX={-7} pcbY={-4} />
    <resistor name="R3" resistance="100k" footprint="0603" pcbX={-1} pcbY={-7} />
    <capacitor name="C1" capacitance="10nF" footprint="0603" pcbX={-1} pcbY={-2} />

    <trace from=".J1 > .pin1" to="net.VIN5" />
    <trace from=".J1 > .pin2" to="net.CTRL" />
    <trace from=".J1 > .pin3" to="net.GND" />
    <trace from=".J2 > .pin1" to="net.OUT" />
    <trace from=".J2 > .pin2" to="net.GND" />
    <trace from=".R1 > .pin1" to="net.VIN5" />
    <trace from=".R1 > .pin2" to="net.OUT" />
    <trace from=".R2 > .pin1" to="net.CTRL" />
    <trace from=".R2 > .pin2" to="net.GATE_FILTERED" />
    <trace from=".R3 > .pin1" to="net.GATE_FILTERED" />
    <trace from=".R3 > .pin2" to="net.GND" />
    <trace from=".C1 > .pin1" to="net.GATE_FILTERED" />
    <trace from=".C1 > .pin2" to="net.GND" />
    <trace from=".Q1 > .G" to="net.GATE_FILTERED" />
    <trace from=".Q1 > .S" to="net.GND" />
    <trace from=".Q1 > .D" to="net.OUT" />
  </board>
);

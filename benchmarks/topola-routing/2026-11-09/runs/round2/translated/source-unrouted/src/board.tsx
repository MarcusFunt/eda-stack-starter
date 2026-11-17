export default () => (
  <board width="24mm" height="14mm" routingDisabled>
    <net name="VIN" />
    <net name="MID" />
    <net name="GND" />
    <connector
      name="J1"
      pinCount={3}
      footprint="pinrow3"
      pinAttributes={{ pin1: { providesPower: true }, pin3: { providesGround: true } }}
      pcbX={-5}
      pcbY={2}
    />
    <resistor name="R1" resistance="10k" footprint="0603" pcbX={2} pcbY={5} />
    <resistor name="R2" resistance="10k" footprint="0603" pcbX={2} pcbY={-1} />
    <trace from=".J1 > .pin1" to="net.VIN" />
    <trace from=".J1 > .pin2" to="net.MID" />
    <trace from=".J1 > .pin3" to="net.GND" />
    <trace from=".R1 > .pin1" to="net.VIN" />
    <trace from=".R1 > .pin2" to="net.MID" />
    <trace from=".R2 > .pin1" to="net.MID" />
    <trace from=".R2 > .pin2" to="net.GND" />
  </board>
);


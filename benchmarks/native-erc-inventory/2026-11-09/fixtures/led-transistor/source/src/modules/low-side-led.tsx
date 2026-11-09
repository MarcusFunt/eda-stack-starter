export function LowSideLed() {
  return (
    <>
      <transistor name="Q1" type="npn" footprint="TO-92" pcbX={5} pcbY={0} />
      <led name="D1" color="red" footprint="0603" pcbX={0} pcbY={4} />
      <resistor name="R1" resistance="1k" footprint="0603" pcbX={-4} pcbY={4} />
      <resistor name="R2" resistance="10k" footprint="0603" pcbX={0} pcbY={-4} />
      <trace from=".J1 > .pin1" to="net.VCC" />
      <trace from=".R1 > .pin1" to=".J1 > .pin1" />
      <trace from=".R1 > .pin2" to=".D1 > .anode" />
      <trace from=".D1 > .cathode" to=".Q1 > .collector" />
      <trace from=".Q1 > .emitter" to=".J1 > .pin2" />
      <trace from=".J1 > .pin2" to="net.GND" />
      <trace from=".J1 > .pin3" to="net.CTRL" />
      <trace from=".R2 > .pin1" to=".J1 > .pin3" />
      <trace from=".R2 > .pin2" to=".Q1 > .base" />
    </>
  );
}

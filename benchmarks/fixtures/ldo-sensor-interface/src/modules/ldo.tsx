export function LdoPower() {
  return (
    <>
      <chip
        name="U1"
        footprint="SOT-23-5"
        pinLabels={{ pin1: "IN", pin2: "GND", pin3: "EN", pin4: "NC", pin5: "OUT" }}
        pcbX={0}
        pcbY={2}
      />
      <capacitor name="C1" capacitance="1uF" footprint="0603" pcbX={-5} pcbY={2} />
      <capacitor name="C2" capacitance="1uF" footprint="0603" pcbX={5} pcbY={2} />
      <trace from=".J1 > .pin1" to="net.VIN" />
      <trace from=".U1 > .pin1" to="net.VIN" />
      <trace from=".C1 > .pin1" to="net.VIN" />
      <trace from=".U1 > .pin2" to="net.GND" />
      <trace from=".J1 > .pin2" to="net.GND" />
      <trace from=".C1 > .pin2" to="net.GND" />
      <trace from=".U1 > .pin3" to="net.VIN" />
      <trace from=".U1 > .pin5" to="net.V3V3" />
      <trace from=".C2 > .pin1" to="net.V3V3" />
      <trace from=".C2 > .pin2" to="net.GND" />
    </>
  );
}

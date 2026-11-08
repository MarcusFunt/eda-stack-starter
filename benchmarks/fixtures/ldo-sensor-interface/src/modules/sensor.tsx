export function SensorInterface() {
  return (
    <>
      <chip
        name="U2"
        footprint="SOIC-8"
        pinLabels={{ pin1: "VDD", pin2: "GND", pin3: "SCL", pin4: "SDA" }}
        pcbX={5}
        pcbY={-5}
      />
      <connector name="J2" pinCount={4} footprint="pinrow4" pcbX={-7} pcbY={-6} />
      <trace from=".U1 > .pin5" to="net.V3V3" />
      <trace from=".U2 > .pin1" to="net.V3V3" />
      <trace from=".U2 > .pin2" to="net.GND" />
      <trace from=".J2 > .pin1" to="net.V3V3" />
      <trace from=".J2 > .pin2" to="net.GND" />
      <trace from=".J2 > .pin3" to="net.SCL" />
      <trace from=".J2 > .pin4" to="net.SDA" />
      <trace from=".U2 > .pin3" to="net.SCL" />
      <trace from=".U2 > .pin4" to="net.SDA" />
    </>
  );
}

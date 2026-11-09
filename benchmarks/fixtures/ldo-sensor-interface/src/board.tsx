import { LdoPower } from "./modules/ldo.js";
import { SensorInterface } from "./modules/sensor.js";

export default () => (
  <board width="36mm" height="24mm" routingDisabled>
    <net name="VIN" />
    <net name="V3V3" />
    <net name="GND" />
    <net name="SCL" />
    <net name="SDA" />
    <schematicsheet name="Power" displayName="Power" sheetIndex={0} />
    <schematicsheet name="Sensor" displayName="Sensor Interface" sheetIndex={1} />
    <connector name="J1" pinCount={2} footprint="pinrow2" pcbX={-10} pcbY={3} schSheetName="Power" />
    <group schSheetName="Power">
      <LdoPower />
    </group>
    <group schSheetName="Sensor">
      <SensorInterface />
    </group>
  </board>
);

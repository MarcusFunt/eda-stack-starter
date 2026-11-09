import { LowSideLed } from "./modules/low-side-led.js";

export default () => (
  <board width="30mm" height="18mm" routingDisabled>
    <net name="VCC" />
    <net name="GND" />
    <net name="CTRL" />
    <connector name="J1" pinCount={3} footprint="pinrow3" pcbX={-10} pcbY={0} />
    <LowSideLed />
  </board>
);

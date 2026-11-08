import assert from "node:assert/strict";
import { test } from "node:test";

let connectivity: typeof import("../src/connectivity.js") | undefined;
try {
  connectivity = await import("../src/connectivity.js");
} catch {
  // Keep module absence as an ordinary assertion failure during the RED step.
}

const fixture = [
  { type: "source_component", source_component_id: "c1", name: "R1" },
  { type: "source_component", source_component_id: "c2", name: "R2" },
  { type: "source_port", source_port_id: "p11", source_component_id: "c1", pin_number: 1 },
  { type: "source_port", source_port_id: "p12", source_component_id: "c1", pin_number: 2 },
  { type: "source_port", source_port_id: "p21", source_component_id: "c2", pin_number: 1 },
  { type: "source_port", source_port_id: "p22", source_component_id: "c2", pin_number: 2 },
  { type: "source_net", source_net_id: "n-in", name: "VIN" },
  { type: "source_net", source_net_id: "n-mid", name: "SIGNAL" },
  { type: "source_net", source_net_id: "n-gnd", name: "GND", is_ground: true },
  { type: "source_trace", connected_source_port_ids: ["p11"], connected_source_net_ids: ["n-in"] },
  { type: "source_trace", connected_source_port_ids: ["p12", "p21"], connected_source_net_ids: ["n-mid"] },
  { type: "source_trace", connected_source_port_ids: ["p22"], connected_source_net_ids: ["n-gnd"] },
];

test("connectivity module is implemented", () => {
  assert.equal(typeof connectivity?.sourcePinNetGroups, "function", "sourcePinNetGroups must be exported");
});

test("source pin groups preserve named-net membership", () => {
  assert.ok(connectivity, "connectivity module is required");
  assert.deepEqual(connectivity.sourcePinNetGroups(fixture), [
    { netNames: ["GND"], pins: ["R2:2"] },
    { netNames: ["SIGNAL"], pins: ["R1:2", "R2:1"] },
    { netNames: ["VIN"], pins: ["R1:1"] },
  ]);
});

test("source graph rejects duplicate physical pad numbers", () => {
  assert.ok(connectivity, "connectivity module is required");
  const collidingFixture = [
    ...fixture,
    { type: "source_port", source_port_id: "p-extra", source_component_id: "c1", pin_number: 2 },
  ];
  assert.throws(() => connectivity.sourcePinNetGroups(collidingFixture), /duplicate.*pin|pad.*collision/i);
});

test("source graph rejects a trace that references an unknown pin", () => {
  assert.ok(connectivity, "connectivity module is required");
  const invalidFixture = [
    ...fixture,
    { type: "source_trace", connected_source_port_ids: ["missing"], connected_source_net_ids: ["n-mid"] },
  ];
  assert.throws(() => connectivity.sourcePinNetGroups(invalidFixture), /unknown.*(port|pin|identity)/i);
});

let nativeNetlist: typeof import("../src/connectivity.js") | undefined;
try {
  nativeNetlist = await import("../src/connectivity.js");
} catch {
  // The export presence check below reports an expected RED failure.
}

const netlist = `(export
  (components
    (comp (ref "R1") (value "1k"))
    (comp (ref "R2") (value "1k")))
  (nets
    (net (code "1") (name "N-001") (node (ref "R1") (pin "1")))
    (net (code "2") (name "N-002") (node (ref "R1") (pin "2")) (node (ref "R2") (pin "1")))
    (net (code "3") (name "N-003") (node (ref "R2") (pin "2")))))`;

test("native netlist parser is implemented", () => {
  assert.equal(typeof nativeNetlist?.parseKicadNetlistPinNetGroups, "function");
  assert.equal(typeof nativeNetlist?.assertPinNetMembership, "function");
});

test("native netlist parser reads physical pin membership", () => {
  assert.ok(nativeNetlist, "connectivity module is required");
  assert.deepEqual(nativeNetlist.parseKicadNetlistPinNetGroups(netlist), [
    { netNames: ["N-001"], pins: ["R1:1"] },
    { netNames: ["N-002"], pins: ["R1:2", "R2:1"] },
    { netNames: ["N-003"], pins: ["R2:2"] },
  ]);
});

test("pin membership comparison ignores renamed nets but detects a split net", () => {
  assert.ok(nativeNetlist, "connectivity module is required");
  const expected = connectivity!.sourcePinNetGroups(fixture);
  const actual = nativeNetlist.parseKicadNetlistPinNetGroups(netlist);
  assert.doesNotThrow(() => nativeNetlist!.assertPinNetMembership(expected, actual));

  const split = [
    { netNames: ["S1"], pins: ["R1:1"] },
    { netNames: ["S2"], pins: ["R1:2"] },
    { netNames: ["S3"], pins: ["R2:1"] },
    { netNames: ["S4"], pins: ["R2:2"] },
  ];
  assert.throws(() => nativeNetlist!.assertPinNetMembership(expected, split), /connectivity.*match|membership/i);
});

test("pin membership comparison detects two source nets collapsed into one", () => {
  assert.ok(nativeNetlist, "connectivity module is required");
  assert.equal(typeof nativeNetlist.assertPinNetMembership, "function");
  const expected = connectivity!.sourcePinNetGroups(fixture);
  const collapsed = [
    { netNames: ["N-all"], pins: ["R1:1", "R1:2", "R2:1", "R2:2"] },
  ];
  assert.throws(() => nativeNetlist!.assertPinNetMembership(expected, collapsed), /connectivity.*match|membership/i);
});

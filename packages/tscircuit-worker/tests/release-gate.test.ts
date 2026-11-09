import test from "node:test";
import assert from "node:assert/strict";
import { checkGeneralNativeRelease, checkReviewedRcRelease } from "../src/release-gate.js";

function cleanFixture() {
  return { fixture: "board-a", pin_net_membership: "exact", erc_finding_count: 0, erc_findings: [], erc_ignored_checks: [],
    pcb_drc_violations: 0, pcb_drc_findings: [], pcb_drc_ignored_checks: [],
    pcb_unconnected_items: [], pcb_schematic_parity_issues: [] };
}
test("strict release accepts a native design only when every required check is clean", () => {
  const report = { schema_version: 1, native_pin_net_membership: "passed", fixtures: [cleanFixture()] };
  assert.equal(checkGeneralNativeRelease(report, ["board-a"]).ready, true);
});
test("strict release rejects electrical findings even when compatibility checks pass", () => {
  const report = { schema_version: 1, native_pin_net_membership: "passed", fixtures: [
    { ...cleanFixture(), erc_finding_count: 1, erc_findings: [{ type: "pin_not_connected" }] },
  ] };
  const result = checkGeneralNativeRelease(report, ["board-a"], "schematic");
  assert.equal(result.ready, false);
  assert.match(result.blockers.join(";"), /unresolved findings/);
});
test("strict release rejects unrecorded or ignored ERC rules", () => {
  const base = { schema_version: 1, native_pin_net_membership: "passed", fixtures: [cleanFixture()] };
  assert.equal(checkGeneralNativeRelease({ ...base, fixtures: [{ ...cleanFixture(), erc_ignored_checks: ["endpoint_off_grid"] }] }, ["board-a"]).ready, false);
  const missing = cleanFixture() as Record<string, unknown>;
  delete missing.erc_ignored_checks;
  assert.equal(checkGeneralNativeRelease({ ...base, fixtures: [missing] }, ["board-a"]).ready, false);
});
test("strict PCB release requires complete DRC evidence and does not conflate it with schematic release", () => {
  const fixture = { ...cleanFixture(), pcb_drc_violations: 1, pcb_drc_findings: [{ type: "unconnected_items" }] };
  const report = { schema_version: 1, native_pin_net_membership: "passed", fixtures: [fixture] };
  assert.equal(checkGeneralNativeRelease(report, ["board-a"], "schematic").ready, true);
  assert.equal(checkGeneralNativeRelease(report, ["board-a"], "pcb").ready, false);
});
test("strict PCB release rejects separately reported unconnected items", () => {
  const report = { schema_version: 1, native_pin_net_membership: "passed", fixtures: [
    { ...cleanFixture(), pcb_unconnected_items: [{ description: "J1 pin 2 not connected" }] },
  ] };
  const result = checkGeneralNativeRelease(report, ["board-a"], "pcb");
  assert.equal(result.ready, false);
  assert.match(result.blockers.join(";"), /unconnected/i);
});
test("strict PCB release rejects schematic parity issues", () => {
  const report = { schema_version: 1, native_pin_net_membership: "passed", fixtures: [
    { ...cleanFixture(), pcb_schematic_parity_issues: [{ description: "pad net differs from schematic" }] },
  ] };
  const result = checkGeneralNativeRelease(report, ["board-a"], "pcb");
  assert.equal(result.ready, false);
  assert.match(result.blockers.join(";"), /schematic parity/i);
});
test("unseen, duplicate, or missing fixture evidence never passes", () => {
  const report = { schema_version: 1, native_pin_net_membership: "passed", fixtures: [cleanFixture(),cleanFixture()] };
  assert.equal(checkGeneralNativeRelease(report, ["board-a"]).ready, false);
  assert.equal(checkGeneralNativeRelease(report, ["not-present"]).ready, false);
  assert.throws(() => checkGeneralNativeRelease(report, []), /Explicit fixture/);
});
test("reviewed RC gate checks only the known clean RC template and retains physical release hold", () => {
  const summary = { schema_version: 1, native_template_scope: "fixed RC topology; tscircuit values propagated to reviewed KiCad template",
    results: { erc_violations: 0, drc_violations: 0, unconnected_items: 0, schematic_parity_issues: 0 },
    manufacturing_outputs: { status: "exports_checked_physical_release_review_required" } };
  assert.equal(checkReviewedRcRelease(summary).ready, true);
  assert.equal(checkReviewedRcRelease({ ...summary, results: { ...summary.results, erc_violations: 1 } }).ready, false);
});

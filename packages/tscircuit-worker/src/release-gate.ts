/**
 * Strict native electrical/layout release gates.
 *
 * Experimental converter compatibility runs are intentionally allowed to finish
 * and publish their findings. Only explicit release candidates are allowed
 * through these checks; no ERC or DRC issue is automatically waived.
 */
type RecordValue = Record<string, unknown>;
export type ReleaseMode = "schematic" | "pcb";
export type NativeGateResult = {
  ready: boolean;
  scope: string;
  mode: ReleaseMode;
  checked: string[];
  blockers: string[];
};

function object(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactZero(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value === 0;
}
function nonemptyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

export function checkGeneralNativeRelease(
  report: unknown,
  fixtures: readonly string[],
  mode: ReleaseMode = "pcb",
): NativeGateResult {
  const blockers: string[] = [];
  if (mode !== "schematic" && mode !== "pcb") throw new Error("Release mode must be schematic or pcb");
  if (!Array.isArray(fixtures) || !fixtures.length || fixtures.some((s) => typeof s !== "string" || !s.trim())) {
    throw new Error("Explicit fixture names are mandatory for release; empty selection is not approved");
  }
  const checked = [...new Set(fixtures)].sort();
  if (!object(report) || report.schema_version !== 1 || !Array.isArray(report.fixtures)) {
    return { ready: false, scope: "general-native", mode, checked, blockers: ["Missing or unsupported native verification summary"] };
  }
  if (report.native_pin_net_membership !== "passed") blockers.push("Global native pin-net comparison did not pass");
  const entries = report.fixtures.filter(object);
  for (const name of checked) {
    const found = entries.filter((fixture) => fixture.fixture === name);
    if (found.length !== 1) { blockers.push(name + ": expected exactly one result, found " + found.length); continue; }
    const fixture = found[0];
    if (fixture.pin_net_membership !== "exact") blockers.push(name + ": source and native pin-net membership is not exact");
    if (!exactZero(fixture.erc_finding_count) || !Array.isArray(fixture.erc_findings) || fixture.erc_findings.length !== 0) {
      blockers.push(name + ": KiCad ERC has unresolved findings");
    }
    if (nonemptyArray(fixture.erc_ignored_checks) || !Array.isArray(fixture.erc_ignored_checks)) {
      blockers.push(name + ": ERC ignored-check list is nonempty or unrecorded");
    }
    if (mode === "pcb") {
      if (!exactZero(fixture.pcb_drc_violations) || !Array.isArray(fixture.pcb_drc_findings) || fixture.pcb_drc_findings.length !== 0) {
        blockers.push(name + ": KiCad PCB DRC has unresolved findings");
      }
      if (nonemptyArray(fixture.pcb_drc_ignored_checks) || !Array.isArray(fixture.pcb_drc_ignored_checks)) {
        blockers.push(name + ": PCB DRC ignored-check list is nonempty or unrecorded");
      }
    }
  }
  return { ready: blockers.length === 0, scope: "general-native", mode, checked, blockers };
}

export function checkReviewedRcRelease(report: unknown): NativeGateResult {
  const blockers: string[] = [];
  if (!object(report) || report.schema_version !== 1 || !object(report.results)) {
    return { ready: false, scope: "reviewed-rc-only", mode: "pcb", checked: ["rc_filter"], blockers: ["Missing reviewed RC summary"] };
  }
  if (report.native_template_scope !== "fixed RC topology; tscircuit values propagated to reviewed KiCad template") {
    blockers.push("Not the reviewed fixed RC template pipeline");
  }
  for (const key of ["erc_violations", "drc_violations", "unconnected_items", "schematic_parity_issues"]) {
    if (!exactZero(report.results[key])) blockers.push("RC: " + key + " is nonzero or missing");
  }
  if (!object(report.manufacturing_outputs) ||
      report.manufacturing_outputs.status !== "exports_checked_physical_release_review_required") {
    blockers.push("RC manufacturing artifact structure was not checked");
  }
  return { ready: blockers.length === 0, scope: "reviewed-rc-only", mode: "pcb", checked: ["rc_filter"], blockers };
}

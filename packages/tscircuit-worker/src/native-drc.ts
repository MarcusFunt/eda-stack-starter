export type PcbDrcEvidence = {
  violations: unknown[];
  unconnectedItems: unknown[];
  schematicParityIssues: unknown[];
  findings: unknown[];
};

export function createPcbDrcArgs(outputPath: string, pcbPath: string): string[] {
  return ["pcb", "drc", "--schematic-parity", "--format", "json", "--output", outputPath, pcbPath];
}

export function readPcbDrcEvidence(report: unknown, label = "KiCad PCB DRC report"): PcbDrcEvidence {
  if (typeof report !== "object" || report === null || Array.isArray(report)) {
    throw new Error(label + " must be an object");
  }
  const value = report as Record<string, unknown>;
  if (!Array.isArray(value.violations) || !Array.isArray(value.unconnected_items) || !Array.isArray(value.schematic_parity)) {
    throw new Error(label + " is missing violations, unconnected_items, or schematic_parity");
  }
  const violations = value.violations;
  const unconnectedItems = value.unconnected_items;
  const schematicParityIssues = value.schematic_parity;
  return {
    violations,
    unconnectedItems,
    schematicParityIssues,
    findings: [...violations, ...unconnectedItems, ...schematicParityIssues],
  };
}

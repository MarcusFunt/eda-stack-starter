export type ErcFaultCategory =
  | "actual_electrical_defect"
  | "symbol_pin_type_error"
  | "unconnected_endpoint_grid_geometry"
  | "power_source_semantics"
  | "hierarchy_label_issue"
  | "exporter_defect";

type NativeItem = {
  uuid?: string;
  description?: string;
  pos?: { x?: number; y?: number };
};

type NativeViolation = {
  type: string;
  description?: string;
  items?: NativeItem | NativeItem[];
  [key: string]: unknown;
};

type SourceGraph = {
  components: Array<{ reference: string; [key: string]: unknown }>;
  ports: Array<{ component: string; pin: string; name?: string; net_id: string; [key: string]: unknown }>;
  nets: Array<{ id: string; names: string[]; pins: string[]; [key: string]: unknown }>;
};

export type ErcFaultInventoryInput = {
  fixture: string;
  project_path: string;
  build_manifest: {
    source_files: Array<{ path: string; sha256: string; bytes?: number }>;
    circuit_json_sha256: string;
    source_graph_sha256: string;
  };
  source_graph: SourceGraph;
  circuit_json: Array<Record<string, unknown>>;
  erc: {
    ignored_checks: unknown[];
    sheets: Array<{ sheet_name?: string; sheet_path?: string; violations?: NativeViolation[] }>;
  };
};

type FindingRule = {
  category: ErcFaultCategory;
  rootCauseConfidence?: "hypothesis" | "established";
  likelyRootCause: (items: NativeItem[]) => string;
};

const findingRules: Record<string, FindingRule> = {
  endpoint_off_grid: {
    category: "unconnected_endpoint_grid_geometry",
    likelyRootCause: () =>
      "The exported symbol pin or wire endpoint is off KiCad's connection grid. Source/native pin membership is exact, so the leading hypothesis is fractional-mm schematic placement emitted by the converter; native coordinates and UUIDs identify each reproduction point.",
  },
  unconnected_wire_endpoint: {
    category: "unconnected_endpoint_grid_geometry",
    likelyRootCause: () =>
      "The exported schematic contains a wire endpoint that does not terminate on a pin, joined wire, junction, or label anchor. This is a generated schematic geometry defect even when the native netlist still preserves all source pin groups.",
  },
  power_pin_not_driven: {
    category: "power_source_semantics",
    likelyRootCause: () =>
      "A generated power-input symbol is present without a Power output pin on its native rail. The fixtures use named rails and connector-fed inputs but do not yet express a KiCad power-source assertion such as a PWR_FLAG or a correctly typed source pin.",
  },
  same_local_global_label: {
    category: "hierarchy_label_issue",
    likelyRootCause: () =>
      "The exported schematic places local and global labels with identical text in one scope. The source net is singular, so duplicate label-scope emission by the converter is the leading hypothesis.",
  },
  single_global_label: {
    category: "hierarchy_label_issue",
    likelyRootCause: () =>
      "A global label occurs only once in the exported schematic. The exporter likely chose global scope for a net that has no cross-sheet consumer; use the appropriate local or hierarchical label scope after checking the source topology.",
  },
  footprint_filter: {
    category: "exporter_defect",
    likelyRootCause: () =>
      "KiCad reports an empty or incompatible symbol footprint field even though the source project carries a footprint selection. The exporter likely failed to propagate the selected footprint into the native symbol properties.",
  },
  footprint_link_issues: {
    category: "exporter_defect",
    rootCauseConfidence: "established",
    likelyRootCause: () =>
      "KiCad 10.0.8 CLI does not resolve this generated nonstandard footprint library during schematic ERC, despite the footprint file and project-local fp-lib-table being present. The behavior was reproduced with a project-local table and an attempted temporary global table; GUI resolution was not verified in this run.",
  },
};

function findingRule(violation: NativeViolation): FindingRule {
  const known = findingRules[violation.type];
  if (known) return known;
  if (violation.type === "pin_not_connected") {
    const items = normalizeItems(violation.items);
    const intentionalNc = items.some((item) => /\[[^\]]*\bNC\s*,/i.test(item.description ?? ""));
    if (intentionalNc) {
      return {
        category: "symbol_pin_type_error",
        likelyRootCause: () =>
          "The source pin is explicitly named NC, but the generated symbol remains electrically passive and lacks an explicit KiCad no-connect marker. The design intent is visible in the pin label, while the exporter does not carry that intent into the native schematic.",
      };
    }
    return {
      category: "actual_electrical_defect",
      likelyRootCause: () =>
        "A symbol pin is neither connected to a native net nor marked as intentionally unconnected. Confirm the source trace or add an explicit no-connect declaration before release.",
    };
  }
  throw new Error("unclassified KiCad ERC finding type: " + violation.type);
}

function normalizeItems(items: NativeViolation["items"]): NativeItem[] {
  if (Array.isArray(items)) return items;
  return items ? [items] : [];
}

function sourcePinsForItem(item: NativeItem, input: ErcFaultInventoryInput): Array<Record<string, unknown>> {
  const description = item.description ?? "";
  const symbolPin = /^Symbol\s+(\S+)\s+Pin\s+(\S+)\s+\[([^,\]]+)/.exec(description);
  if (!symbolPin) return [];
  const [, component, pin, pinName] = symbolPin;
  const sourcePort = input.source_graph.ports.find((port) => port.component === component && port.pin === pin);
  if (!sourcePort) return [];
  const sourceNet = input.source_graph.nets.find((net) => net.id === sourcePort.net_id);
  return [{
    component_reference: component,
    pin_number: pin,
    pin_name: sourcePort.name ?? pinName.trim(),
    net_id: sourcePort.net_id,
    net_names: sourceNet?.names ?? [],
  }];
}

function labelTextForItem(item: NativeItem, input: ErcFaultInventoryInput): string | undefined {
  const description = item.description ?? "";
  const quotedLabel = /^(?:Global )?Label\s+'([^']+)'$/.exec(description);
  if (quotedLabel) return quotedLabel[1];
  const powerSymbol = /#PWRschematic_net_label_(\d+)/.exec(description);
  if (!powerSymbol) return undefined;
  const labelId = "schematic_net_label_" + powerSymbol[1];
  const label = input.circuit_json.find(
    (record) => record.type === "schematic_net_label" && record.schematic_net_label_id === labelId,
  );
  return typeof label?.text === "string" ? label.text : undefined;
}

function sourceNetsForItems(items: NativeItem[], input: ErcFaultInventoryInput): Array<Record<string, unknown>> {
  const names = new Set(items.map((item) => labelTextForItem(item, input)).filter((name): name is string => Boolean(name)));
  const matched = input.source_graph.nets.filter((net) => net.names.some((name) => names.has(name)));
  return matched.map((net) => ({ id: net.id, names: net.names, pins: net.pins }));
}

function nativeItemReference(item: NativeItem): Record<string, unknown> {
  return {
    uuid: item.uuid ?? null,
    description: item.description ?? null,
    position_mm: item.pos ? { x: item.pos.x ?? null, y: item.pos.y ?? null } : null,
  };
}

export function buildErcFaultInventory(input: ErcFaultInventoryInput) {
  const findings = input.erc.sheets.flatMap((sheet, sheetIndex) =>
    (sheet.violations ?? []).map((violation, findingIndex) => {
      const items = normalizeItems(violation.items);
      const rule = findingRule(violation);
      const sourcePins = items.flatMap((item) => sourcePinsForItem(item, input));
      const sourceNets = sourceNetsForItems(items, input);
      const sourceFiles = input.build_manifest.source_files.map((source) => ({
        path: input.project_path.replaceAll("\\", "/") + "/" + source.path,
        sha256: source.sha256,
        bytes: source.bytes ?? null,
      }));
      return {
        id: `${input.fixture}:${sheetIndex}:${findingIndex}:${items[0]?.uuid ?? violation.type}`,
        fixture: input.fixture,
        type: violation.type,
        description: violation.description ?? null,
        sheet: sheet.sheet_name ?? sheet.sheet_path ?? null,
        category: rule.category,
        likely_root_cause: rule.likelyRootCause(items),
        root_cause_confidence: rule.rootCauseConfidence ?? "hypothesis",
        reproducible_fixture: input.project_path.replaceAll("\\", "/"),
        source_reference: {
          source_files: sourceFiles,
          circuit_json_sha256: input.build_manifest.circuit_json_sha256,
          source_graph_sha256: input.build_manifest.source_graph_sha256,
          native_items: items.map(nativeItemReference),
          source_pins: sourcePins,
          source_nets: sourceNets,
        },
        raw_finding: violation,
      };
    }),
  );
  const categoryCounts: Record<string, number> = {};
  for (const finding of findings) categoryCounts[finding.category] = (categoryCounts[finding.category] ?? 0) + 1;
  const sortedCategoryCounts = Object.fromEntries(Object.entries(categoryCounts).sort(([left], [right]) => left.localeCompare(right)));
  return {
    schema_version: 1,
    fixture: input.fixture,
    source_project: input.project_path.replaceAll("\\", "/"),
    finding_count: findings.length,
    category_counts: sortedCategoryCounts,
    erc_ignored_checks: input.erc.ignored_checks,
    findings,
  };
}

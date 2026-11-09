import { readFile } from "node:fs/promises";
import path from "node:path";
type ObjectRecord = Record<string, unknown>;
function isObject(v: unknown): v is ObjectRecord { return typeof v === "object" && v !== null && !Array.isArray(v); }
function required(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) throw new Error("PARTS_INVALID: " + name + " missing");
  return v;
}
export type PartResolution = {
  schema_version: 1;
  status: "unverified" | "partially_verified" | "verified";
  entries: Array<{
    reference: string; manufacturer_part_number: string | null; footprint: string | null;
    physical_pins: string[]; model_id: string | null; model_verified: boolean;
    pin_map_status: string; issues: string[];
  }>;
  unresolved: string[];
};
const normalize = (value: string) => value.trim().toLowerCase().replaceAll(/[^a-z0-9]/g, "");
const namedPin = (name: string) => {
  const value = normalize(name);
  if (value === "drain" || value === "d") return "D";
  if (value === "gate" || value === "g") return "G";
  if (value === "source" || value === "s") return "S";
  return null;
};

/** Verify a declared physical mapping against the compiler's actual physical pin numbers. */
export function resolveParts(
  circuitJson: readonly unknown[],
  partsLock: unknown,
  catalog: unknown,
): PartResolution {
  if (!Array.isArray(circuitJson) || !isObject(partsLock) || !Array.isArray(partsLock.parts)) throw new Error("PARTS_INVALID: missing Circuit JSON or part lock");
  if (!isObject(catalog) || catalog.schema_version !== 1 || !Array.isArray(catalog.models)) throw new Error("PARTS_INVALID: missing vendor model catalog");
  const models = new Map<string, ObjectRecord>();
  for (const item of catalog.models) {
    if (!isObject(item)) throw new Error("PARTS_INVALID: invalid catalog record");
    const id = required(item.id, "model id");
    if (models.has(id)) throw new Error("PARTS_INVALID: duplicate model id");
    models.set(id, item);
  }
  const allComponents = circuitJson.filter((v): v is ObjectRecord => isObject(v) && v.type === "source_component");
  const pcbRecords = circuitJson.filter((v): v is ObjectRecord => isObject(v) && v.type === "pcb_component");
  const pcbSourceIds = new Set(pcbRecords.map((v) => String(v.source_component_id)));
  // A schematicsymbol with chipRef may be a logical representation, not a second physical BOM part.
  // Synthetic netlist-only tests without PCB records continue to validate their components.
  const components = pcbRecords.length ? allComponents.filter((c) => pcbSourceIds.has(String(c.source_component_id))) : allComponents;
  const ports = circuitJson.filter((v): v is ObjectRecord => isObject(v) && v.type === "source_port");
  const names = new Map<string,string>();
  for (const c of components) {
    const name = required(c.name, "component reference");
    const id = required(c.source_component_id, "component id");
    if (names.has(name)) throw new Error("PARTS_INVALID: duplicate source component reference " + name);
    names.set(name,id);
  }
  const byRef = new Map<string,ObjectRecord>();
  for (const part of partsLock.parts) {
    if (!isObject(part)) throw new Error("PARTS_INVALID: invalid locked part");
    const reference = required(part.reference, "reference");
    if (byRef.has(reference)) throw new Error("PARTS_INVALID: duplicate part " + reference);
    byRef.set(reference, part);
  }
  for (const reference of byRef.keys()) {
    if (!names.has(reference)) throw new Error("PARTS_INVALID: locked part " + reference + " is absent from physical PCB components");
  }
  const entries: PartResolution["entries"] = [];
  const unresolved: string[] = [];
  for (const [reference, id] of [...names].sort(([a],[b])=>a.localeCompare(b))) {
    const part = byRef.get(reference);
    if (!part) throw new Error("PARTS_INVALID: no locked part entry for source component " + reference);
    const devicePorts = ports.filter((port) => port.source_component_id === id);
    const physicalPins = devicePorts.map((port)=>String(port.pin_number)).sort();
    if (physicalPins.length === 0 || physicalPins.some((pin)=>!/^\d+$/.test(pin)) || new Set(physicalPins).size !== physicalPins.length) {
      throw new Error("PARTS_INVALID: malformed or duplicate physical pins for " + reference);
    }
    const issues: string[] = [];
    const modelId = typeof part.simulation_model_id === "string" ? part.simulation_model_id : null;
    let modelVerified = false;
    if (modelId) {
      const model = models.get(modelId);
      if (!model) throw new Error("PARTS_MODEL_UNKNOWN: " + reference + " references nonexistent vendor model " + modelId);
      const terminalOrder = model.terminal_order;
      const pinMap = model.sot23_physical_pin_map;
      if (!Array.isArray(terminalOrder) || !isObject(pinMap)) throw new Error("PARTS_MODEL_INVALID: model has no terminal pin order");
      const expected = new Map<string,string>();
      for (const terminal of terminalOrder) {
        const label = required(terminal, "terminal name");
        const physical = required(pinMap[label], "physical pin for " + label);
        expected.set(label,physical);
      }
      const actual = new Map<string,string>();
      for (const port of devicePorts) {
        const labels = [String(port.name ?? ""), ...(Array.isArray(port.port_hints) ? port.port_hints.map(String) : [])];
        const semantic = [...new Set(labels.map(namedPin).filter((label): label is NonNullable<typeof label> => label !== null))];
        if (semantic.length > 1) throw new Error("PARTS_PIN_MISMATCH: ambiguous semantic aliases on " + reference + " pad " + port.pin_number);
        const alias = semantic[0] ?? null;
        if (alias !== null && actual.has(alias)) throw new Error("PARTS_PIN_MISMATCH: repeated " + alias + " port for " + reference);
        if (alias !== null) actual.set(alias,String(port.pin_number));
      }
      for (const [terminal, pin] of expected) {
        if (actual.get(terminal) !== pin) {
          throw new Error("PARTS_PIN_MISMATCH: " + reference + " " + terminal + " expected physical pad " + pin + ", TSX rendered " + (actual.get(terminal) ?? "<unknown>"));
        }
      }
      if (String(model.simulation_kind) !== "subckt" || !/^[a-f0-9]{64}$/.test(String(model.sha256))) throw new Error("PARTS_MODEL_INVALID: unsupported or unhashed model");
      modelVerified = true; // Verified graph-to-vendor pin mapping, not vendor model physics.
    } else issues.push("No vetted vendor SPICE model binding");
    if (part.pin_map_status !== "datasheet_reviewed") issues.push("Physical pin map not datasheet-reviewed");
    if (!part.manufacturer_part_number) issues.push("No exact manufacturer part number");
    if (!part.footprint) issues.push("No footprint identifier");
    if (issues.length) unresolved.push(reference + ": " + issues.join("; "));
    entries.push({
      reference,
      manufacturer_part_number: typeof part.manufacturer_part_number === "string" ? part.manufacturer_part_number : null,
      footprint: typeof part.footprint === "string" ? part.footprint : null,
      physical_pins: physicalPins,
      model_id: modelId,
      model_verified: modelVerified,
      pin_map_status: String(part.pin_map_status),
      issues,
    });
  }
  const verified = entries.every((item)=>item.issues.length === 0);
  return {
    schema_version: 1,
    status: verified ? "verified" : entries.some((item)=>item.model_verified) ? "partially_verified" : "unverified",
    entries,
    unresolved,
  };
}

export async function resolvePartsForBuild(
  circuitJson: readonly unknown[],
  partsLockBytes: Buffer,
  catalogPath: string,
): Promise<PartResolution> {
  const catalog = JSON.parse(await readFile(path.resolve(catalogPath), "utf8")) as unknown;
  const parts = JSON.parse(partsLockBytes.toString("utf8")) as unknown;
  return resolveParts(circuitJson, parts, catalog);
}

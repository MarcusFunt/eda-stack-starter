import * as ts from "typescript";

type ObjectRecord = Record<string, unknown>;

export interface SourceFileText {
  path: string;
  text: string;
}

export interface TypedConstraintRule {
  id?: string;
  kind?: string;
  target?: {
    type?: string;
    reference?: string;
    pin_number?: number;
    name?: string;
    id?: string;
  };
  property?: string;
  operator?: string;
  value?: unknown;
  hard?: boolean;
  source?: {
    path?: string;
    jsonPointer?: string;
  };
}

export interface TypedCircuitInput {
  circuitJson: unknown;
  pcbConstraints: unknown;
  sourceFiles: SourceFileText[];
  rules?: unknown[];
}

export interface TypedSourceLocation {
  path: string;
  line: number;
  column: number;
  recordId?: string;
  jsonPointer?: string;
}

export interface TypedCircuitComponent {
  id: string;
  reference: string;
  componentType: string | null;
  source: TypedSourceLocation;
}

export interface TypedPhysicalPad {
  pcbPortId: string;
  pcbComponentId: string | null;
  sourceComponentId: string | null;
  x: number;
  y: number;
  layers: string[];
}

export interface TypedCircuitPin {
  id: string;
  sourcePortId: string;
  componentId: string;
  reference: string;
  number: number;
  name: string | null;
  physicalPads: TypedPhysicalPad[];
  electricalAttributes: string[];
  source: TypedSourceLocation;
}

export interface TypedCircuitNet {
  id: string;
  name: string;
  kind: "ground" | "power" | "signal" | "unnamed";
  sourceNetIds: string[];
  pinIds: string[];
  source: TypedSourceLocation;
}

export interface TypedCircuitConstraint {
  id: string;
  kind: string;
  target: ObjectRecord;
  property: string;
  operator: string;
  value: unknown;
  hard: boolean;
  source: TypedSourceLocation;
}

export interface TypedCircuitIR {
  schemaVersion: 1;
  components: TypedCircuitComponent[];
  pins: TypedCircuitPin[];
  nets: TypedCircuitNet[];
  electricalRules: TypedCircuitConstraint[];
  physicalConstraints: TypedCircuitConstraint[];
  componentConstraints: TypedCircuitConstraint[];
  rules: TypedCircuitConstraint[];
}

export interface TypedConstraintDiagnostic {
  id: string;
  code: string;
  message: string;
  source: TypedSourceLocation;
  relatedSources?: TypedSourceLocation[];
}

export interface TypedCircuitResult {
  ir: TypedCircuitIR;
  diagnostics: TypedConstraintDiagnostic[];
}

const electricalPinAttributes = [
  "provides_power",
  "provides_ground",
  "requires_power",
  "requires_ground",
  "do_not_connect",
] as const;
const electricalNetAttributes = ["is_ground", "is_power", "is_positive_voltage_source"] as const;
const supportedOperators = new Set(["==", "!=", "<", "<=", ">", ">=", "in"]);
const numericOperators = new Set(["<", "<=", ">", ">=", "==", "!="]);

function isObject(value: unknown): value is ObjectRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function recordsOfType(records: ObjectRecord[], type: string): ObjectRecord[] {
  return records.filter((record) => record.type === type);
}

function locationAt(path: string, text: string, position: number, extra: Partial<TypedSourceLocation> = {}): TypedSourceLocation {
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.JSON);
  const coordinates = sourceFile.getLineAndCharacterOfPosition(Math.min(Math.max(position, 0), text.length));
  return { path, line: coordinates.line + 1, column: coordinates.character + 1, ...extra };
}

function jsonPointerPosition(text: string, pointer: string): number | null {
  if (pointer === "") return 0;
  if (!pointer.startsWith("/")) return null;
  const root = ts.parseJsonText("source.json", text);
  const statement = root.statements.find(ts.isExpressionStatement);
  if (!statement) return null;
  let current: ts.Node = statement.expression;
  const parts = pointer.slice(1).split("/");
  for (let index = 0; index < parts.length; index += 1) {
    const encodedPart = parts[index]!;
    const part = encodedPart.replaceAll("~1", "/").replaceAll("~0", "~");
    if (ts.isObjectLiteralExpression(current)) {
      const property = current.properties.find((candidate): candidate is ts.PropertyAssignment =>
        ts.isPropertyAssignment(candidate) &&
        ((ts.isIdentifier(candidate.name) && candidate.name.text === part) ||
          ((ts.isStringLiteral(candidate.name) || ts.isNumericLiteral(candidate.name)) && candidate.name.text === part)),
      );
      if (!property) return null;
      if (index === parts.length - 1) return property.name.getStart(root);
      current = property.initializer;
    } else if (ts.isArrayLiteralExpression(current)) {
      const arrayIndex = Number(part);
      if (!Number.isInteger(arrayIndex) || arrayIndex < 0 || arrayIndex >= current.elements.length) return null;
      const element = current.elements[arrayIndex]!;
      if (index === parts.length - 1) return element.getStart(root);
      current = element;
    } else {
      return null;
    }
  }
  return null;
}

function indexSourceFiles(sourceFiles: SourceFileText[]): {
  components: Map<string, TypedSourceLocation>;
  nets: Map<string, TypedSourceLocation>;
  files: Map<string, SourceFileText>;
} {
  const components = new Map<string, TypedSourceLocation>();
  const nets = new Map<string, TypedSourceLocation>();
  const files = new Map(sourceFiles.map((file) => [file.path, file]));
  for (const file of sourceFiles) {
    if (!file.path.endsWith(".tsx")) continue;
    const sourceFile = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node): void => {
      let opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement | null = null;
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) opening = node;
      if (opening) {
        let name: string | null = null;
        for (const attribute of opening.attributes.properties) {
          if (!ts.isJsxAttribute(attribute) || attribute.name.getText(sourceFile) !== "name") continue;
          if (attribute.initializer && ts.isStringLiteral(attribute.initializer)) name = attribute.initializer.text;
          if (attribute.initializer && ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression && ts.isStringLiteral(attribute.initializer.expression)) {
            name = attribute.initializer.expression.text;
          }
        }
        if (name) {
          const source = locationAt(file.path, file.text, opening.getStart(sourceFile));
          const tagName = opening.tagName.getText(sourceFile);
          if (tagName === "net") nets.set(name, source);
          else components.set(name, source);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return { components, nets, files };
}

function fallbackLocation(recordId?: string): TypedSourceLocation {
  return { path: "circuit.json", line: 1, column: 1, ...(recordId ? { recordId } : {}) };
}

function propertyLocation(
  sourceIndex: ReturnType<typeof indexSourceFiles>,
  path: string,
  jsonPointer: string,
  recordId?: string,
): TypedSourceLocation {
  const file = sourceIndex.files.get(path);
  if (!file) return { path, line: 1, column: 1, ...(recordId ? { recordId } : {}), jsonPointer };
  const position = jsonPointerPosition(file.text, jsonPointer);
  return position === null
    ? { path, line: 1, column: 1, ...(recordId ? { recordId } : {}), jsonPointer }
    : locationAt(path, file.text, position, { ...(recordId ? { recordId } : {}), jsonPointer });
}

function mapNetGroups(
  sourcePorts: ObjectRecord[],
  sourceNets: ObjectRecord[],
  sourceTraces: ObjectRecord[],
  portById: Map<string, TypedCircuitPin>,
  sourceNetLocations: Map<string, TypedSourceLocation>,
): TypedCircuitNet[] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    const knownParent = parent.get(id);
    if (!knownParent) {
      parent.set(id, id);
      return id;
    }
    if (knownParent === id) return id;
    const root = find(knownParent);
    parent.set(id, root);
    return root;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };
  const portNode = (id: string): string => "p:" + id;
  const netNode = (id: string): string => "n:" + id;

  for (const port of sourcePorts) {
    const id = stringValue(port.source_port_id);
    if (id) find(portNode(id));
  }
  for (const net of sourceNets) {
    const id = stringValue(net.source_net_id);
    if (id) find(netNode(id));
  }
  for (const trace of sourceTraces) {
    const connected = [
      ...(Array.isArray(trace.connected_source_port_ids) ? trace.connected_source_port_ids : []).filter((id): id is string => typeof id === "string").map(portNode),
      ...(Array.isArray(trace.connected_source_net_ids) ? trace.connected_source_net_ids : []).filter((id): id is string => typeof id === "string").map(netNode),
    ];
    for (const node of connected.slice(1)) union(connected[0]!, node);
  }

  const groups = new Map<string, { ports: string[]; nets: string[] }>();
  for (const port of sourcePorts) {
    const id = stringValue(port.source_port_id);
    if (!id) continue;
    const root = find(portNode(id));
    const group = groups.get(root) ?? { ports: [], nets: [] };
    group.ports.push(id);
    groups.set(root, group);
  }
  for (const net of sourceNets) {
    const id = stringValue(net.source_net_id);
    if (!id) continue;
    const root = find(netNode(id));
    const group = groups.get(root) ?? { ports: [], nets: [] };
    group.nets.push(id);
    groups.set(root, group);
  }

  const netById = new Map(sourceNets.map((net) => [stringValue(net.source_net_id), net] as const));
  return [...groups.values()].map((group) => {
    const portIds = group.ports.sort((left, right) => {
      const a = portById.get(left)!;
      const b = portById.get(right)!;
      return a.reference.localeCompare(b.reference) || a.number - b.number || left.localeCompare(right);
    });
    const sourceNetIds = group.nets.sort();
    const names = sourceNetIds.map((id) => stringValue(netById.get(id)?.name)).filter((name): name is string => name !== null).sort();
    const groupRecords = sourceNetIds.map((id) => netById.get(id)!).filter(Boolean);
    const isGround = groupRecords.some((record) => record.is_ground === true);
    const isPower = groupRecords.some((record) => record.is_power === true || record.is_positive_voltage_source === true);
    const name = names.join("|");
    const firstPin = portIds.map((id) => portById.get(id)).find(Boolean);
    const source = names.length > 0
      ? sourceNetLocations.get(names[0]!) ?? (firstPin?.source ?? fallbackLocation(sourceNetIds[0] ?? undefined))
      : firstPin?.source ?? fallbackLocation(sourceNetIds[0] ?? undefined);
    const sourceNetId = sourceNetIds[0];
    const id = sourceNetId ?? "derived:" + portIds.join("+");
    return {
      id,
      name,
      kind: isGround ? "ground" as const : isPower ? "power" as const : name ? "signal" as const : "unnamed" as const,
      sourceNetIds,
      pinIds: portIds,
      source,
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function makeConstraint(
  id: string,
  kind: string,
  target: ObjectRecord,
  property: string,
  operator: string,
  value: unknown,
  hard: boolean,
  source: TypedSourceLocation,
): TypedCircuitConstraint {
  return { id, kind, target, property, operator, value, hard, source };
}

function validateRules(
  rules: unknown[],
  sourceIndex: ReturnType<typeof indexSourceFiles>,
  components: TypedCircuitComponent[],
  pins: TypedCircuitPin[],
  nets: TypedCircuitNet[],
  baseConstraints: TypedCircuitConstraint[],
): { normalized: TypedCircuitConstraint[]; diagnostics: TypedConstraintDiagnostic[] } {
  const normalized: TypedCircuitConstraint[] = [];
  const diagnostics: TypedConstraintDiagnostic[] = [];
  const seenIds = new Map<string, TypedSourceLocation>();
  const componentRefs = new Set(components.map((component) => component.reference));
  const pinRefs = new Set(pins.map((pin) => pin.reference + ":" + pin.number));
  const netIds = new Set(nets.map((net) => net.id));
  const netNames = new Set(nets.flatMap((net) => net.name ? net.name.split("|") : []));
  const numericGroups = new Map<string, TypedCircuitConstraint[]>();
  const seenRules = new Map<string, TypedSourceLocation>();

  const addNumericRule = (rule: TypedCircuitConstraint): void => {
    if (!rule.hard || (!numericOperators.has(rule.operator) && rule.operator !== "in")) return;
    const targetType = stringValue(rule.target.type);
    const key = JSON.stringify([targetType, rule.target.reference ?? rule.target.name ?? rule.target.id ?? "", rule.target.pin_number ?? null, rule.property]);
    const group = numericGroups.get(key) ?? [];
    group.push(rule);
    numericGroups.set(key, group);
  };
  for (const constraint of baseConstraints) addNumericRule(constraint);

  for (let index = 0; index < rules.length; index += 1) {
    const raw = rules[index];
    if (!isObject(raw)) {
      diagnostics.push({
        id: "rule-" + index,
        code: "INVALID_CONSTRAINT",
        message: "Constraint must be an object.",
        source: fallbackLocation(),
      });
      continue;
    }
    const rule = raw as TypedConstraintRule;
    const id = stringValue(rule.id) ?? "rule-" + index;
    const kind = stringValue(rule.kind) ?? "unknown";
    const target = isObject(rule.target) ? rule.target : {};
    const property = stringValue(rule.property) ?? "";
    const operator = stringValue(rule.operator) ?? "";
    const source = rule.source?.path
      ? propertyLocation(sourceIndex, rule.source.path, rule.source.jsonPointer ?? "", id)
      : fallbackLocation(id);
    const normalizedRule = makeConstraint(id, kind, target, property, operator, rule.value, rule.hard !== false, source);
    normalized.push(normalizedRule);

    if (seenIds.has(id)) {
      diagnostics.push({ id, code: "DUPLICATE_CONSTRAINT_ID", message: "Constraint ID '" + id + "' is used more than once.", source, relatedSources: [seenIds.get(id)!] });
    } else {
      seenIds.set(id, source);
    }
    const canonicalRule = JSON.stringify([
      kind,
      target.type ?? null,
      target.reference ?? null,
      target.pin_number ?? null,
      target.name ?? null,
      target.id ?? null,
      property,
      operator,
      rule.value,
      rule.hard !== false,
    ]);
    const priorRuleSource = seenRules.get(canonicalRule);
    if (priorRuleSource) {
      diagnostics.push({ id, code: "DUPLICATE_CONSTRAINT", message: "An equivalent constraint is already declared.", source, relatedSources: [priorRuleSource] });
    } else {
      seenRules.set(canonicalRule, source);
    }
    if (!supportedOperators.has(operator)) {
      diagnostics.push({ id, code: "UNSUPPORTED_OPERATOR", message: "Operator '" + operator + "' is not supported.", source });
    }
    if (kind !== "electrical" && kind !== "physical" && kind !== "component") {
      diagnostics.push({ id, code: "UNSUPPORTED_CONSTRAINT_KIND", message: "Constraint kind '" + kind + "' is not supported.", source });
    }

    const targetType = stringValue(target.type);
    if (targetType === "component" && !componentRefs.has(stringValue(target.reference) ?? "")) {
      diagnostics.push({ id, code: "MISSING_COMPONENT_REFERENCE", message: "Constraint references a component that is not present in Circuit JSON.", source });
    } else if (targetType === "pin") {
      const reference = stringValue(target.reference) ?? "";
      const pinNumber = numberValue(target.pin_number);
      if (pinNumber === null || !pinRefs.has(reference + ":" + pinNumber)) {
        diagnostics.push({ id, code: "MISSING_PIN_REFERENCE", message: "Constraint references a pin that is not present in Circuit JSON.", source });
      }
    } else if (targetType === "net" && !netIds.has(stringValue(target.id) ?? "") && !netNames.has(stringValue(target.name) ?? "")) {
      diagnostics.push({ id, code: "MISSING_NET_REFERENCE", message: "Constraint references a net that is not present in Circuit JSON.", source });
    } else if (targetType !== "board" && targetType !== "component" && targetType !== "pin" && targetType !== "net") {
      diagnostics.push({ id, code: "UNSUPPORTED_TARGET_TYPE", message: "Constraint target type is unsupported.", source });
    }

    const numericValue = numberValue(rule.value);
    const numericSet = Array.isArray(rule.value) && rule.value.every((value) => numberValue(value) !== null);
    if ((numericValue !== null && numericOperators.has(operator)) || (operator === "in" && numericSet)) addNumericRule(normalizedRule);
  }

  for (const group of numericGroups.values()) {
    const numericRules = group.filter((rule) => numericOperators.has(rule.operator) && numberValue(rule.value) !== null);
    const setRules = group.filter((rule) => rule.operator === "in" && Array.isArray(rule.value) && rule.value.every((value) => numberValue(value) !== null));
    const accepts = (candidate: number, rule: TypedCircuitConstraint): boolean => {
      const value = numberValue(rule.value);
      switch (rule.operator) {
        case "==": return value === candidate;
        case "!=": return value !== candidate;
        case "<": return candidate < value!;
        case "<=": return candidate <= value!;
        case ">": return candidate > value!;
        case ">=": return candidate >= value!;
        case "in": return Array.isArray(rule.value) && rule.value.includes(candidate);
        default: return true;
      }
    };
    const equalityCandidates = numericRules.filter((rule) => rule.operator === "==").map((rule) => numberValue(rule.value)!);
    const allowedSets = setRules.map((rule) => rule.value as number[]);
    let candidates: number[] | null = null;
    if (equalityCandidates.length > 0) candidates = [...new Set(equalityCandidates)];
    else if (allowedSets.length > 0) candidates = [...new Set(allowedSets[0]!)].filter((candidate) => allowedSets.every((set) => set.includes(candidate)));

    let conflictRule: TypedCircuitConstraint | null = null;
    if (candidates) {
      if (candidates.filter((candidate) => group.every((rule) => accepts(candidate, rule))).length === 0) {
        conflictRule = group[group.length - 1] ?? null;
      }
    } else {
      let lower: { value: number; inclusive: boolean; rule: TypedCircuitConstraint } | null = null;
      let upper: { value: number; inclusive: boolean; rule: TypedCircuitConstraint } | null = null;
      const exclusions = numericRules.filter((rule) => rule.operator === "!=" && numberValue(rule.value) !== null).map((rule) => numberValue(rule.value)!);
      for (const rule of numericRules) {
        const value = numberValue(rule.value)!;
        if (rule.operator === ">" || rule.operator === ">=") {
          const bound = { value, inclusive: rule.operator === ">=", rule };
          if (!lower || bound.value > lower.value || (bound.value === lower.value && !bound.inclusive)) lower = bound;
        } else if (rule.operator === "<" || rule.operator === "<=") {
          const bound = { value, inclusive: rule.operator === "<=", rule };
          if (!upper || bound.value < upper.value || (bound.value === upper.value && !bound.inclusive)) upper = bound;
        }
      }
      if (lower && upper && (lower.value > upper.value || (lower.value === upper.value && (!lower.inclusive || !upper.inclusive)))) conflictRule = upper.rule;
      if (lower && upper && lower.value === upper.value && lower.inclusive && upper.inclusive && exclusions.includes(lower.value)) {
        conflictRule = numericRules.find((rule) => rule.operator === "!=" && numberValue(rule.value) === lower!.value) ?? upper.rule;
      }
    }
    if (conflictRule) {
      const target = conflictRule.target;
      const targetLabel = stringValue(target.type) === "board"
        ? "board"
        : stringValue(target.reference) ?? stringValue(target.name) ?? stringValue(target.id) ?? "unknown";
      const diagnosticId = "infeasible:" + targetLabel + ":" + conflictRule.property;
      const first = group.find((rule) => rule !== conflictRule) ?? conflictRule;
      diagnostics.push({
        id: diagnosticId,
        code: "INFEASIBLE_HARD_CONSTRAINTS",
        message: "Hard numeric constraints for the same target and property have no common value.",
        source: conflictRule.source,
        relatedSources: [first.source],
      });
    }
  }

  return { normalized, diagnostics };
}

export function buildTypedCircuitIR(input: TypedCircuitInput): TypedCircuitResult {
  if (!Array.isArray(input.circuitJson)) throw new Error("circuitJson must be an array of Circuit JSON records");
  if (!isObject(input.pcbConstraints)) throw new Error("pcbConstraints must be an object");
  const records = input.circuitJson.filter(isObject);
  const sourceIndex = indexSourceFiles(input.sourceFiles);
  const sourceLocationDiagnostics: TypedConstraintDiagnostic[] = [];
  const sourceComponents = recordsOfType(records, "source_component");
  const sourcePorts = recordsOfType(records, "source_port");
  const sourceNets = recordsOfType(records, "source_net");
  const sourceTraces = recordsOfType(records, "source_trace");
  const pcbComponents = recordsOfType(records, "pcb_component");
  const pcbPorts = recordsOfType(records, "pcb_port");
  const componentById = new Map<string, TypedCircuitComponent>();
  const components = sourceComponents.map((record) => {
    const id = stringValue(record.source_component_id) ?? "";
    const reference = stringValue(record.name) ?? id;
    const source = sourceIndex.components.get(reference);
    if (!source) {
      sourceLocationDiagnostics.push({
        id: "source-location:component:" + id,
        code: "SOURCE_LOCATION_MISSING",
        message: "No TSX source location was found for component '" + reference + "'.",
        source: fallbackLocation(id),
      });
    }
    const component: TypedCircuitComponent = {
      id,
      reference,
      componentType: stringValue(record.ftype),
      source: { ...(source ?? fallbackLocation(id)), recordId: id },
    };
    componentById.set(id, component);
    return component;
  }).sort((left, right) => left.reference.localeCompare(right.reference));

  const pcbComponentById = new Map(pcbComponents.map((component) => [stringValue(component.pcb_component_id), component] as const));
  const pcbPortsBySourcePort = new Map<string, ObjectRecord[]>();
  for (const port of pcbPorts) {
    const sourcePortId = stringValue(port.source_port_id);
    if (!sourcePortId) continue;
    const found = pcbPortsBySourcePort.get(sourcePortId) ?? [];
    found.push(port);
    pcbPortsBySourcePort.set(sourcePortId, found);
  }

  const ports: TypedCircuitPin[] = sourcePorts.map((record) => {
    const id = stringValue(record.source_port_id) ?? "";
    const componentId = stringValue(record.source_component_id) ?? "";
    const component = componentById.get(componentId);
    const reference = component?.reference ?? componentId;
    const pinNumber = numberValue(record.pin_number) ?? 0;
    const source = component?.source ?? fallbackLocation(id);
    const physicalPads = (pcbPortsBySourcePort.get(id) ?? []).map((pcbPort) => {
      const pcbComponentId = stringValue(pcbPort.pcb_component_id);
      const pcbComponent = pcbComponentId ? pcbComponentById.get(pcbComponentId) : undefined;
      return {
        pcbPortId: stringValue(pcbPort.pcb_port_id) ?? "",
        pcbComponentId: pcbComponentId ?? null,
        sourceComponentId: stringValue(pcbComponent?.source_component_id),
        x: numberValue(pcbPort.x) ?? 0,
        y: numberValue(pcbPort.y) ?? 0,
        layers: Array.isArray(pcbPort.layers) ? pcbPort.layers.filter((layer): layer is string => typeof layer === "string").sort() : [],
      };
    }).sort((left, right) => left.pcbPortId.localeCompare(right.pcbPortId));
    const electricalAttributes = electricalPinAttributes.filter((attribute) => record[attribute] === true);
    return {
      id,
      sourcePortId: id,
      componentId,
      reference,
      number: pinNumber,
      name: stringValue(record.name),
      physicalPads,
      electricalAttributes: [...electricalAttributes],
      source: { ...source, recordId: id },
    };
  }).sort((left, right) => left.reference.localeCompare(right.reference) || left.number - right.number || left.id.localeCompare(right.id));
  const pinById = new Map(ports.map((pin) => [pin.sourcePortId, pin] as const));

  const sourceNetLocations = new Map<string, TypedSourceLocation>();
  for (const record of sourceNets) {
    const name = stringValue(record.name);
    const id = stringValue(record.source_net_id);
    if (name && !sourceNetLocations.has(name)) {
      const source = sourceIndex.nets.get(name);
      if (!source) {
        sourceLocationDiagnostics.push({
          id: "source-location:net:" + (id ?? name),
          code: "SOURCE_LOCATION_MISSING",
          message: "No TSX source location was found for named net '" + name + "'.",
          source: fallbackLocation(id ?? undefined),
        });
      }
      sourceNetLocations.set(name, source ?? fallbackLocation(id ?? undefined));
    }
  }
  const nets = mapNetGroups(sourcePorts, sourceNets, sourceTraces, pinById, sourceNetLocations);

  const diagnostics: TypedConstraintDiagnostic[] = [...sourceLocationDiagnostics];
  for (const pin of ports) {
    if (pin.physicalPads.length === 0) {
      diagnostics.push({
        id: "physical-pad:" + pin.sourcePortId,
        code: "PIN_PHYSICAL_PAD_MISSING",
        message: "Source pin " + pin.reference + ":" + pin.number + " has no matching physical PCB port.",
        source: pin.source,
      });
    }
    for (const pad of pin.physicalPads) {
      if (pad.sourceComponentId === pin.componentId) continue;
      diagnostics.push({
        id: "physical-pad-component:" + pad.pcbPortId,
        code: "PHYSICAL_PAD_COMPONENT_MISMATCH",
        message: pad.sourceComponentId
          ? "Physical PCB port " + pad.pcbPortId + " belongs to a different source component."
          : "Physical PCB port " + pad.pcbPortId + " has no source component mapping.",
        source: pin.source,
      });
    }
  }

  const electricalRules: TypedCircuitConstraint[] = [];
  for (const pin of ports) {
    for (const attribute of pin.electricalAttributes) {
      electricalRules.push(makeConstraint(
        "electrical:pin:" + pin.sourcePortId + ":" + attribute,
        "electrical",
        { type: "pin", reference: pin.reference, pin_number: pin.number, source_port_id: pin.sourcePortId },
        attribute,
        "==",
        true,
        true,
        pin.source,
      ));
    }
  }
  for (const net of nets) {
    const record = sourceNets.find((candidate) => stringValue(candidate.source_net_id) === net.sourceNetIds[0]);
    if (!record) continue;
    for (const attribute of electricalNetAttributes) {
      if (record[attribute] !== true) continue;
      electricalRules.push(makeConstraint(
        "electrical:net:" + net.id + ":" + attribute,
        "electrical",
        { type: "net", id: net.id, name: net.name },
        attribute,
        "==",
        true,
        true,
        net.source,
      ));
    }
  }

  const physicalConstraints: TypedCircuitConstraint[] = [];
  const board = isObject(input.pcbConstraints.board) ? input.pcbConstraints.board : {};
  const constraintFile = input.sourceFiles.find((file) => file.path.endsWith("pcb.constraints.json"))?.path ?? "pcb.constraints.json";
  for (const property of ["width_mm", "height_mm", "layers"] as const) {
    const value = board[property];
    if (typeof value !== "number") continue;
    physicalConstraints.push(makeConstraint(
      "physical:board:" + property,
      "physical",
      { type: "board" },
      property,
      "==",
      value,
      true,
      propertyLocation(sourceIndex, constraintFile, "/board/" + property, "physical:board:" + property),
    ));
  }
  if (Array.isArray(input.pcbConstraints.keepouts)) {
    input.pcbConstraints.keepouts.forEach((keepout, index) => {
      physicalConstraints.push(makeConstraint(
        "physical:keepout:" + index,
        "physical",
        { type: "board" },
        "keepout",
        "==",
        keepout,
        true,
        propertyLocation(sourceIndex, constraintFile, "/keepouts/" + index, "physical:keepout:" + index),
      ));
    });
  }

  const componentConstraints: TypedCircuitConstraint[] = [];
  const fixedComponents = Array.isArray(input.pcbConstraints.fixed_components) ? input.pcbConstraints.fixed_components : [];
  const seenFixed = new Set<string>();
  fixedComponents.forEach((reference, index) => {
    if (typeof reference !== "string") return;
    const id = "component:fixed:" + reference;
    const source = propertyLocation(sourceIndex, constraintFile, "/fixed_components/" + index, id);
    if (seenFixed.has(reference)) {
      diagnostics.push({ id, code: "DUPLICATE_COMPONENT_CONSTRAINT", message: "Component '" + reference + "' is fixed more than once.", source });
      return;
    }
    seenFixed.add(reference);
    if (!components.some((component) => component.reference === reference)) {
      diagnostics.push({ id, code: "MISSING_COMPONENT_REFERENCE", message: "Fixed component '" + reference + "' is not present in Circuit JSON.", source });
    }
    componentConstraints.push(makeConstraint(id, "component", { type: "component", reference }, "fixed", "==", true, true, source));
  });

  const userRules = validateRules(input.rules ?? [], sourceIndex, components, ports, nets, physicalConstraints);
  diagnostics.push(...userRules.diagnostics);
  for (const rule of userRules.normalized) {
    if (rule.kind === "electrical") electricalRules.push(rule);
    else if (rule.kind === "physical") physicalConstraints.push(rule);
    else if (rule.kind === "component") componentConstraints.push(rule);
  }
  diagnostics.sort((left, right) => left.code.localeCompare(right.code) || left.id.localeCompare(right.id) || left.source.path.localeCompare(right.source.path));

  return {
    ir: {
      schemaVersion: 1,
      components,
      pins: ports,
      nets,
      electricalRules: electricalRules.sort((left, right) => left.id.localeCompare(right.id)),
      physicalConstraints: physicalConstraints.sort((left, right) => left.id.localeCompare(right.id)),
      componentConstraints: componentConstraints.sort((left, right) => left.id.localeCompare(right.id)),
      rules: userRules.normalized.sort((left, right) => left.id.localeCompare(right.id)),
    },
    diagnostics,
  };
}

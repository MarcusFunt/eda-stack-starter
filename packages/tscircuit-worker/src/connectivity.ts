export type PinNetGroup = {
  netNames: string[];
  pins: string[];
};

type JsonRecord = Record<string, unknown>;

function recordsOfType(circuitJson: readonly unknown[], type: string): JsonRecord[] {
  return circuitJson.filter(
    (item): item is JsonRecord =>
      typeof item === "object" && item !== null && (item as JsonRecord).type === type,
  );
}

function requiredString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Circuit JSON " + description + " is missing");
  }
  return value;
}

/**
 * Reconstruct physical pin membership from source components, ports, nets,
 * and traces. Net names are retained for diagnostics but are not the identity
 * used by the native KiCad equivalence check.
 */
export function sourcePinNetGroups(circuitJson: readonly unknown[]): PinNetGroup[] {
  if (!Array.isArray(circuitJson)) throw new Error("Circuit JSON must be an array");

  const components = recordsOfType(circuitJson, "source_component");
  const ports = recordsOfType(circuitJson, "source_port");
  const nets = recordsOfType(circuitJson, "source_net");
  const traces = recordsOfType(circuitJson, "source_trace");
  if (components.length === 0) throw new Error("Circuit JSON has no source components");
  if (ports.length === 0) throw new Error("Circuit JSON has no source ports");
  if (nets.length === 0) throw new Error("Circuit JSON has no source nets");

  const componentNames = new Map<string, string>();
  const refs = new Set<string>();
  for (const component of components) {
    const id = requiredString(component.source_component_id, "source component identity");
    const name = requiredString(component.name, "source component reference");
    if (componentNames.has(id)) throw new Error("Circuit JSON has duplicate source component identity " + id);
    if (refs.has(name)) throw new Error("Circuit JSON has duplicate component reference " + name);
    componentNames.set(id, name);
    refs.add(name);
  }

  const parent = new Map<string, string>();
  const find = (identity: string): string => {
    const current = parent.get(identity);
    if (current === undefined) throw new Error("Circuit JSON trace refers to unknown port/net identity " + identity);
    if (current !== identity) parent.set(identity, find(current));
    return parent.get(identity)!;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  };

  const portPins = new Map<string, string>();
  const pinsByComponent = new Map<string, Set<string>>();
  for (const port of ports) {
    const id = requiredString(port.source_port_id, "source port identity");
    const componentId = requiredString(port.source_component_id, "source port component identity");
    const componentName = componentNames.get(componentId);
    if (!componentName) throw new Error("Circuit JSON source port refers to unknown component " + componentId);
    const pinNumber = port.pin_number;
    if (!(typeof pinNumber === "number" && Number.isInteger(pinNumber) && pinNumber > 0) &&
        !(typeof pinNumber === "string" && /^[0-9]+$/.test(pinNumber) && Number(pinNumber) > 0)) {
      throw new Error("Circuit JSON source port " + id + " has an invalid physical pin number");
    }
    if (parent.has("port:" + id)) throw new Error("Circuit JSON has duplicate source port identity " + id);
    const physicalPin = String(pinNumber);
    const componentPins = pinsByComponent.get(componentId) ?? new Set<string>();
    if (componentPins.has(physicalPin)) {
      throw new Error("Circuit JSON pad collision: " + componentName + " has duplicate physical pin " + physicalPin);
    }
    componentPins.add(physicalPin);
    pinsByComponent.set(componentId, componentPins);
    portPins.set(id, componentName + ":" + physicalPin);
    parent.set("port:" + id, "port:" + id);
  }

  const netNames = new Map<string, string>();
  for (const net of nets) {
    const id = requiredString(net.source_net_id, "source net identity");
    const name = requiredString(net.name, "source net name");
    if (parent.has("net:" + id)) throw new Error("Circuit JSON has duplicate source net identity " + id);
    parent.set("net:" + id, "net:" + id);
    netNames.set(id, name);
  }

  for (const trace of traces) {
    const portIds = trace.connected_source_port_ids;
    const netIds = trace.connected_source_net_ids;
    if (portIds !== undefined && !Array.isArray(portIds)) {
      throw new Error("Circuit JSON source trace has an invalid port identity list");
    }
    if (netIds !== undefined && !Array.isArray(netIds)) {
      throw new Error("Circuit JSON source trace has an invalid net identity list");
    }
    const identities = [
      ...(portIds as unknown[] | undefined ?? []).map((id) => "port:" + requiredString(id, "trace port identity")),
      ...(netIds as unknown[] | undefined ?? []).map((id) => "net:" + requiredString(id, "trace net identity")),
    ];
    for (const identity of identities) find(identity);
    for (const identity of identities.slice(1)) union(identities[0], identity);
  }

  const groups = new Map<string, PinNetGroup>();
  for (const [portId, pin] of portPins) {
    const root = find("port:" + portId);
    const group = groups.get(root) ?? { netNames: [], pins: [] };
    group.pins.push(pin);
    groups.set(root, group);
  }
  for (const [netId, name] of netNames) {
    const root = find("net:" + netId);
    const group = groups.get(root);
    if (!group) throw new Error("Circuit JSON source net " + name + " is not connected to a physical pin");
    group.netNames.push(name);
  }

  const result = [...groups.values()].map((group) => ({
    netNames: [...new Set(group.netNames)].sort(),
    pins: [...new Set(group.pins)].sort(),
  }));
  return result.sort((left, right) =>
    (left.netNames.join("\u0000") || left.pins[0] || "").localeCompare(right.netNames.join("\u0000") || right.pins[0] || ""),
  );
}

function findFormEnd(text: string, start: number): number {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  throw new Error("Unbalanced KiCad netlist S-expression");
}

function quotedField(form: string, field: string): string {
  const match = form.match(new RegExp("\\(" + field + "\\s+(\"(?:\\\\.|[^\"\\\\])*\")\\)"));
  if (!match) throw new Error("KiCad netlist entry is missing " + field);
  return JSON.parse(match[1]) as string;
}

export function parseKicadNetlistPinNetGroups(text: string): PinNetGroup[] {
  if (typeof text !== "string") throw new Error("KiCad netlist must be text");
  const start = text.indexOf("(nets");
  if (start < 0) throw new Error("KiCad netlist is missing its nets section");
  const sectionEnd = findFormEnd(text, start);
  const groups: PinNetGroup[] = [];
  const memberOwners = new Map<string, string>();
  let cursor = start + "(nets".length;
  while (cursor < sectionEnd - 1) {
    while (/\s/.test(text[cursor] ?? "")) cursor += 1;
    if (text[cursor] !== "(") break;
    const formEnd = findFormEnd(text, cursor);
    const form = text.slice(cursor, formEnd);
    if (form.startsWith("(net")) {
      const netName = quotedField(form, "name");
      const pins = [
        ...form.matchAll(/\(node\s+\(ref\s+("(?:\\.|[^"\\])*")\)\s+\(pin\s+("(?:\\.|[^"\\])*")\)/g),
      ].map((match) => JSON.parse(match[1]) + ":" + JSON.parse(match[2])).sort();
      if (pins.length === 0) throw new Error("KiCad net " + netName + " has no physical pin membership");
      for (const pin of pins) {
        const previous = memberOwners.get(pin);
        if (previous) throw new Error("KiCad physical pin " + pin + " appears on multiple nets: " + previous + ", " + netName);
        memberOwners.set(pin, netName);
      }
      groups.push({ netNames: [netName], pins });
    }
    cursor = formEnd;
  }
  if (groups.length === 0) throw new Error("KiCad netlist has no physical pin nets");
  return groups.sort((left, right) => left.netNames[0].localeCompare(right.netNames[0]));
}

function normalizedMembership(groups: readonly PinNetGroup[], label: string): string[] {
  if (!Array.isArray(groups)) throw new Error(label + " pin-net membership must be an array");
  const seenPins = new Set<string>();
  const normalized = groups.map((group) => {
    if (!Array.isArray(group.pins) || group.pins.length === 0) {
      throw new Error(label + " pin-net group must contain at least one physical pin");
    }
    const pins = [...group.pins].sort();
    for (const pin of pins) {
      if (typeof pin !== "string" || pin.length === 0) throw new Error(label + " has an invalid physical pin");
      if (seenPins.has(pin)) throw new Error(label + " repeats physical pin " + pin);
      seenPins.add(pin);
    }
    return JSON.stringify(pins);
  });
  return normalized.sort();
}

export function assertPinNetMembership(
  expected: readonly PinNetGroup[],
  actual: readonly PinNetGroup[],
): void {
  const expectedGroups = normalizedMembership(expected, "Circuit JSON");
  const actualGroups = normalizedMembership(actual, "KiCad");
  if (JSON.stringify(expectedGroups) !== JSON.stringify(actualGroups)) {
    throw new Error(
      "KiCad pin-net connectivity does not match Circuit JSON membership; expected " +
        expectedGroups.join(" | ") + "; got " + actualGroups.join(" | "),
    );
  }
}

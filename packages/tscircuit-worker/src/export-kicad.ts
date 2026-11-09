import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Label, parseKicadSch, Xy } from "kicadts";
import {
  CircuitJsonToKicadLibraryConverter,
  CircuitJsonToKicadPcbConverter,
  CircuitJsonToKicadProConverter,
  CircuitJsonToKicadSchConverter,
} from "circuit-json-to-kicad";
import { assertPinNetMembership, sourcePinNetGroups, type PinNetGroup } from "./connectivity.js";

const CONVERTER_PACKAGE = "circuit-json-to-kicad";
const EXPECTED_CONVERTER_VERSION = "0.0.270";
const ERC_CHECKS_DISABLED_BY_KICAD_DEFAULTS = [
  "footprint_filter",
  "four_way_junction",
  "simulation_model_issue",
  "single_global_label",
] as const;
const NATIVE_SCHEMATIC_GRID_MM = 1.27;
const NATIVE_SCHEMATIC_COORDINATE_PRECISION = 6;

export type ExportKicadOptions = {
  circuitJson: readonly unknown[];
  outputDir: string;
  projectName: string;
};

export type ExportKicadResult = {
  outputDir: string;
  files: string[];
  circuitJsonSha256: string;
  sourcePinNetGroups: PinNetGroup[];
};

function validateProjectName(projectName: string): void {
  if (typeof projectName !== "string" || !/^[A-Za-z0-9_-]+$/.test(projectName)) {
    throw new Error("KiCad project name must contain only letters, numbers, underscores, or hyphens");
  }
}

function validateCircuitJson(circuitJson: readonly unknown[]): PinNetGroup[] {
  if (!Array.isArray(circuitJson) || circuitJson.length === 0) {
    throw new Error("Circuit JSON must be a non-empty array");
  }
  return sourcePinNetGroups(circuitJson);
}

function normalizeArtifactPath(filename: string): string {
  if (typeof filename !== "string" || filename.trim().length === 0) {
    throw new Error("KiCad converter returned an artifact without a filename");
  }
  const portable = filename.replaceAll("\\", "/");
  const segments = portable.split("/");
  if (
    portable.startsWith("/") ||
    /^[A-Za-z]:/.test(portable) ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("KiCad converter returned an unsafe artifact path: " + filename);
  }
  return segments.join("/");
}

function addArtifact(artifacts: Map<string, string>, filename: string, content: string): void {
  const normalized = normalizeArtifactPath(filename);
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("KiCad converter returned empty content for " + normalized);
  }
  if (artifacts.has(normalized)) throw new Error("KiCad converter returned duplicate artifact path " + normalized);
  artifacts.set(normalized, content);
}

function matchingClose(text: string, start: number): number {
  if (text[start] !== "(") throw new Error("Expected a KiCad S-expression at offset " + start);
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
  throw new Error("Unbalanced KiCad schematic S-expression");
}

function directChildForms(form: string): string[] {
  const formEnd = matchingClose(form, 0);
  const children: string[] = [];
  let cursor = 1;
  while (cursor < formEnd - 1 && !/\s/.test(form[cursor] ?? "")) cursor += 1;
  while (cursor < formEnd - 1) {
    while (/\s/.test(form[cursor] ?? "")) cursor += 1;
    if (cursor >= formEnd - 1) break;
    if (form[cursor] !== "(") throw new Error("Unexpected atom in KiCad symbol library section");
    const childEnd = matchingClose(form, cursor);
    children.push(form.slice(cursor, childEnd));
    cursor = childEnd;
  }
  return children;
}

function quotedSymbolName(form: string): string {
  const match = form.match(/^\(symbol\s+("(?:\\.|[^"\\])*")/);
  if (!match) throw new Error("Embedded KiCad symbol is missing its quoted name");
  return JSON.parse(match[1]) as string;
}

function propertyValue(form: string, propertyName: string): string | undefined {
  const escapedName = propertyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`\\(property\\s+"${escapedName}"\\s+("(?:\\\\.|[^"\\\\])*")`).exec(form);
  return match ? JSON.parse(match[1]) as string : undefined;
}

function replacePropertyValue(form: string, propertyName: string, value: string): string {
  const escapedName = propertyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(\\(property\\s+"${escapedName}"\\s+)"(?:\\\\.|[^"\\\\])*"`);
  if (!pattern.test(form)) throw new Error("KiCad symbol is missing the " + propertyName + " property");
  return form.replace(pattern, (_whole, prefix: string) => prefix + JSON.stringify(value));
}

function mapSymbolForms(text: string, transform: (form: string) => string): string {
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  for (const match of text.matchAll(/\(symbol(?=\s)/g)) {
    const start = match.index!;
    const end = matchingClose(text, start);
    const form = text.slice(start, end);
    if (form.includes("(lib_id ")) replacements.push({ start, end, text: transform(form) });
  }
  for (const replacement of replacements.reverse()) {
    text = text.slice(0, replacement.start) + replacement.text + text.slice(replacement.end);
  }
  return text;
}

function generatedFootprintByReference(
  circuitJson: readonly unknown[],
  footprints: readonly { footprintName: string }[],
): Map<string, string> {
  const records = circuitJson.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  const sources = new Map(
    records
      .filter((record) => record.type === "source_component" && typeof record.source_component_id === "string")
      .map((record) => [record.source_component_id as string, record]),
  );
  const available = new Set(footprints.map((footprint) => footprint.footprintName));
  const result = new Map<string, string>();
  for (const cad of records.filter((record) => record.type === "cad_component")) {
    if (typeof cad.source_component_id !== "string" || typeof cad.footprinter_string !== "string") continue;
    const source = sources.get(cad.source_component_id);
    if (!source || typeof source.name !== "string" || typeof source.ftype !== "string") continue;
    const prefix = source.ftype.replace(/^simple_/, "");
    const rawFootprintName = typeof source.manufacturer_part_number === "string" && source.manufacturer_part_number
      ? source.manufacturer_part_number
      : prefix + "_" + cad.footprinter_string;
    const footprintName = rawFootprintName.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").trim();
    if (!available.has(footprintName)) {
      throw new Error("Could not match Circuit JSON footprint " + footprintName + " to an exported KiCad footprint");
    }
    result.set(source.name, footprintName);
  }
  return result;
}

function applyLibraryFootprintFilters(
  schematic: string,
  footprintsBySymbol: Map<string, Set<string>>,
): string {
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  for (const match of schematic.matchAll(/\(symbol\s+("(?:\\.|[^"\\])*")/g)) {
    const start = match.index!;
    const end = matchingClose(schematic, start);
    const form = schematic.slice(start, end);
    const footprintNames = footprintsBySymbol.get(JSON.parse(match[1]) as string);
    if (!footprintNames) continue;
    const filter = propertyValue(form, "ki_fp_filters");
    if (filter === undefined) throw new Error("KiCad library symbol is missing the ki_fp_filters property");
    const filters = new Set(filter.split(/\s+/).filter(Boolean));
    for (const footprintName of footprintNames) filters.add(footprintName);
    replacements.push({
      start,
      end,
      text: replacePropertyValue(form, "ki_fp_filters", [...filters].join(" ")),
    });
  }
  for (const replacement of replacements.reverse()) {
    schematic = schematic.slice(0, replacement.start) + replacement.text + schematic.slice(replacement.end);
  }
  return schematic;
}

function applyFootprintBindings(
  schematicFiles: Array<{ filename: string; content: string }>,
  circuitJson: readonly unknown[],
  footprints: readonly { footprintName: string }[],
): Array<{ filename: string; content: string }> {
  const footprintByReference = generatedFootprintByReference(circuitJson, footprints);
  const footprintsBySymbol = new Map<string, Set<string>>();
  const boundInstances = schematicFiles.map((file) => ({
    ...file,
    content: mapSymbolForms(file.content, (form) => {
      const libIdMatch = /\(lib_id\s+("(?:\\.|[^"\\])*")/.exec(form);
      const reference = propertyValue(form, "Reference");
      if (!libIdMatch || !reference) return form;
      const footprintName = footprintByReference.get(reference);
      if (!footprintName) return form;
      const librarySymbolId = JSON.parse(libIdMatch[1]) as string;
      const names = footprintsBySymbol.get(librarySymbolId) ?? new Set<string>();
      names.add(footprintName);
      footprintsBySymbol.set(librarySymbolId, names);
      return replacePropertyValue(form, "Footprint", "tscircuit:" + footprintName);
    }),
  }));
  return boundInstances.map((file) => ({
    ...file,
    content: applyLibraryFootprintFilters(file.content, footprintsBySymbol),
  }));
}

function portableSymbolLibraries(schematics: readonly string[]): { files: Map<string, string>; table: string } {
  const symbolsByLibrary = new Map<string, Map<string, string>>();
  for (const schematic of schematics) {
    const sectionStart = schematic.indexOf("(lib_symbols");
    if (sectionStart < 0) throw new Error("KiCad schematic is missing embedded library symbols");
    const sectionEnd = matchingClose(schematic, sectionStart);
    const section = schematic.slice(sectionStart, sectionEnd);
    for (const symbolForm of directChildForms(section).filter((child) => child.startsWith("(symbol "))) {
      const fullName = quotedSymbolName(symbolForm);
      const separator = fullName.indexOf(":");
      if (separator <= 0 || separator === fullName.length - 1) {
        throw new Error("Unsupported embedded KiCad symbol identifier " + fullName);
      }
      const libraryName = fullName.slice(0, separator);
      const symbolName = fullName.slice(separator + 1);
      if (!/^[A-Za-z0-9_.-]+$/.test(libraryName) || !/^[A-Za-z0-9_.+-]+$/.test(symbolName)) {
        throw new Error("Unsafe embedded KiCad symbol identifier " + fullName);
      }
      const library = symbolsByLibrary.get(libraryName) ?? new Map<string, string>();
      const externalForm = symbolForm.replace(`(symbol ${JSON.stringify(fullName)}`, `(symbol ${JSON.stringify(symbolName)}`);
      const previous = library.get(symbolName);
      if (previous !== undefined && previous !== externalForm) {
        throw new Error("Conflicting embedded definitions for KiCad symbol " + fullName);
      }
      library.set(symbolName, externalForm);
      symbolsByLibrary.set(libraryName, library);
    }
  }
  if (symbolsByLibrary.size === 0) throw new Error("KiCad schematic has no portable symbol definitions");

  const files = new Map<string, string>();
  const tableEntries: string[] = [];
  for (const libraryName of [...symbolsByLibrary.keys()].sort()) {
    const definitions = [...symbolsByLibrary.get(libraryName)!.entries()].sort(([left], [right]) => left.localeCompare(right));
    files.set(
      libraryName + ".kicad_sym",
      `(kicad_symbol_lib (version 20211014) (generator circuit-json-to-kicad)\n${definitions
        .map(([, definition]) => "\n" + definition)
        .join("\n")}\n)\n`,
    );
    tableEntries.push(
      `  (lib (name ${JSON.stringify(libraryName)}) (type "KiCad") (uri ${JSON.stringify("$" + "{KIPRJMOD}/" + libraryName + ".kicad_sym")}) (options "") (descr "Exported from Circuit JSON"))`,
    );
  }
  return { files, table: `(sym_lib_table (version 7)\n${tableEntries.join("\n")}\n)\n` };
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function isSingleSheet(circuitJson: readonly unknown[]): boolean {
  return !circuitJson.some(
    (item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "schematic_sheet",
  );
}

function hasDeclaredPowerSource(
  netLabel: Record<string, unknown>,
  records: Array<Record<string, unknown>>,
): boolean {
  if (typeof netLabel.source_net_id !== "string") return false;
  const sourceNet = records.find(
    (record) => record.type === "source_net" && record.source_net_id === netLabel.source_net_id,
  );
  if (typeof sourceNet?.subcircuit_connectivity_map_key !== "string") return false;
  return records.some(
    (record) =>
      record.type === "source_port" &&
      record.subcircuit_connectivity_map_key === sourceNet.subcircuit_connectivity_map_key &&
      (record.provides_power === true || record.provides_ground === true),
  );
}

function schematicCircuitJson(circuitJson: readonly unknown[]): unknown[] {
  if (!isSingleSheet(circuitJson)) return circuitJson as unknown[];
  const records = circuitJson.filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object",
  );
  const labelIdsToLocalize = new Set(
    records
      .filter((record) => record.type === "schematic_net_label")
      .filter((record) => !record.symbol_name || hasDeclaredPowerSource(record, records))
      .map((record) => record.schematic_net_label_id)
      .filter((id): id is string => typeof id === "string"),
  );
  return records.map((record) => {
    if (record.type !== "schematic_net_label" || !labelIdsToLocalize.has(record.schematic_net_label_id as string)) return record;
    const { symbol_name: _symbolName, ...localLabel } = record;
    return localLabel;
  });
}

function makeSingleSheetLabelsLocal(converter: CircuitJsonToKicadSchConverter): void {
  const schematic = converter.ctx.kicadSch;
  if (!schematic) throw new Error("schematic converter did not initialize its KiCad document");
  const globalLabels = schematic.globalLabels ?? [];
  if (globalLabels.length === 0) return;
  schematic.labels = [
    ...(schematic.labels ?? []),
    ...globalLabels.map((label) => new Label({
      value: label.value,
      at: label.at,
      effects: label.effects,
      uuid: label.uuid,
      fieldsAutoplaced: label.fieldsAutoplaced,
    })),
  ];
  schematic.globalLabels = [];
}

type SchematicPoint = { x: number; y: number };
const SCHEMATIC_POINT_EPSILON = 1e-6;

function sameSchematicPoint(left: SchematicPoint, right: SchematicPoint): boolean {
  return Math.abs(left.x - right.x) <= SCHEMATIC_POINT_EPSILON && Math.abs(left.y - right.y) <= SCHEMATIC_POINT_EPSILON;
}

function pointOnSchematicSegment(point: SchematicPoint, start: SchematicPoint, end: SchematicPoint): boolean {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const cross = (point.x - start.x) * dy - (point.y - start.y) * dx;
  if (Math.abs(cross) > SCHEMATIC_POINT_EPSILON) return false;
  const dot = (point.x - start.x) * dx + (point.y - start.y) * dy;
  return dot >= -SCHEMATIC_POINT_EPSILON && dot <= dx * dx + dy * dy + SCHEMATIC_POINT_EPSILON;
}

function trimLabelOvershootWires(schematicText: string): string {
  const schematic = parseKicadSch(schematicText);
  const definitions = new Map((schematic.libSymbols?.symbols ?? []).map((symbol) => [symbol.libraryId, symbol]));
  const pinPositions: SchematicPoint[] = [];

  for (const symbol of schematic.symbols) {
    const at = symbol.at;
    const definition = definitions.get(symbol.libraryId);
    if (!at || !definition) return schematicText;
    if (Math.abs(at.angle ?? 0) > SCHEMATIC_POINT_EPSILON || symbol.mirror) return schematicText;
    for (const unit of definition.subSymbols) {
      for (const pin of unit.pins ?? []) {
        const pinAt = pin.at;
        if (!pinAt) return schematicText;
        pinPositions.push({ x: at.x + pinAt.x, y: at.y - pinAt.y });
      }
    }
  }

  const labels = [...schematic.labels, ...schematic.globalLabels]
    .map((label) => label.at)
    .filter((at): at is NonNullable<typeof at> => at !== undefined)
    .map(({ x, y }) => ({ x, y }));
  const connectionMarkers = [...schematic.junctions, ...schematic.noConnects]
    .map((marker) => marker.at)
    .filter((at): at is NonNullable<typeof at> => at !== undefined)
    .map(({ x, y }) => ({ x, y }));
  const wires = schematic.wires;
  let changed = false;

  for (const wire of wires) {
    const points = wire.points?.points ?? [];
    if (points.length !== 2 || !(points[0] instanceof Xy) || !(points[1] instanceof Xy)) continue;
    const [start, end] = points;
    const isHorizontal = Math.abs(start.y - end.y) <= SCHEMATIC_POINT_EPSILON;
    const isVertical = Math.abs(start.x - end.x) <= SCHEMATIC_POINT_EPSILON;
    if ((!isHorizontal && !isVertical) || sameSchematicPoint(start, end)) continue;

    const interiorLabels = labels.filter((label) =>
      pointOnSchematicSegment(label, start, end) &&
      !sameSchematicPoint(label, start) &&
      !sameSchematicPoint(label, end),
    );
    if (interiorLabels.length !== 1) continue;
    const [label] = interiorLabels;
    const startsAtPin = pinPositions.some((pin) => sameSchematicPoint(pin, start));
    const endsAtPin = pinPositions.some((pin) => sameSchematicPoint(pin, end));
    if (startsAtPin === endsAtPin) continue;
    const freeEnd = startsAtPin ? end : start;

    const freeEndHasOtherConnection =
      pinPositions.some((pin) => sameSchematicPoint(pin, freeEnd)) ||
      labels.some((position) => sameSchematicPoint(position, freeEnd)) ||
      connectionMarkers.some((position) => sameSchematicPoint(position, freeEnd)) ||
      wires.some((otherWire) => {
        if (otherWire === wire) return false;
        const otherPoints = otherWire.points?.points ?? [];
        for (let index = 1; index < otherPoints.length; index += 1) {
          const segmentStart = otherPoints[index - 1];
          const segmentEnd = otherPoints[index];
          if (segmentStart instanceof Xy && segmentEnd instanceof Xy && pointOnSchematicSegment(freeEnd, segmentStart, segmentEnd)) {
            return true;
          }
        }
        return false;
      });
    if (freeEndHasOtherConnection) continue;

    freeEnd.x = label.x;
    freeEnd.y = label.y;
    changed = true;
  }

  return changed ? schematic.getString() + "\n" : schematicText;
}

type SchematicGridPoint = { x: number; y: number };
type SchematicPinTransform = {
  pin: NonNullable<ReturnType<typeof parseKicadSch>>["symbols"][number]["pins"][number];
  oldLocal: SchematicGridPoint;
  newLocal: SchematicGridPoint;
  angle: number;
};

function schematicGridPrecision(value: number): number {
  return Number(value.toFixed(NATIVE_SCHEMATIC_COORDINATE_PRECISION));
}

function snapSchematicCoordinate(value: number): number {
  return schematicGridPrecision(Math.round(value / NATIVE_SCHEMATIC_GRID_MM) * NATIVE_SCHEMATIC_GRID_MM);
}

function schematicPointKey(point: SchematicGridPoint): string {
  return `${schematicGridPrecision(point.x)},${schematicGridPrecision(point.y)}`;
}

function rotateSchematicPoint(point: SchematicGridPoint, angle: number): SchematicGridPoint {
  const radians = (angle * Math.PI) / 180;
  return {
    x: schematicGridPrecision(point.x * Math.cos(radians) - point.y * Math.sin(radians)),
    y: schematicGridPrecision(point.x * Math.sin(radians) + point.y * Math.cos(radians)),
  };
}

function symbolPinWorldPosition(
  local: SchematicGridPoint,
  origin: SchematicGridPoint,
  angle: number,
): SchematicGridPoint {
  const rotated = rotateSchematicPoint(local, angle);
  return { x: schematicGridPrecision(origin.x + rotated.x), y: schematicGridPrecision(origin.y - rotated.y) };
}

function moveSymbolPinArtwork(value: unknown, localPinMap: ReadonlyMap<string, SchematicGridPoint>): void {
  if (!value || typeof value !== "object") return;
  const point = value as Record<string, unknown>;
  if (typeof point.x === "number" && typeof point.y === "number") {
    const target = localPinMap.get(schematicPointKey({ x: point.x, y: point.y }));
    if (target) {
      point.x = target.x;
      point.y = target.y;
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) moveSymbolPinArtwork(child, localPinMap);
    return;
  }
  for (const child of Object.values(point)) moveSymbolPinArtwork(child, localPinMap);
}

function snapSchematicGrid(schematicText: string): string {
  const schematic = parseKicadSch(schematicText);
  const definitions = new Map((schematic.libSymbols?.symbols ?? []).map((symbol) => [symbol.libraryId, symbol]));
  const proposals = new Map<string, { signature: string; pins: SchematicPinTransform[]; localPinMap: Map<string, SchematicGridPoint> }>();

  for (const symbol of schematic.symbols) {
    const reference = symbol.properties.find((property) => property.key === "Reference")?.value ?? symbol.libraryId ?? "unknown";
    const libraryId = symbol.libraryId;
    const definition = libraryId ? definitions.get(libraryId) : undefined;
    const at = symbol.at;
    if (!libraryId || !definition || !at) {
      throw new Error("Cannot snap schematic symbol without embedded library definition and position: " + reference);
    }
    const angle = (((at.angle ?? 0) % 360) + 360) % 360;
    if (![0, 90, 180, 270].includes(angle) || symbol.mirror) {
      throw new Error("Cannot snap unsupported schematic transform on " + reference + ": angle=" + angle + ", mirror=" + (symbol.mirror ?? "none"));
    }

    const oldOrigin = { x: at.x, y: at.y };
    const newOrigin = { x: snapSchematicCoordinate(at.x), y: snapSchematicCoordinate(at.y) };
    const localPinMap = new Map<string, SchematicGridPoint>();
    const pins: SchematicPinTransform[] = [];
    for (const unit of definition.subSymbols) {
      for (const pin of unit.pins ?? []) {
        const pinAt = pin.at;
        if (!pinAt) throw new Error("Cannot snap schematic pin without a position on " + reference);
        const oldLocal = { x: pinAt.x, y: pinAt.y };
        const oldWorld = symbolPinWorldPosition(oldLocal, oldOrigin, angle);
        const newWorld = { x: snapSchematicCoordinate(oldWorld.x), y: snapSchematicCoordinate(oldWorld.y) };
        const rotatedLocal = { x: newWorld.x - newOrigin.x, y: newOrigin.y - newWorld.y };
        const newLocal = rotateSchematicPoint(rotatedLocal, -angle);
        const oldKey = schematicPointKey(oldLocal);
        const previous = localPinMap.get(oldKey);
        if (previous && schematicPointKey(previous) !== schematicPointKey(newLocal)) {
          throw new Error("Ambiguous native grid pin geometry in " + libraryId);
        }
        localPinMap.set(oldKey, newLocal);
        pins.push({ pin, oldLocal, newLocal, angle: pinAt.angle ?? 0 });
      }
    }

    const signature = JSON.stringify(pins.map(({ newLocal, angle: pinAngle }) => [newLocal.x, newLocal.y, pinAngle]));
    const existing = proposals.get(libraryId);
    if (existing && existing.signature !== signature) {
      throw new Error("Shared native symbol " + libraryId + " requires incompatible 50 mil pin geometry");
    }
    if (!existing) proposals.set(libraryId, { signature, pins, localPinMap });
    symbol.at = [newOrigin.x, newOrigin.y, angle];
  }

  for (const [libraryId, proposal] of proposals) {
    const definition = definitions.get(libraryId);
    if (!definition) throw new Error("Embedded KiCad symbol disappeared during grid normalization: " + libraryId);
    for (const { pin, newLocal, angle } of proposal.pins) pin.at = [newLocal.x, newLocal.y, angle];
    for (const unit of definition.subSymbols) {
      for (const primitiveName of ["polylines", "rectangles", "circles", "arcs"] as const) {
        moveSymbolPinArtwork(unit[primitiveName], proposal.localPinMap);
      }
    }
  }

  const keptWires = [];
  for (const wire of schematic.wires ?? []) {
    const points = wire.points?.points ?? [];
    if (points.length !== 2 || !(points[0] instanceof Xy) || !(points[1] instanceof Xy)) {
      throw new Error("Cannot snap unsupported schematic wire geometry; expected straight two-point wires");
    }
    const [start, end] = points;
    start.x = snapSchematicCoordinate(start.x);
    start.y = snapSchematicCoordinate(start.y);
    end.x = snapSchematicCoordinate(end.x);
    end.y = snapSchematicCoordinate(end.y);
    if (sameSchematicPoint(start, end)) continue;
    keptWires.push(wire);
  }
  schematic.wires = keptWires;

  for (const label of [...(schematic.labels ?? []), ...(schematic.globalLabels ?? [])]) {
    if (!label.at) throw new Error("Cannot snap schematic label without a position");
    label.at = [snapSchematicCoordinate(label.at.x), snapSchematicCoordinate(label.at.y), label.at.angle ?? 0];
  }
  for (const marker of [...(schematic.junctions ?? []), ...(schematic.noConnects ?? [])]) {
    if (!marker.at) continue;
    marker.at.x = snapSchematicCoordinate(marker.at.x);
    marker.at.y = snapSchematicCoordinate(marker.at.y);
  }

  return schematic.getString() + "\n";
}

async function ensureOutputDoesNotExist(outputDir: string): Promise<void> {
  try {
    await stat(outputDir);
    throw new Error("KiCad export output directory already exists; refusing to overwrite stale or reviewed artifacts");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

export async function exportCircuitJsonToKicad({
  circuitJson,
  outputDir,
  projectName,
}: ExportKicadOptions): Promise<ExportKicadResult> {
  validateProjectName(projectName);
  if (typeof outputDir !== "string" || outputDir.trim().length === 0) {
    throw new Error("KiCad export output directory is required");
  }
  const sourcePinGroups = validateCircuitJson(circuitJson);
  const resolvedOutput = path.resolve(outputDir);
  await ensureOutputDoesNotExist(resolvedOutput);

  const schematicFilename = projectName + ".kicad_sch";
  const pcbFilename = projectName + ".kicad_pcb";
  const projectFilename = projectName + ".kicad_pro";
  const converterCircuitJson = circuitJson as ConstructorParameters<typeof CircuitJsonToKicadSchConverter>[0];
  const schematicInputCircuitJson = schematicCircuitJson(circuitJson) as ConstructorParameters<typeof CircuitJsonToKicadSchConverter>[0];
  const artifacts = new Map<string, string>();

  let schematicConverter: CircuitJsonToKicadSchConverter;
  let schematicFiles: Array<{ filename: string; content: string }>;
  try {
    schematicConverter = new CircuitJsonToKicadSchConverter(schematicInputCircuitJson);
    schematicConverter.runUntilFinished();
    if (isSingleSheet(circuitJson)) makeSingleSheetLabelsLocal(schematicConverter);
    schematicFiles = schematicConverter.getOutputFiles({ schematicFilename });
    if (schematicFiles.length === 0 || schematicFiles[0].filename !== schematicFilename) {
      throw new Error("converter did not return the requested root schematic");
    }
    schematicFiles = schematicFiles.map((file) => ({
      ...file,
      content: snapSchematicGrid(trimLabelOvershootWires(file.content)),
    }));
  } catch (error) {
    throw new Error("Circuit JSON to KiCad schematic conversion failed: " + (error as Error).message, { cause: error });
  }

  try {
    const pcbConverter = new CircuitJsonToKicadPcbConverter(converterCircuitJson, { projectName });
    pcbConverter.runUntilFinished();
    const pcbContent = pcbConverter.getOutputString();
    if (!pcbContent.trimStart().startsWith("(kicad_pcb")) {
      throw new Error("converter did not return a native KiCad PCB document");
    }
    addArtifact(artifacts, pcbFilename, pcbContent);
  } catch (error) {
    throw new Error("Circuit JSON to KiCad PCB conversion failed: " + (error as Error).message, { cause: error });
  }

  try {
    const projectConverter = new CircuitJsonToKicadProConverter(converterCircuitJson, {
      projectName,
      schematicFilename,
      pcbFilename,
      schematicSheetPlan: schematicConverter!.schematicSheetPlan,
    });
    projectConverter.runUntilFinished();
    const projectContent = projectConverter.getOutputString();
    const project = JSON.parse(projectContent) as {
      erc?: { rule_severities?: Record<string, string>; [key: string]: unknown };
      [key: string]: unknown;
    };
    if (!project.erc || typeof project.erc !== "object") {
      throw new Error("converter did not return KiCad ERC project settings");
    }
    project.erc.rule_severities = {
      ...project.erc.rule_severities,
      ...Object.fromEntries(ERC_CHECKS_DISABLED_BY_KICAD_DEFAULTS.map((check) => [check, "warning"])),
    };
    addArtifact(artifacts, projectFilename, `${JSON.stringify(project, null, 2)}\n`);
  } catch (error) {
    throw new Error("Circuit JSON to KiCad project conversion failed: " + (error as Error).message, { cause: error });
  }

  try {
    const libraryConverter = new CircuitJsonToKicadLibraryConverter(converterCircuitJson, {
      libraryName: projectName + "_custom",
    });
    libraryConverter.runUntilFinished();
    const footprintFiles = libraryConverter.getFootprints();
    schematicFiles = applyFootprintBindings(schematicFiles, circuitJson, footprintFiles);
    const portableLibraries = portableSymbolLibraries(
      schematicFiles.map((file) => file.content),
    );
    for (const file of schematicFiles) addArtifact(artifacts, file.filename, file.content);
    for (const [filename, content] of portableLibraries.files) addArtifact(artifacts, filename, content);
    addArtifact(artifacts, "sym-lib-table", portableLibraries.table);
    addArtifact(artifacts, "fp-lib-table", libraryConverter.getFpLibTableString());
    for (const footprint of footprintFiles) {
      addArtifact(artifacts, "tscircuit.pretty/" + footprint.footprintName + ".kicad_mod", footprint.kicadModString);
    }
  } catch (error) {
    throw new Error("Circuit JSON to KiCad library conversion failed: " + (error as Error).message, { cause: error });
  }

  const converterPackage = JSON.parse(
    await readFile(new URL("../node_modules/circuit-json-to-kicad/package.json", import.meta.url), "utf8"),
  ) as { version?: string };
  if (converterPackage.version !== EXPECTED_CONVERTER_VERSION) {
    throw new Error(
      "KiCad converter version drifted: expected " + EXPECTED_CONVERTER_VERSION + ", got " + converterPackage.version,
    );
  }

  const circuitJsonSha256 = sha256(JSON.stringify(circuitJson));
  const manifest = {
    schema_version: 1,
    generated_at_utc: new Date().toISOString(),
    project_name: projectName,
    converter: { package: CONVERTER_PACKAGE, version: converterPackage.version },
    input: { circuit_json_sha256: circuitJsonSha256 },
    source_pin_net_groups: sourcePinGroups,
    artifacts: Object.fromEntries(
      [...artifacts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([filename, content]) => [
        filename,
        { sha256: sha256(content), bytes: Buffer.byteLength(content) },
      ]),
    ),
  };
  artifacts.set("export-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

  const parentDir = path.dirname(resolvedOutput);
  const basename = path.basename(resolvedOutput);
  await mkdir(parentDir, { recursive: true });
  const stagingDir = await mkdtemp(path.join(parentDir, "." + basename + ".staging-"));
  let reservedOutput = false;
  try {
    for (const [filename, content] of artifacts) {
      const stagedFile = path.join(stagingDir, ...filename.split("/"));
      await mkdir(path.dirname(stagedFile), { recursive: true });
      await writeFile(stagedFile, content, { flag: "wx" });
    }
    await mkdir(resolvedOutput, { recursive: false });
    reservedOutput = true;
    for (const filename of artifacts.keys()) {
      const stagedFile = path.join(stagingDir, ...filename.split("/"));
      const outputFile = path.join(resolvedOutput, ...filename.split("/"));
      await mkdir(path.dirname(outputFile), { recursive: true });
      await rename(stagedFile, outputFile);
    }
  } catch (error) {
    if (reservedOutput) await rm(resolvedOutput, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }

  return {
    outputDir: resolvedOutput,
    files: [...artifacts.keys()].sort(),
    circuitJsonSha256,
    sourcePinNetGroups: sourcePinGroups,
  };
}

export { assertPinNetMembership, parseKicadNetlistPinNetGroups, sourcePinNetGroups } from "./connectivity.js";

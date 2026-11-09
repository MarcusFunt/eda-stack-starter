/** Bounded, source-only placement proposals based on actual tscircuit geometry errors.
 * Never changes requirements, nets, footprints, board dimensions, or design rules.
 * Fixed/edge-mounted components are excluded from automatic moves.
 */
type R = Record<string, unknown>;
function isObject(v: unknown): v is R { return typeof v === "object" && v !== null && !Array.isArray(v); }
function validNumber(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error("REPAIR_INVALID: expected finite geometry");
  return v;
}
export type PlacementMove = {
  reference: string; dx_mm: number; dy_mm: number; reason: string;
};
export type RoutingRepairPlan = {
  status: "no-errors" | "repair-proposed" | "blocked";
  source_error_count: number;
  moves: PlacementMove[];
  blockers: string[];
};
export function planRoutingRepair(circuitJson: unknown, pcbConstraints: unknown): RoutingRepairPlan {
  if (!Array.isArray(circuitJson) || !isObject(pcbConstraints) || !isObject(pcbConstraints.board)) {
    throw new Error("REPAIR_INVALID: missing Circuit JSON or constraints");
  }
  const board = circuitJson.find((item): item is R => isObject(item) && item.type === "pcb_board");
  if (!board || !isObject(board.center)) throw new Error("REPAIR_INVALID: PCB board geometry missing");
  const b = pcbConstraints.board;
  const width = validNumber(board.width), height = validNumber(board.height);
  const constraintW = validNumber(b.width_mm), constraintH = validNumber(b.height_mm);
  if (Math.abs(width - constraintW) > 1e-6 || Math.abs(height - constraintH) > 1e-6) {
    throw new Error("REPAIR_INVALID: rendered PCB size differs from declared constraints");
  }
  const margin = Math.max(0.2, typeof board.min_board_edge_clearance === "number" ? board.min_board_edge_clearance : 0.2) + 0.1;
  const centerX = validNumber(board.center.x), centerY = validNumber(board.center.y);
  const edges = { minX: centerX-width/2+margin, maxX: centerX+width/2-margin,
    minY: centerY-height/2+margin, maxY: centerY+height/2-margin };
  const fixed = new Set(Array.isArray(pcbConstraints.fixed_components) ? pcbConstraints.fixed_components : []);
  const sourceComponents = new Map(circuitJson.filter((r): r is R => isObject(r) && r.type === "source_component")
    .map((r) => [r.source_component_id, r.name]));
  const componentRecords = new Map(circuitJson.filter((r): r is R => isObject(r) && r.type === "pcb_component")
    .map((r) => [r.pcb_component_id, r]));
  const errors = circuitJson.filter((r): r is R => isObject(r) && /^pcb_.*error$/.test(String(r.type)));
  const moves: PlacementMove[] = [];
  const blockers: string[] = [];
  for (const error of errors) {
    if (error.type === "pcb_autorouting_error" || error.type === "pcb_port_not_connected_error") {
      // Derived from placement failure; re-evaluate after proposed move.
      continue;
    }
    if (error.type === "pcb_placement_error" &&
        typeof error.message === "string" &&
        /board-edge clearance/.test(error.message) &&
        errors.some((other) => other.type === "pcb_component_outside_board_error" &&
          typeof other.message === "string" &&
          other.message.includes(String(error.message).match(/pad ([A-Za-z]+[0-9]+)\./)?.[1] ?? "\u0000"))) {
      // Geometry-specific clearance secondary effect. The candidate must be
      // rebuilt and all checks rerun; never silently waive the error.
      continue;
    }
    if (error.type !== "pcb_component_outside_board_error") {
      blockers.push(String(error.type) + ": no safe automatic repair strategy");
      continue;
    }
    const record = componentRecords.get(error.pcb_component_id);
    const ref = record && sourceComponents.get(record.source_component_id);
    if (typeof ref !== "string") { blockers.push("Unknown component ID in placement error"); continue; }
    if (fixed.has(ref)) { blockers.push(ref + ": fixed component cannot be moved automatically"); continue; }
    if (!isObject(error.component_bounds)) { blockers.push(ref + ": placement geometry missing"); continue; }
    const bounds = error.component_bounds;
    const minX = validNumber(bounds.min_x), maxX = validNumber(bounds.max_x);
    const minY = validNumber(bounds.min_y), maxY = validNumber(bounds.max_y);
    if (maxX-minX >= width-2*margin || maxY-minY >= height-2*margin) {
      blockers.push(ref + ": footprint does not fit within board margins");continue;
    }
    const dx = minX < edges.minX ? edges.minX-minX : maxX > edges.maxX ? edges.maxX-maxX : 0;
    const dy = minY < edges.minY ? edges.minY-minY : maxY > edges.maxY ? edges.maxY-maxY : 0;
    if (Math.abs(dx)>5 || Math.abs(dy)>5 || dx===0 && dy===0) {
      blockers.push(ref + ": move exceeds 5 mm per-repair limit or bounds are inconsistent");continue;
    }
    moves.push({ reference:ref, dx_mm:Math.round(dx*1e4)/1e4, dy_mm:Math.round(dy*1e4)/1e4,
      reason:"Real PCB bounding box extends beyond declared board margin" });
  }
  if (new Set(moves.map(m=>m.reference)).size !== moves.length) blockers.push("Multiple conflicting moves for one component");
  if (blockers.length) return { status:"blocked",source_error_count:errors.length,moves:[],blockers };
  return {status:moves.length?"repair-proposed": errors.length?"blocked":"no-errors",source_error_count:errors.length,
    moves,blockers:errors.length&&!moves.length?["No supported placement corrections for remaining PCB errors"]:[]};
}

/** Change only explicit numeric pcbX/pcbY fields on one uniquely named TSX component. */
export function applyPlacementMove(source: string, move: PlacementMove): string {
  if (typeof source !== "string" || !/^[A-Za-z]+[0-9]+$/.test(move.reference)) {
    throw new Error("REPAIR_INVALID: nonportable component reference");
  }
  const component = new RegExp("<[A-Za-z]+\\s+[^<>]*\\bname=\"" + move.reference + "\"[^<>]*\\/>", "g");
  const matches = [...source.matchAll(component)];
  if (matches.length !== 1) throw new Error("REPAIR_AMBIGUOUS: component must appear exactly once with explicit numeric placement");
  const text = matches[0][0];
  const replace = (fragment:string, field:"pcbX"|"pcbY", delta:number):string => {
    const re = new RegExp("\\b"+field+"=\\{(-?\\d+(?:\\.\\d+)?)\\}");
    const m = fragment.match(re);
    if (!m) throw new Error("REPAIR_AMBIGUOUS: "+field+" must be a finite numeric JSX field");
    const value = Number(m[1])+delta;
    if (!Number.isFinite(value)) throw new Error("REPAIR_INVALID: non-finite repaired coordinate");
    return fragment.replace(re,field+"={"+Number(value.toFixed(4))+"}");
  };
  const candidate = replace(replace(text,"pcbX",move.dx_mm),"pcbY",move.dy_mm);
  return source.slice(0,matches[0].index!)+candidate+source.slice(matches[0].index!+text.length);
}

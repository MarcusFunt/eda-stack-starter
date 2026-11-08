export const CIRCUIT_JSON_COMPAT_NORMALIZATION = "pcb-plated-hole-fill-shape-discriminators-v1";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Restore redundant plated-hole discriminator fields omitted by tscircuit 0.0.3114. */
export function normalizeTscircuitCircuitJson(input: unknown): { circuitJson: unknown; applied: string[] } {
  if (!Array.isArray(input)) return { circuitJson: input, applied: [] };
  let changed = false;
  const circuitJson = input.map((value) => {
    if (!isObject(value) || value.type !== "pcb_plated_hole") return value;
    const implied = value.shape === "circular_hole_with_rect_pad"
      ? { hole_shape: "circle", pad_shape: "rect" }
      : value.shape === "pill_hole_with_rect_pad"
        ? { hole_shape: "pill", pad_shape: "rect" }
        : value.shape === "rotated_pill_hole_with_rect_pad"
          ? { hole_shape: "rotated_pill", pad_shape: "rect" }
          : undefined;
    if (!implied) return value;
    const needsHoleShape = value.hole_shape === undefined;
    const needsPadShape = value.pad_shape === undefined;
    if (!needsHoleShape && !needsPadShape) return value;
    changed = true;
    return {
      ...value,
      ...(needsHoleShape ? { hole_shape: implied.hole_shape } : {}),
      ...(needsPadShape ? { pad_shape: implied.pad_shape } : {}),
    };
  });
  return {
    circuitJson,
    applied: changed ? [CIRCUIT_JSON_COMPAT_NORMALIZATION] : [],
  };
}

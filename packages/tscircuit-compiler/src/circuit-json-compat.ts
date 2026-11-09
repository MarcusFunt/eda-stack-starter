export const CIRCUIT_JSON_COMPAT_NORMALIZATION = "pcb-plated-hole-fill-shape-discriminators-v1";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * tscircuit 0.0.3114 omits the redundant hole_shape/pad_shape keys on three
 * plated-hole variants, while Circuit JSON 0.0.548 requires those keys.
 * Add only the values implied by the existing shape discriminator.
 */
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

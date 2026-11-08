export const DESIGN_SOURCE_PATH = "integrations/tscircuit-rc/design.json";
export const MAX_CANDIDATE_ATTEMPTS = 3;

const SPICE_LITERAL = /^(\d+(?:\.\d*)?|\.\d+)(?:e([+-]?\d+))?(meg|[tgkmunpf])?$/i;
const SPICE_SCALES = {
  "": 1,
  t: 1e12,
  g: 1e9,
  meg: 1e6,
  k: 1e3,
  m: 1e-3,
  u: 1e-6,
  n: 1e-9,
  p: 1e-12,
  f: 1e-15,
};
const SPICE_SCALE_EXPONENTS = {
  "": 0,
  t: 12,
  g: 9,
  meg: 6,
  k: 3,
  m: -3,
  u: -6,
  n: -9,
  p: -12,
  f: -15,
};

function isPositiveSpiceLiteral(value) {
  if (typeof value !== "string") return false;
  try {
    return spiceValueInBaseUnits(value) > 0;
  } catch {
    return false;
  }
}

export function spiceValueInBaseUnits(value) {
  const match = typeof value === "string" ? SPICE_LITERAL.exec(value) : null;
  if (!match) throw new Error("Expected a positive scalar SPICE literal");
  const baseUnits =
    Number(match[1]) * 10 ** Number(match[2] ?? 0) * SPICE_SCALES[(match[3] ?? "").toLowerCase()];
  if (!Number.isFinite(baseUnits) || baseUnits <= 0) {
    throw new Error("SPICE literal must represent a finite positive value");
  }
  return baseUnits;
}

function expandSpiceLiteral(value) {
  const match = SPICE_LITERAL.exec(value);
  const coefficient = match[1];
  const decimalAt = coefficient.indexOf(".");
  const digits = coefficient.replace(".", "");
  const exponent = Number(match[2] ?? 0) + SPICE_SCALE_EXPONENTS[(match[3] ?? "").toLowerCase()];
  const point = (decimalAt === -1 ? coefficient.length : decimalAt) + exponent;
  let expanded;
  if (point <= 0) expanded = "0." + "0".repeat(-point) + digits;
  else if (point >= digits.length) expanded = digits + "0".repeat(point - digits.length);
  else expanded = digits.slice(0, point) + "." + digits.slice(point);
  if (expanded.includes(".")) expanded = expanded.replace(/0+$/, "").replace(/\.$/, "");
  if (expanded.includes(".")) {
    const [integer, fraction] = expanded.split(".");
    expanded = integer.replace(/^0+(?=\d)/, "") + "." + fraction;
  } else {
    expanded = expanded.replace(/^0+(?=\d)/, "");
  }
  return expanded;
}

export function toTscircuitNumericLiteral(value) {
  spiceValueInBaseUnits(value);
  return expandSpiceLiteral(value);
}

export function parseDesignSource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("design source must be a JSON object");
  }
  if (value.schema_version !== 1 || Object.keys(value).some((key) => !["schema_version", "parameters"].includes(key))) {
    throw new Error("design source must use schema_version 1 and only the approved fields");
  }
  const parameters = value.parameters;
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw new Error("design source parameters must be a JSON object");
  }
  if (Object.keys(parameters).length !== 2 || !Object.hasOwn(parameters, "resistance") || !Object.hasOwn(parameters, "capacitance")) {
    throw new Error("design source must define only resistance and capacitance");
  }
  for (const [name, literal] of Object.entries(parameters)) {
    if (!isPositiveSpiceLiteral(literal)) {
      throw new Error(`${name} must be a positive SPICE literal`);
    }
  }
  return { resistance: parameters.resistance, capacitance: parameters.capacitance };
}

export function assertCandidateDiff(paths) {
  const unexpected = paths
    .map((item) => item.replaceAll("\\", "/"))
    .filter((item) => item !== DESIGN_SOURCE_PATH);
  if (unexpected.length > 0) {
    throw new Error(
      `only ${DESIGN_SOURCE_PATH} may change during the supervised candidate loop; found: ${unexpected.join(", ")}`,
    );
  }
  return true;
}

export function assertAttemptAvailable(completedAttempts) {
  if (!Number.isInteger(completedAttempts) || completedAttempts < 0) {
    throw new Error("completed candidate attempt count must be a non-negative integer");
  }
  if (completedAttempts >= MAX_CANDIDATE_ATTEMPTS) {
    throw new Error(`candidate iteration limit of ${MAX_CANDIDATE_ATTEMPTS} reached`);
  }
  return completedAttempts + 1;
}

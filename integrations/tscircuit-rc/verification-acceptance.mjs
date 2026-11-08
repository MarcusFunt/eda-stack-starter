function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function hasNumericalRequirementFailure(scenario) {
  if (
    !scenario ||
    scenario.status !== "fail" ||
    scenario.passed !== false ||
    scenario.returncode !== 0 ||
    scenario.timed_out !== false ||
    !Array.isArray(scenario.errors) ||
    scenario.errors.length !== 0 ||
    !Array.isArray(scenario.checks) ||
    scenario.checks.length === 0 ||
    scenario.checks.some((check) =>
      !check ||
      !finiteNumber(check.value) ||
      !finiteNumber(check.min) ||
      !finiteNumber(check.max) ||
      check.min > check.max
    )
  ) {
    return false;
  }
  return scenario.checks.some((check) =>
    check.passed === false && (check.value < check.min || check.value > check.max),
  );
}

export function assertElectricalFaultEvidence(scenario) {
  if (
    !scenario ||
    scenario.status !== "fail" ||
    scenario.passed !== false ||
    scenario.returncode !== 0 ||
    scenario.timed_out !== false ||
    !Array.isArray(scenario.errors) ||
    scenario.errors.length !== 0
  ) {
    throw new Error("Electrical fault evidence requires a clean simulator run without timeout or errors");
  }
  const measurement = Array.isArray(scenario.checks)
    ? scenario.checks.find((check) => check?.id === "vout_100u")
    : undefined;
  if (!measurement || !finiteNumber(measurement.value)) {
    throw new Error("Electrical fault evidence requires a finite vout_100u measurement");
  }
  if (!finiteNumber(measurement.min) || !finiteNumber(measurement.max) || measurement.min > measurement.max) {
    throw new Error("Electrical fault evidence requires finite measurement bounds");
  }
  if (measurement.passed !== false || (measurement.value >= measurement.min && measurement.value <= measurement.max)) {
    throw new Error("Electrical fault must produce a value outside the vout_100u requirement bounds");
  }
  return true;
}

export function classifyCandidateVerification(verification) {
  if (verification?.passed === true) return "passed";
  return hasNumericalRequirementFailure(verification?.scenario)
    ? "failed_requirements"
    : "infrastructure_or_source_error";
}

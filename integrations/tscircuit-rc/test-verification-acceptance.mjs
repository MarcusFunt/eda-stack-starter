import assert from "node:assert/strict";
import { test } from "node:test";

const acceptance = await import("./verification-acceptance.mjs").catch(() => ({}));

function passingEvidence() {
  return {
    status: "fail",
    passed: false,
    returncode: 0,
    timed_out: false,
    errors: [],
    checks: [
      {
        id: "vout_100u",
        value: 1.41734,
        min: 2.7,
        max: 3.7,
        passed: false,
      },
    ],
  };
}

test("accepts a seeded electrical fault only with a finite out-of-range value", () => {
  assert.equal(typeof acceptance.assertElectricalFaultEvidence, "function");
  assert.doesNotThrow(() => acceptance.assertElectricalFaultEvidence(passingEvidence()));
});

test("rejects missing or non-finite measurements as fault proof", () => {
  assert.equal(typeof acceptance.assertElectricalFaultEvidence, "function");
  for (const value of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY]) {
    const evidence = passingEvidence();
    evidence.checks[0].value = value;
    assert.throws(() => acceptance.assertElectricalFaultEvidence(evidence), /finite|measurement/i);
  }
});

test("rejects solver and timeout failures as electrical requirement evidence", () => {
  assert.equal(typeof acceptance.assertElectricalFaultEvidence, "function");
  for (const update of [
    { returncode: 1 },
    { timed_out: true },
    { errors: ["model file missing"] },
  ]) {
    assert.throws(
      () => acceptance.assertElectricalFaultEvidence({ ...passingEvidence(), ...update }),
      /simulator|timeout|error/i,
    );
  }
});

test("classifies candidate solver failures separately from requirement failures", () => {
  assert.equal(typeof acceptance.classifyCandidateVerification, "function");
  assert.equal(
    acceptance.classifyCandidateVerification({ passed: false, scenario: passingEvidence() }),
    "failed_requirements",
  );
  assert.equal(
    acceptance.classifyCandidateVerification({
      passed: false,
      scenario: { ...passingEvidence(), checks: [{ id: "vout_100u", value: null, passed: false }] },
    }),
    "infrastructure_or_source_error",
  );
  assert.equal(
    acceptance.classifyCandidateVerification({
      passed: false,
      scenario: {
        ...passingEvidence(),
        checks: [
          passingEvidence().checks[0],
          { id: "rise_time", value: null, min: 0.1, max: 0.2, passed: false },
        ],
      },
    }),
    "infrastructure_or_source_error",
  );
  assert.equal(
    acceptance.classifyCandidateVerification({ passed: true }),
    "passed",
  );
});

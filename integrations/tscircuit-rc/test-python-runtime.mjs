import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { resolvePython } from "./python-runtime.mjs";

test("resolves the Windows virtual environment interpreter", () => {
  const root = "C:/project";
  assert.equal(
    resolvePython(root, { platform: "win32", exists: (candidate) => candidate.endsWith("python.exe") }),
    path.win32.join(root, ".venv", "Scripts", "python.exe"),
  );
});

test("resolves the POSIX virtual environment interpreter", () => {
  const root = "/project";
  assert.equal(
    resolvePython(root, { platform: "linux", exists: (candidate) => candidate.endsWith("/bin/python") }),
    path.posix.join(root, ".venv", "bin", "python"),
  );
});

test("uses the platform Python command when the project environment is absent", () => {
  assert.equal(resolvePython("/project", { platform: "linux", exists: () => false }), "python3");
  assert.equal(resolvePython("C:/project", { platform: "win32", exists: () => false }), "python");
});

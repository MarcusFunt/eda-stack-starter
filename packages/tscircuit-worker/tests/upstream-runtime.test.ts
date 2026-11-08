import assert from "node:assert/strict";
import { test } from "node:test";

let importError: unknown;
try {
  await import("circuit-json-to-kicad");
} catch (error) {
  importError = error;
}

test("pinned Circuit JSON converter loads its published runtime entrypoint", () => {
  assert.ifError(importError);
});

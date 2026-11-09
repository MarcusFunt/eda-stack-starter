import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { checkGeneralNativeRelease, checkReviewedRcRelease } from "../src/release-gate.js";
const { values } = parseArgs({
  options: {
    summary: { type: "string" },
    kind: { type: "string" },
    mode: { type: "string", default: "pcb" },
    fixtures: { type: "string" },
  },
  strict: true,
});
if (!values.summary || !values.kind) throw new Error("Usage: --summary <file> --kind general|reviewed-rc [--fixtures name1,name2] [--mode schematic|pcb]");
const summary = JSON.parse(await readFile(values.summary, "utf8")) as unknown;
let result;
if (values.kind === "reviewed-rc") {
  if (values.fixtures || values.mode !== "pcb") throw new Error("Reviewed RC gate only accepts the pcb mode and fixed fixture");
  result = checkReviewedRcRelease(summary);
} else if (values.kind === "general") {
  if (!values.fixtures) throw new Error("General native release requires an explicit --fixtures selection");
  if (values.mode !== "schematic" && values.mode !== "pcb") throw new Error("Unsupported release mode");
  result = checkGeneralNativeRelease(summary, values.fixtures.split(","), values.mode);
} else {
  throw new Error("Unknown release report kind");
}
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
if (!result.ready) process.exitCode = 1;

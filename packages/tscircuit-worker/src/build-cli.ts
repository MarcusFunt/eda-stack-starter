import { parseArgs } from "node:util";
import { buildProject } from "./build.js";

const parsed = parseArgs({
  options: {
    "project-root": { type: "string" },
    "entrypoint": { type: "string" },
    "output-dir": { type: "string" },
    "timeout-ms": { type: "string", default: "60000" },
  },
  strict: true,
});
const { values } = parsed;
if (!values["project-root"] || !values["output-dir"]) {
  throw new Error("Usage: npm run build:project -- --project-root <directory> --output-dir <new-directory> [--entrypoint src/board.tsx]");
}
const timeoutMs = Number(values["timeout-ms"]);
if (!Number.isInteger(timeoutMs)) throw new Error("--timeout-ms must be an integer");

try {
  const result = await buildProject({
    projectRoot: values["project-root"],
    outputDir: values["output-dir"],
    entrypoint: values.entrypoint,
    timeoutMs,
  });
  process.stdout.write(JSON.stringify({ status: "compiled", ...result }, null, 2) + "\n");
} catch (error) {
  process.stderr.write(JSON.stringify({ status: "failed", error: (error as Error).message }) + "\n");
  process.exitCode = 1;
}

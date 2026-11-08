import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertAttemptAvailable,
  assertCandidateDiff,
  DESIGN_SOURCE_PATH,
  parseDesignSource,
} from "./design-contract.mjs";
import { resolvePython } from "./python-runtime.mjs";
import { classifyCandidateVerification } from "./verification-acceptance.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "../..");
const buildRoot = path.join(projectRoot, "build", "tscircuit-rc");
const historyPath = path.join(buildRoot, "optimization-history.jsonl");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runGit(args) {
  const result = spawnSync("git", args, { cwd: projectRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function readHistory() {
  try {
    const text = await readFile(historyPath, "utf8");
    return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error(`candidate history is unreadable: ${error.message}`);
  }
}

async function runCandidateLoop() {
  const changedFiles = runGit(["diff", "--name-only", "HEAD"]).split(/\r?\n/).filter(Boolean);
  assertCandidateDiff(changedFiles);
  const diff = runGit(["diff", "--no-ext-diff", "--unified=3", "HEAD", "--", DESIGN_SOURCE_PATH]);
  process.stdout.write(diff ? `${diff}\n` : "No tracked design source diff relative to HEAD.\n");

  const history = await readHistory();
  const iteration = assertAttemptAvailable(history.length);
  const designBytes = await readFile(path.join(projectRoot, DESIGN_SOURCE_PATH));
  const sourceHash = sha256(designBytes);
  const candidateId = `p4-${iteration}-${sourceHash.slice(0, 12)}`;
  const packageLock = JSON.parse(await readFile(path.join(here, "package-lock.json"), "utf8"));
  const protectedFileSha256 = {};
  for (const relativePath of [
    "examples/rc_filter/spec.json",
    "models/library.json",
    "models/fixtures/ideal_two_pin_resistor.lib",
    "src/edastack/core.py",
    "src/edastack/mcp.py",
    "tests/test_core.py",
    "integrations/tscircuit-rc/build-spice.mjs",
    "integrations/tscircuit-rc/verify.mjs",
    "integrations/tscircuit-rc/python-runtime.mjs",
    "integrations/tscircuit-rc/verification-acceptance.mjs",
    "integrations/tscircuit-rc/candidate-loop.mjs",
    "integrations/tscircuit-rc/design-contract.mjs",
    "integrations/tscircuit-rc/test-design-loop.mjs",
    "integrations/tscircuit-rc/package.json",
    "integrations/tscircuit-rc/package-lock.json",
  ]) {
    protectedFileSha256[relativePath] = sha256(await readFile(path.join(projectRoot, relativePath)));
  }
  const python = resolvePython(projectRoot);
  const pythonVersionResult = spawnSync(python, ["--version"], { cwd: projectRoot, encoding: "utf8" });
  const edastackVersionResult = spawnSync(
    python,
    ["-c", "from edastack import __version__; print(__version__)"],
    { cwd: projectRoot, encoding: "utf8" },
  );
  const pythonVersion = (pythonVersionResult.stdout || pythonVersionResult.stderr || "").trim();
  const edastackVersion = (edastackVersionResult.stdout || "").trim();
  const record = {
    schema_version: 1,
    candidate_id: candidateId,
    iteration,
    iteration_limit: 3,
    created_at_utc: new Date().toISOString(),
    git_head: runGit(["rev-parse", "HEAD"]),
    changed_files: changedFiles,
    source_design_sha256: sourceHash,
    diff_sha256: sha256(diff),
    protected_file_sha256: protectedFileSha256,
    agent_model: process.env.EDASTACK_CANDIDATE_MODEL || "not_recorded",
    prompt_id: process.env.EDASTACK_CANDIDATE_PROMPT_ID || "not_recorded",
    tool_versions: {
      node: process.version,
      python: pythonVersionResult.status === 0 ? pythonVersion || "unknown" : "unavailable",
      edastack: edastackVersionResult.status === 0 ? edastackVersion || "unknown" : "unavailable",
      tscircuit: packageLock.packages["node_modules/tscircuit"].version,
      circuit_json_to_spice: packageLock.packages["node_modules/circuit-json-to-spice"].version,
    },
    human_disposition: "pending_review",
  };

  try {
    record.design = parseDesignSource(JSON.parse(designBytes.toString("utf8")));
    const verification = spawnSync(
      process.execPath,
      [path.join(here, "verify.mjs"), "--candidate", candidateId],
      {
        cwd: here,
        encoding: "utf8",
        timeout: 150_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    if (verification.error || ![0, 1].includes(verification.status)) {
      throw new Error(
        verification.error?.message ||
          `candidate verification exited ${verification.status}: ${verification.stderr || verification.stdout}`,
      );
    }
    record.verification = JSON.parse(verification.stdout);
    record.status = classifyCandidateVerification(record.verification);
    record.verification_exit_code = verification.status;
  } catch (error) {
    record.status = "infrastructure_or_source_error";
    record.error = error instanceof Error ? error.message : String(error);
  }

  await mkdir(buildRoot, { recursive: true });
  await appendFile(historyPath, `${JSON.stringify(record)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  return record.status === "passed" ? 0 : record.status === "failed_requirements" ? 1 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runCandidateLoop();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

export interface HealthResponse {
  schema_version: 1;
  service: "eda-studio-api";
  status: "ok";
  api_version: string;
  build_version: string;
}

export interface ToolchainEntry {
  status: "available" | "unavailable" | "error";
  version?: string | null;
  executable?: string | null;
  reason?: string | null;
}

export interface ToolchainResponse {
  schema_version: 1;
  checked_at_utc: string;
  tools: Record<string, ToolchainEntry>;
}

export interface ProjectSummary {
  project_id: string;
  name: string;
  entrypoint: string;
  source_file_count: number;
}

export interface ProjectListResponse {
  schema_version: 1;
  workspace_status: "available" | "not_configured" | "unavailable";
  workspace_name?: string | null;
  projects: ProjectSummary[];
}

export interface ProjectDetailResponse extends ProjectSummary {
  schema_version: 1;
  source_files: Array<{ path: string; bytes: number }>;
}

export interface SessionResponse {
  schema_version: 1;
  session_token: string;
}

export interface ArtifactDigest {
  sha256: string;
  bytes: number;
}

export interface CompileResponse {
  schema_version: 1;
  status: "compiled";
  project_id: string;
  project_name: string;
  build_id: string;
  manifest_sha256: string;
  created_at_utc: string;
  entrypoint: string;
  source_files: Array<{ path: string; sha256: string; bytes: number }>;
  circuit_json_sha256: string;
  source_graph_sha256: string;
  kicad_export_files: string[];
  source_graph_counts: { components: number; ports: number; nets: number };
  parts_verification: { status: string; unresolved: number; sha256: string };
  toolchain: {
    node: string;
    tscircuit: string;
    react: string;
    compiler_runtime: string;
    compiler_lock_sha256: string;
    sandbox_image: string;
    circuit_json_to_kicad: string;
    worker: string;
  };
  artifacts: Record<string, ArtifactDigest>;
}

export class StudioApiError extends Error {
  readonly code?: string;
  readonly details: string[];

  constructor(message: string, code?: string, details: string[] = []) {
    super(message);
    this.name = "StudioApiError";
    this.code = code;
    this.details = details;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function string(value: unknown): value is string {
  return typeof value === "string";
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function safeRelativePath(value: unknown): value is string {
  return string(value) && value.length > 0 && !value.startsWith("/") && !value.includes("\\") && !value.includes(":") &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function invalidContract(path: string): never {
  throw new StudioApiError(`The local API returned an invalid ${path} response.`, "INVALID_RESPONSE");
}

function parseHealth(value: unknown): HealthResponse {
  const data = record(value);
  if (
    data?.schema_version !== 1 || data.service !== "eda-studio-api" || data.status !== "ok" ||
    !string(data.api_version) || !string(data.build_version)
  ) return invalidContract("health");
  return data as unknown as HealthResponse;
}

function parseToolchain(value: unknown): ToolchainResponse {
  const data = record(value);
  const tools = record(data?.tools);
  if (data?.schema_version !== 1 || !string(data.checked_at_utc) || !tools || Number.isNaN(Date.parse(data.checked_at_utc))) {
    return invalidContract("toolchain");
  }
  for (const [name, rawEntry] of Object.entries(tools)) {
    const entry = record(rawEntry);
    if (!entry || !["available", "unavailable", "error"].includes(String(entry.status))) {
      return invalidContract(`toolchain entry ${name}`);
    }
    for (const field of ["version", "executable", "reason"] as const) {
      if (entry[field] !== undefined && entry[field] !== null && !string(entry[field])) {
        return invalidContract(`toolchain entry ${name}`);
      }
    }
  }
  return data as unknown as ToolchainResponse;
}

function parseProjectSummary(value: unknown): ProjectSummary {
  const data = record(value);
  if (
    !data || !string(data.project_id) || !/^[a-z][a-z0-9-]{0,62}$/.test(data.project_id) ||
    !string(data.name) || !safeRelativePath(data.entrypoint) || !nonNegativeInteger(data.source_file_count) || data.source_file_count < 1
  ) return invalidContract("project");
  return data as unknown as ProjectSummary;
}

function parseProjects(value: unknown): ProjectListResponse {
  const data = record(value);
  if (
    data?.schema_version !== 1 ||
    !["available", "not_configured", "unavailable"].includes(String(data.workspace_status)) ||
    (data.workspace_name !== undefined && data.workspace_name !== null && !string(data.workspace_name)) ||
    !Array.isArray(data.projects)
  ) return invalidContract("projects");
  return {
    schema_version: 1,
    workspace_status: data.workspace_status as ProjectListResponse["workspace_status"],
    workspace_name: data.workspace_name as string | null | undefined,
    projects: data.projects.map(parseProjectSummary),
  };
}

function parseProjectDetail(value: unknown): ProjectDetailResponse {
  const data = record(value);
  const summary = parseProjectSummary(data);
  if (data?.schema_version !== 1 || !Array.isArray(data.source_files)) return invalidContract("project detail");
  const sourceFiles = data.source_files.map((item) => {
    const source = record(item);
    if (!source || !safeRelativePath(source.path) || !nonNegativeInteger(source.bytes)) return invalidContract("project source file");
    return { path: source.path, bytes: source.bytes };
  });
  if (sourceFiles.length !== summary.source_file_count) return invalidContract("project detail");
  return { schema_version: 1, ...summary, source_files: sourceFiles };
}

function parseSession(value: unknown): SessionResponse {
  const data = record(value);
  if (data?.schema_version !== 1 || !string(data.session_token) || data.session_token.length < 32) {
    return invalidContract("session");
  }
  return data as unknown as SessionResponse;
}

function parseCompile(value: unknown): CompileResponse {
  const data = record(value);
  const counts = record(data?.source_graph_counts);
  const parts = record(data?.parts_verification);
  const toolchain = record(data?.toolchain);
  const artifacts = record(data?.artifacts);
  const sourceFiles = data?.source_files;
  const kicadExports = data?.kicad_export_files;
  if (
    data?.schema_version !== 1 || data.status !== "compiled" || !string(data.project_id) ||
    !string(data.project_name) || !string(data.build_id) || !/^[a-f0-9]{32}$/.test(data.build_id) ||
    !string(data.manifest_sha256) || !/^[a-f0-9]{64}$/.test(data.manifest_sha256) ||
    !string(data.created_at_utc) || Number.isNaN(Date.parse(data.created_at_utc)) || !safeRelativePath(data.entrypoint) ||
    !Array.isArray(sourceFiles) || !Array.isArray(kicadExports) ||
    !string(data.circuit_json_sha256) || !/^[a-f0-9]{64}$/.test(data.circuit_json_sha256) ||
    !string(data.source_graph_sha256) || !/^[a-f0-9]{64}$/.test(data.source_graph_sha256) ||
    !counts || !nonNegativeInteger(counts.components) || !nonNegativeInteger(counts.ports) || !nonNegativeInteger(counts.nets) ||
    !parts || !string(parts.status) || !nonNegativeInteger(parts.unresolved) || !string(parts.sha256) ||
    !/^[a-f0-9]{64}$/.test(parts.sha256) || !toolchain || !artifacts
  ) return invalidContract("compile");
  for (const field of ["node", "tscircuit", "react", "compiler_runtime", "compiler_lock_sha256", "sandbox_image", "circuit_json_to_kicad", "worker"] as const) {
    if (!string(toolchain[field])) return invalidContract("compile toolchain");
  }
  if (
    !string(toolchain.compiler_lock_sha256) || !/^[a-f0-9]{64}$/.test(toolchain.compiler_lock_sha256) ||
    !string(toolchain.sandbox_image) || !/^sha256:[a-f0-9]{64}$/.test(toolchain.sandbox_image)
  ) {
    return invalidContract("compile toolchain");
  }
  const sourcePaths = new Set<string>();
  for (const rawSource of sourceFiles) {
    const source = record(rawSource);
    if (!source || !safeRelativePath(source.path) || !string(source.sha256) || !/^[a-f0-9]{64}$/.test(source.sha256) || !nonNegativeInteger(source.bytes)) {
      return invalidContract("compile source index");
    }
    if (sourcePaths.has(source.path)) return invalidContract("compile source index");
    sourcePaths.add(source.path);
  }
  if (!sourcePaths.has(data.entrypoint)) return invalidContract("compile source index");
  const exportPaths = new Set<string>();
  for (const exportPath of kicadExports) {
    if (!safeRelativePath(exportPath) || exportPaths.has(exportPath)) return invalidContract("KiCad export index");
    exportPaths.add(exportPath);
  }
  const artifactDigests = new Map<string, string>();
  for (const [path, rawDigest] of Object.entries(artifacts)) {
    const digest = record(rawDigest);
    if (!safeRelativePath(path) || !digest || !string(digest.sha256) || !/^[a-f0-9]{64}$/.test(digest.sha256) || !nonNegativeInteger(digest.bytes)) {
      return invalidContract("artifact index");
    }
    artifactDigests.set(path, digest.sha256);
  }
  if (
    artifactDigests.get("circuit.json") !== data.circuit_json_sha256 ||
    artifactDigests.get("source-graph.json") !== data.source_graph_sha256 ||
    exportPaths.size !== [...exportPaths].filter((path) => artifactDigests.has(path)).length
  ) return invalidContract("compile artifact relationships");
  return data as unknown as CompileResponse;
}

async function getJson<T>(path: string, parse: (value: unknown) => T, timeoutMs = 8_000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const envelope = record(body);
      const error = record(envelope?.error);
      const message = string(error?.message) ? error.message : `Local API returned HTTP ${response.status}.`;
      const code = string(error?.code) ? error.code : undefined;
      const details = Array.isArray(error?.details) ? error.details.filter(string) : [];
      throw new StudioApiError(message, code, details);
    }
    return parse(body);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new StudioApiError("The local API request timed out. Check that Studio is running and try again.", "TIMEOUT");
    }
    if (error instanceof StudioApiError) throw error;
    throw new StudioApiError("The local API could not be reached. Check that Studio is running and try again.", "NETWORK_ERROR");
  } finally {
    window.clearTimeout(timer);
  }
}

async function postJson<T>(path: string, token: string, parse: (value: unknown) => T, timeoutMs = 120_000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: controller.signal,
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const envelope = record(body);
      const error = record(envelope?.error);
      const message = string(error?.message) ? error.message : `Local API returned HTTP ${response.status}.`;
      const code = string(error?.code) ? error.code : undefined;
      const details = Array.isArray(error?.details) ? error.details.filter(string) : [];
      throw new StudioApiError(message, code, details);
    }
    return parse(body);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new StudioApiError("Compilation timed out while waiting for the local API.", "TIMEOUT");
    }
    if (error instanceof StudioApiError) throw error;
    throw new StudioApiError("The local API could not complete the compile request.", "NETWORK_ERROR");
  } finally {
    window.clearTimeout(timer);
  }
}

export const studioApi = {
  getHealth: () => getJson("/api/v1/health", parseHealth, 4_000),
  getToolchain: () => getJson("/api/v1/toolchain", parseToolchain, 10_000),
  getProjects: () => getJson("/api/v1/projects", parseProjects),
  getProject: (projectId: string) => getJson(`/api/v1/projects/${encodeURIComponent(projectId)}`, parseProjectDetail),
  getSession: () => getJson("/api/v1/session", parseSession),
  compileProject: (projectId: string, token: string) =>
    postJson(`/api/v1/projects/${encodeURIComponent(projectId)}/compile`, token, parseCompile),
};

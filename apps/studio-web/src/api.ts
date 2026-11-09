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
  reason?: string | null;
}

export interface ToolchainResponse {
  schema_version: 1;
  checked_at_utc: string;
  tools: Record<string, ToolchainEntry>;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Local API returned HTTP ${response.status}.`);
  }
  return response.json() as Promise<T>;
}

export const studioApi = {
  getHealth: () => getJson<HealthResponse>("/api/v1/health"),
  getToolchain: () => getJson<ToolchainResponse>("/api/v1/toolchain"),
};

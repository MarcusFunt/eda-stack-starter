import { existsSync } from "node:fs";
import path from "node:path";

export function resolvePython(projectRoot, { platform = process.platform, exists = existsSync } = {}) {
  const platformPath = platform === "win32" ? path.win32 : path.posix;
  const virtualenvPython = platform === "win32"
    ? platformPath.join(projectRoot, ".venv", "Scripts", "python.exe")
    : platformPath.join(projectRoot, ".venv", "bin", "python");
  return exists(virtualenvPython) ? virtualenvPython : platform === "win32" ? "python" : "python3";
}

import path from "node:path";
import { lstatSync } from "node:fs";

export function assertPathsDisjoint(namedPaths, pathApi = path) {
  const entries = Object.entries(namedPaths);
  for (const [name, target] of entries) {
    if (!pathApi.isAbsolute(target)) throw new Error(name + " path must be absolute");
  }
  const contains = (parent, child) => {
    const relative = pathApi.relative(parent, child);
    return relative === "" || (!pathApi.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + pathApi.sep));
  };
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const [leftName, leftPath] = entries[left];
      const [rightName, rightPath] = entries[right];
      if (contains(leftPath, rightPath) || contains(rightPath, leftPath)) {
        throw new Error("Workspace paths must not overlap: " + leftName + " and " + rightName);
      }
    }
  }
  return true;
}

export function workspaceRelativePath(projectRoot, targetPath, pathApi = path) {
  const relative = pathApi.relative(projectRoot, targetPath);
  if (
    !relative ||
    pathApi.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(".." + pathApi.sep)
  ) {
    throw new Error("Path must resolve inside the repository workspace");
  }

  if (pathApi === path) {
    let candidate = projectRoot;
    for (const segment of relative.split(pathApi.sep)) {
      candidate = pathApi.join(candidate, segment);
      try {
        if (lstatSync(candidate).isSymbolicLink()) {
          throw new Error("Path must not traverse a symbolic link outside the repository workspace");
        }
      } catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") break;
        throw error;
      }
    }
  }

  return relative;
}

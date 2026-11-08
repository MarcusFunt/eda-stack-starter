export function dockerUserOptions({
  platform = process.platform,
  uid = process.getuid?.(),
  gid = process.getgid?.(),
} = {}) {
  if (platform === "win32") return [];
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
    throw new Error("KiCad container runs on POSIX require the host UID and GID");
  }
  return ["--user", uid + ":" + gid, "--env", "HOME=/tmp"];
}

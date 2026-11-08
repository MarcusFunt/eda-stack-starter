import assert from "node:assert/strict";
import { test } from "node:test";
import { dockerUserOptions } from "./kicad-container.mjs";

test("runs KiCad as the host user on POSIX bind mounts", () => {
  assert.deepEqual(dockerUserOptions({ platform: "linux", uid: 1001, gid: 122 }), [
    "--user",
    "1001:122",
    "--env",
    "HOME=/tmp",
  ]);
});

test("leaves Docker Desktop user mapping to the container on Windows", () => {
  assert.deepEqual(dockerUserOptions({ platform: "win32" }), []);
});

test("requires a numeric host identity for POSIX container runs", () => {
  assert.throws(() => dockerUserOptions({ platform: "linux" }), /host UID and GID/);
});

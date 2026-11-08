import { buildSandboxImage } from "../src/build.js";

await buildSandboxImage(process.argv[2] ?? "docker");

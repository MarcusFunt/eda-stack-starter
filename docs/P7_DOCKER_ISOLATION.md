# P7 isolated ngspice execution

**Status: implemented as an opt-in local execution mode.** Validated on 2026-11-07 with Docker Desktop 29.9.2 on Windows, using the digest-pinned `kicad/kicad` image `sha256:3f4a01786dfbe803a65f345c3342b765db9add913f5e9448f8356793714ddc34`. That image reports ngspice 44.2; the normal host path remains available and the image version is recorded in reports.

## Isolation behavior

Use `edastack verify <spec> --isolation docker`. The mode requires Docker and a locally available image pinned by SHA-256; it never pulls an image during a verification run. Each scenario runs in a fresh container. Before starting ngspice, the runner inspects the created container and refuses to proceed unless the inspected configuration confirms:

- No network, read-only root filesystem, all Linux capabilities dropped, and `no-new-privileges`.
- Unprivileged UID/GID 65534:65534.
- Disabled Docker daemon log driver; simulator output is written to `ngspice.log` inside the bounded output tmpfs.
- The configured memory, CPU, and PID limits.
- Only two read-only host bind mounts: the staged SPICE input closure and the generated input deck.
- A bounded 512 MiB output tmpfs and 64 MiB temporary tmpfs, both mounted `noexec`, `nosuid`, and `nodev` by default.

The per-scenario timeout also applies in container mode. Input staging follows static relative `.include` and `.lib` paths recursively, rejects missing or out-of-project paths, dynamic include expressions, non-UTF-8 files, and closures over the configured size/count limits. The report and run manifest record the image digest and all selected limits.

Defaults are 1 GiB memory, 1 CPU, 64 processes, 512 MiB writable output, 128 MiB of staged input, and a 90-second scenario timeout. Resource limits are configurable on the CLI and MCP tool. The Docker daemon, its host kernel, and image provenance remain trusted; this container mode is not a virtual machine or a guarantee against kernel/daemon vulnerabilities. Host execution remains the compatibility default, so select Docker mode explicitly when the added boundary is required.

## Local evidence

- `build/docker-isolation/logging-verified/report.json`: all three RC scenarios passed on containerized ngspice 44.2 with the inspected `none` logging driver. The nominal output at 100 µs was 3.160593 V.
- `build/docker-isolation/included-model-logging-verified/report.json`: the versioned two-pin model fixture passed with recursive include staging and the inspected `none` logging driver.
- `build/docker-isolation/fault-output/report.json`: a deliberate 3 kΩ fault failed the `vout_100u`, rise-time, and peak-output checks inside the container.
- `tests/test_container_isolation.py`: resource validation, inspected-container policy, recursive input staging, project escape rejection, and timeout cleanup tests.

The `build/` evidence is local and ignored by Git. The committed test and documentation files preserve the procedure and recorded results.

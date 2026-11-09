# Development Baseline — 2026-11-09

Captured 2026-11-09 17:09 UTC in `D:\ElectronicsDesignAI\eda-stack-starter`. Remote: `origin` → `https://github.com/MarcusFunt/eda-stack-starter.git`.

## Reviewed refs

| Ref | SHA | State at capture |
| --- | --- | --- |
| `origin/main` | `01ae82f0499a5aca2c936a40e2a680709fc91ab6` | Latest main; local `main` was five commits behind. CI run `42620351524` failed. |
| `origin/feat/dashboard-m1-interactive` | `ea1f541a3809d1f4139c0f497cbed86eab50e635` | Two commits ahead of `origin/main`; CI run `42650650475` passed 19/19 jobs. |
| `origin/feat/typed-constraints-topola` | `3d85cb4728baaa311c19f34a6fb3ca665c289005` | One commit ahead of main; contains typed electrical constraints and a Topola placement-mutation benchmark (3,398 added lines across 10 files). |
| `origin/feat/general-eda-erc-spice-routing` | `a9d07e9dd2dd4eb0feb1f01b84e8d272499c4147` | Seven commits behind main; working tree clean. |
| `origin/feat/general-kicad-export-spike` | `21604d1ab447230c8cdd727f3fe0221468c21940` | Eleven commits behind main; working tree clean apart from the untracked Atopile materials below. |

The Studio branch delta consists of `422722d` (project compile workflow) and `ea1f541` (Python-version-stable OpenAPI validation descriptions), touching Studio API/UI, contracts, CI, and tests. No force-pushes or cleanup actions were performed.

## Worktree preservation map

| Worktree | Branch / HEAD | Uncommitted or untracked state | Action |
| --- | --- | --- | --- |
| repository root | `feat/dashboard-m1-interactive` / `ea1f541` | Clean at start of the audit; Milestone 0.3/0.4 fixes are now local edits. | Preserve and submit through the existing feature branch. |
| `.worktrees/eda-constraint-topola` | `feat/typed-constraints-topola` / `3d85cb4` | Clean; committed experiment is not in main. | Preserve; separate research track. |
| `.worktrees/eda-general-dev` | `feat/general-eda-erc-spice-routing` / `a9d07e9` | Clean. | Preserve. |
| `.worktrees/eda-pr02` | `feat/arbitrary-tsx-project-compiler` / `fe53ecae` | Clean; one local commit ahead of `origin/feat/general-kicad-export-spike`. | Preserve; local-only commit. |
| `.worktrees/eda-roadmap` | `feat/general-kicad-export-spike` / `21604d1` | Untracked `integrations/atopile-rc/` containing `.venv/` and `design/`. | Preserve; not reviewed or deleted. |
| `.worktrees/origin-main-review-fixes` | `fix/origin-main-review-findings` / `b016614` | Clean; four commits behind current main. | Preserve. |
| `.worktrees/studio-s0-foundation` | `studio/s0-foundation` / `f803784` | Untracked `.venv-studio/`. | Preserve; not reviewed or deleted. |

## CI findings at capture

The failing main run `42620351524` reported four Ruff findings, unittest discovery errors because pytest was missing on Python 3.11, and the same pytest import failure in the real-ngspice job. The feature branch run `42650650475` passed all 19 jobs, including Studio API, browser compile, native KiCad and real ngspice.

## Local tool versions

| Tool | Version / location |
| --- | --- |
| Git | `2.44.0.windows.1` |
| Python | `3.11.4` |
| pytest | `9.2.0` |
| Ruff | `0.16.8` |
| Node.js | `v24.15.0` |
| npm | `11.12.1` |
| Docker | `29.9.2`, build `a82e528` |
| KiCad CLI | `7.0.6`, `C:\Program Files\KiCad\7.0\bin\kicad-cli.exe` |
| ngspice | Not found by Studio discovery or on `PATH` at capture. |
| tscircuit sandbox | Available, image `sha256:49319c94db90011ec83fad1cb00d1b789da9518eaa51178d4a195e0a22deec45` |

## Milestone 0 status

- 0.1 branch/worktree inventory recorded; all unrelated and untracked work remains preserved.
- 0.2 awaiting the M0 fixes, a PR check run, merge, and post-merge CI.
- 0.3 concise explicit IDs have been added to the deeply nested and oversized manifest test cases.
- 0.4 Export remains disabled after compilation; Verify remains explicitly unavailable. Browser assertions cover these states and Compile enablement.

# EDA Studio product spec

**Status:** Initial S0 scope. The API foundation, compile spike, contract fixtures and routed React/Vite shell are implemented as described in `ARCHITECTURE.md`. Project creation/import and revision workflows remain requirements for later slices.

## Users

- **Circuit designer:** authors a tscircuit project and needs compile, graph inspection and electrical verification without losing the source revision that produced each result.
- **Verification engineer:** defines bounded analyses, reviews failures and traces each result to its requirement, source net and simulator evidence.
- **Physical design reviewer:** checks parts, pin maps, KiCad ERC/DRC, board constraints and manufacturing evidence before release.
- **Release approver:** decides whether a specific immutable revision and evidence bundle may be approved for a stated scope.

## First user journey

1. Create or import a valid TSX project into a configured local workspace.
2. Edit authoritative TSX and reviewed configuration as a draft; see a source diff before saving.
3. Freeze a candidate revision that records the exact source/configuration hashes and toolchain profile.
4. Compile the frozen project in the existing isolated tscircuit worker.
5. Inspect the derived Circuit JSON, source graph, stable IDs and compiler manifest.
6. Run explicit ngspice analyses and requirements; inspect measurements, logs and waveforms.
7. Compare results only when analysis, model, unit and requirement semantics are compatible.
8. Review native KiCad/ERC/DRC and physical pin evidence before any release decision.
9. Export a portable evidence bundle whose hashes reopen and verify independently.

The current compile route is an S0 spike against a working project folder. Revisions, durable jobs, the schematic viewer, simulation UI, native KiCad review and release flow remain future milestones.

## MVP boundaries

The MVP is useful with AI disabled. It includes project create/import, draft source editing, frozen revisions, sandboxed compile, a source-linked design viewer, real ngspice verification, durable job history, evidence export and honest `not_run`/`unsupported` states.

The first release does not replace KiCad's schematic or PCB editor, promise general autorouting, order parts, provide cloud collaboration, or claim safety-standard compliance from simulation or DRC alone.

## Product rules

- TSX and reviewed project configuration remain the editable source of truth; Circuit JSON, SPICE and KiCad files are derived.
- `compiled` means the compiler produced validated output. It does not mean electrical, ERC, DRC, physical or manufacturing checks passed.
- A user request to compile or verify does not authorize source edits. Accepting a proposal creates a new revision.
- An absent check is `not_run` or `unsupported`, never `passed`.
- Approvals bind to exact revision and evidence hashes and expire when any bound source changes.

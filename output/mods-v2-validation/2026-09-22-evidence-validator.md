# Mods v2 evidence and validator validation — 2026-09-22

Workspace: `C:\ai\CmbCoworkAgent-mods-v2`
Branch: `codex/mods-v2`
Starting implementation commit: `beed7715`
Evidence/policy commit: `b98785ae`
Validator contract fix: `140d9e28`

## Scope

This increment adds host-owned completion evidence binding, durable evidence idempotency and restart interruption recovery, strict DIY completion policy parsing, production run identity propagation, a pinned Autobiz compiler/validator bridge, and a persisted Autobiz configuration pane. The validator process reads state and artifacts and never invokes the upstream state repair command.

The trusted Autobiz source is `C:\ai\autobiz_kanban`, commit `8db1ec937d6ed3d271cb9dc540310d6633c91e70`. The requested `C:\ai\autobiz\_kanban` path is absent; no source was modified.

## Tests

- Node 22 Vitest policy/evidence/validator/control-store: **26 passed, 0 failed**.
- Node 22 manager and completion-loop regression: **36 passed, 0 failed**.
- Node 22 typecheck: **passed** (`tsconfig.node.json`).
- Web typecheck: **passed**.
- ESLint on changed production/test files: **passed**.
- Production Mods Electron E2E: **38 passed, 0 failed**; the final log is `2026-09-22-production-e2e.log`.
- Full repository suite remains unclassified because it was not isolated against a clean pre-change run.

## Evidence properties

The binding includes workspace, thread, turn, run, plugin digests, runtime generation, diff fingerprint, requirement fingerprint, configuration fingerprint, and bounded file fingerprints. A changed file, requirement, configuration, plugin digest, generation, cancellation, revocation, or runtime replacement invalidates the attempt. Duplicate event keys are ignored by SQLite, and running evidence is marked `interrupted` on restart. Guest review results are stored as opinions and are not marked as business acceptance.

## Remaining work

Real checkpoint CAS/state transition, actual unit/E2E host runners, full Claude compatibility matrix adapters and evidence, complete UI evidence rendering, package/documentation updates, performance/disabled-mode comparison, and final installation verification remain to be implemented and tested.

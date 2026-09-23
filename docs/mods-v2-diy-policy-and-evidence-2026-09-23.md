# Mods v2 DIY policy and trusted completion evidence — 2026-09-23

## Implemented behavior

The project `completion-config` is authoritative. Off policies are removed before evidence capture, guest completion checks, native model calls, or host test/validator execution. An unrelated loaded plugin without `completion.check` cannot keep an off gate alive. Report policies preserve advisory failures without blocking another mandatory policy. Selecting only host checks skips plugin code review; selecting code review without an actual provider blocks completion.

Check mode cannot request repair. Repair mode uses the smallest applicable repair allowance and the existing completion revision loop. Multiple mandatory policies share one host-owned total model budget and absolute deadline, created when the completion gate is created rather than after classic completion hooks have already run. Report-only policies have separate advisory budgets. The budget counts actual provider input and output, reserves conservatively before dispatch, caps output at available capacity, and fails closed on missing usage, pending detached requests, or swallowed budget errors. The SDK keeps its original authority, grant, lease, model-admission and host-call audit path; the original Agent revision loop is integrated separately by the completion-loop workstream.

The deadline covers initial capture, guest work, actual host test/validator processes and final recapture. A host process receives the remaining time, not a fresh copy of the configured timeout. Caller cancellation and authority invalidation still reject instead of becoming successful advisory completion. Each invocation recaptures its binding; no cached PASS is reused.

Bindings now include staged-only files as well as unstaged, deleted and untracked files. The optional `diffFiles` list is captured alongside the diff fingerprint. Existing persisted evidence without that field remains readable. Configuration, runtime generation, plugin digests, requirements and file contents remain bound by the original evidence mechanism.

## Configuring and interpreting the example

The Autobiz example reads canonical `completion-config`; stale `review-mode` and `review-target` aliases cannot override it. `/kanban-mode` and `/kanban-target` update the canonical policy. The Pane supports multiple selected checks, target, Feature, repair count, duration and input-plus-output total model budget.

Code-review scope is explicit:

- File: the configured relative target.
- Diff: actual staged, unstaged, deleted and untracked Git paths supplied by the host. A non-Git project cannot claim a current diff.
- Feature: the Feature requirement/artifact directory plus an explicitly selected implementation target, or current changed implementation files. Missing requirements or missing implementation selection blocks review; the example does not infer arbitrary code ownership.
- Project: every file in the host project binding, subject to the existing excluded generated/dependency directories.

The example review is bounded to 32 text files, 12,000 characters per file and 48,000 total characters. Oversized, binary, deleted, unbound or unavailable inputs block rather than being silently omitted. These bounds are a supported execution limit, not evidence of whole-project success after truncation. Unit/E2E checks remain fixed project-level entrypoints; scope selection does not invent a test-runner-specific file filter. Autobiz validation remains a real separate compiler/validator check and is not replaced by model review.

Guest review results include steps, actual reviewed paths, reasons and next actions. Every result explicitly says plugin opinion is not test or business acceptance, and does not advance checkpoint. Reads are repeated after model review; manager recapture independently invalidates the full host evidence.

## Trusted evidence UI

`FunctionCompletionEvidence` reads the existing host SQLite evidence IPC. It never calls a guest, mounts a runtime, starts a check, or writes plugin state. The chat composer area displays recent records, rules used for that attempt, check source, failure reason, next action, actual recorded usage, requirement/diff/configuration fingerprints, plugin digests and file fingerprints. Output is escaped React text. Display bounds are explicit: 24 recent records and the first 24 file fingerprints per expanded record; stored evidence remains complete.

The UI labels plugin opinion separately from host unit/E2E/Autobiz results. A completion gate PASS is not labelled business acceptance. Historical records state that changed input requires rechecking. Global/project disabling hides the UI without deleting the audit history. Configuration reset, task replacement and unmount invalidate pending replies; in-flight refreshes are coalesced. `cardsChanged` after saving host evidence refreshes the view.

## Verification and limits

See `output/mods-v2-validation/2026-09-23-diy-policy-and-evidence.md` for red/green logs. Narrow tests use actual QuickJS sessions and the production manager, SQLite store, model adapter and a real child process where applicable. Model fixtures supply deterministic provider responses; they do not constitute business acceptance. Electron integration and installer acceptance are owned by the final integration run and must be reported separately for the same build snapshot.

# Explicit application checkpoint stage — 2026-09-24

Applications can opt into one Autobiz stage per completion. Project settings retain an explicit starting checkpoint and Feature ID; the pinned upstream compiler supplies the destination. Guest-owned completion-config cannot activate this mutation. Off/report or deselecting the validator clears the UI setting. Conflicting stages fail closed. Already at the destination means revalidate the same stage, never advance the next one.

The original completion loop validates and repairs through its existing revision callback, captures fresh evidence, runs the real fixed upstream validator, and submits the host-derived transition via the native authority adapter. Stage evidence must match both endpoints. Failed commits remove the in-memory completion proof. Successful ledger keys include workspace and thread so identical project-local idempotency keys cannot hide another project's receipt.

## Tests and review

- Configuration/compiler: eight red tests, then 25 passed. Original completion auto-stage: four red tests, then 18 passed.
- Added regression before fixing project-scope validation without an explicit Feature: failed, then passed. UI stage rendering also red then green. This preserves the existing read-only default.
- Cross-project shared-key regression: actual commits succeeded but the second ledger row was missing (red); now both project receipts are retained. A different destination cannot reuse a validator proof.
- Mods39: 130 files, 1103 passed and four failures, all existing stale-evidence error expectations. Reordered checks to preserve lifecycle/freshness errors before stage interpretation. Rerun both affected manager and real upstream integration files: 67/67 passed. Other 128 files had passed; no claim that the first run was fully green.
- Node and web typechecks passed. Scoped ESLint zero errors, seven existing formatting warnings; new files/changed sections formatted.
- Focused real Electron completed 12 checks and restored ordinary output: `2026-09-24-autobiz-stage-electron-2.log`. Fixed upstream validation, native rejection, approved journal commit, off comparison and repeat without another successful native write passed. First Electron attempt rejected an overbroad test assertion: existing evidence correctly invalidated after fixture files changed while off. The assertion now specifically verifies no new execution records and no native checkpoint write.
- Settings Electron completed ten checks including explicit stage save, report-mode clearing, project rules and settings lock after real Electron restart. Screenshots and JSON archived in `2026-09-24-auto-settings-electron-artifacts` and `2026-09-24-autobiz-stage-electron-2-artifacts`; screenshot inspected.
- Reviewed original lease/authority delegation, host-only config, exact stage proof, post-approval file checks, failure cleanup, bounded retries and unchanged disabled path.

## Scope limits

The actual pinned compiler/validator and journal execute in contract-fixture projects. The Electron model producer is a local test server. These are integration evidence, not final business acceptance, and do not prove model-driven repair quality on a real task.

No UAT changes, dependency installs or local installer builds. Actions packaging remains separate. Unknown-commit recovery UI and the real business demonstration remain open. Latest exclusive ingress performance still fails the documented budgets; disabled Electron controls establish no checkpoint execution, not performance acceptance. Formal desktop CPU/stream and two-hour soak remain required.

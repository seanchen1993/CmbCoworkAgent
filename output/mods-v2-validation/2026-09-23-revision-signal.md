# Completion revision deadline ingress — 2026-09-23

## Change

The three desktop revision closures (invoke, resume, interrupt) and the legacy IM
revision closure now forward the optional completion-budget signal to the existing
agent stream. IM also forwards the same signal to its stream consumer. Existing
stream settings, thread identity, leases, stream consumers and runtime ownership
are retained; omitting the optional signal preserves the original signal object.

Files: `src/main/ipc/agent.ts`, `src/main/services/im/remote-runner.ts`, and
`src/main/ipc/completion-revision-signal.test.ts`.

## Test-first evidence

- `2026-09-23-revision-signal-red.log`: four production closures failed signal
  identity checks before the change; the inventory check passed (1/5 green).
- `2026-09-23-revision-signal-green.log`: all 5 tests passed after the change.
- The test uses TypeScript AST to extract and execute the actual production
  callbacks, with a controlled stream sink. It verifies every desktop/IM entry,
  deadline cancellation, unchanged original controller/config, and the signal
  consumed by IM. This is production wiring regression evidence, not an Electron,
  provider, subprocess cancellation or business acceptance test.
- `2026-09-23-revision-signal-eslint.json`: zero errors. The new test and IM file
  have zero warnings. The large desktop IPC file has 4,161 existing formatting
  warnings, equal to its HEAD baseline in
  `2026-09-23-revision-signal-eslint-baseline.json`; no broad formatting performed.
- `git diff --check`: passed (repository line-ending conversion warnings only).

Command: Node 22 `node_modules/vitest/vitest.mjs run
src/main/ipc/completion-revision-signal.test.ts`.

## Integration boundary

The first full Node typecheck captured concurrent work before the completion-hooks
two-argument callback signature was saved, plus two independently edited test
errors (`2026-09-23-revision-signal-typecheck.log`). Its owner subsequently confirmed
the signature and unused import were fixed; the unified typecheck is pending with
that owner. No typecheck pass is claimed by this log.

The completion-loop owner separately validates generation of the scoped deadline,
budget accounting and cancellation of runtime tools/subagents. Root owns combined
Electron and packaging validation. This patch does not replace those checks.

No build, installation, formal performance matrix, shared dependency mutation,
UAT worktree modification or commit was performed for this change.

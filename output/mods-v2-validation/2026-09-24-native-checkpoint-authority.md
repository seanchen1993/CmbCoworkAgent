# Native checkpoint authority bridge — 2026-09-24

Checkpoint mutation now passes through the original ModsManager capability dispatcher, FunctionSession grant, runtime authority, active thread run lease, original approval and native write permissions for both state.json and STATE.md. The adapter fixes the operation metadata and rejects changed arguments before committing. It rechecks native path permissions after approval and requires the original successful execution receipt; plugin output cannot manufacture a commit. The host callback is internal and is not a new Claude Function SDK API.

## Review and regression evidence

- Initial missing-adapter regression failed because valid validator evidence could write state directly. Native authority tests were added before implementation; they cover missing lease, read-only/role restrictions, denied write/edit access, rejected approval, path escape, cancellation, revocation, runtime replacement, lease handoff and permission changes during approval.
- Native tool/session integration: 37 tests; actual fixed upstream compiler/validator plus native authority/journal: 13 tests. Their artifacts and transparent lower-level test callbacks are contract fixtures, not real business acceptance.
- Mods38: 130 files / 1087 tests passed. Node and web typechecks passed. Scoped ESLint: zero errors, seven existing formatting warnings.
- Real Electron original agent loop: 2026-09-24-autobiz-stage-electron-2.log completed with 12 checks, restored ordinary build. Includes off versus on, native approval rejection, actual pinned validator and Windows journal commit, and repeated completion without another successful checkpoint write. The automatic caller is delivered separately in the subsequent stage capability commit. Model responses and business artifacts in this test are fixtures.
- Code review verified fixed native target, original dispatch/lease lifecycle, two mandatory path checks, trusted receipt consumption and guarded callback cleanup. Neither a published tool message nor a guest decision establishes state advancement.

## Limits retained

No UAT changes or dependency installation. No local installer build; packaging remains GitHub Actions work. This does not claim a transaction across all project files, completed unknown-commit recovery UX, a real business demonstration, or full Claude parity.

Performance is not accepted: latest qualified ingress run still exceeded the 15 ms one-plugin p95 and two off rounds exceeded 5%. Off-path Electron checks show no native checkpoint execution. They are functional controls, not a replacement for the pending exclusive desktop performance and two-hour soak gates.

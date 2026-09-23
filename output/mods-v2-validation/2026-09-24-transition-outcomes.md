# Checkpoint transition lifecycle and durable outcomes

Base 35170ce4, codex/mods-v2. Only Mods-v2 changed; UAT and shared dependencies untouched.

## Change and review

Persist state.transition.started before native approval or physical I/O. Insert the terminal fact and settle the matching workspace/thread/turn/run/attempt atomically. Start records cannot claim PASS; completed means only the step ended. Restart turns unfinished starts into interrupted without replay. A unique confirmation attempt prevents an existing idempotent receipt from leaving a new start permanently running.

Capture the trusted host commit callback outcome before the native adapter finishes. If approval throws, persist the reason; if revocation follows a physical commit, preserve applied/operationId as interrupted with businessAccepted=false, never PASS. Original native authority, grant, lease, cancellation and pinned upstream journal remain in force. The guest cannot publish a receipt. UI distinguishes known writes with unfinished confirmation, unknown commits, and duplicate confirmations without another write.

Reviewed cancellation and grant checks, immutable event keys, transaction ordering, workspace isolation, exception paths and restart. This is historical evidence, not a general atomic filesystem transaction or a complete reconciliation UI. A process death before receipt persistence still requires journal/state inspection.

## Validation

- Initial regression: four failures, then three files / 32 tests passed (transition-outcome-red/green logs).
- Storage start-status and duplicate UI: two additional failures, then three files / 24 tests passed, including real SIGKILL / SQLite reopen (transition-boundary-red/green).
- Real FunctionSession/native tool/Autobiz regression: three files / 106 tests passed (transition-regression).
- Node and Web typecheck passed; scoped ESLint zero errors, seven existing formatting warnings (transition-node/web/eslint-final).
- Real Electron focused completion suite: 12 checks passed, ordinary build restored. transition-electron-artifacts includes actual approval rejection, settled attempt markers, original native write, repeat no extra write, off task comparison, file invalidation and recovery UI. Model and business artifacts here are contract fixtures, not business acceptance.
- Compatibility documentation checks: two files / 19 tests passed separately; matrix statuses were not upgraded.
- Off comparison executes no gate/checkpoint tool and creates no new execution records. Existing formal performance is NOT passing: desktop full3 qualified with TTFT +203ms; see desktop-performance-full3 report. No new release performance claim or two-hour soak claim.

Real model business demonstration remains in progress separately. No installation package is claimed; GitHub Actions delivery remains pending.

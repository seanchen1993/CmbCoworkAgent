# Completion evidence freshness — 2026-09-23

- Tests first: missing monitor module failed; real QuickJS/FunctionSession manager tests then
  reproduced absent stale events after file mutation, runtime replacement, off and revocation.
  A test fixture initially used the wrong state SDK; corrected to $.store and asserted command
  output. Additional red tests reproduced late-history summary corruption and storage failure
  blocking teardown before their respective fixes.
- Monitor tests: 7 passed (coalescing, unchanged content, changed content, event during recheck,
  timeout, cancellation, retention/idle, sink failure across the covered cases).
- Real guest/manager integration: 9 passed, including source/config changes and re-opening an
  on-disk ledger in a new manager without loading a guest. Crash-generation injection separately
  checks recovery without an orderly close. This is not an Electron process-kill test.
- Related regressions: 55 passed across six files (policy, evidence capture, shared watcher,
  monitor, integration, event bridge); 62 passed across five files including existing manager/UI;
  final targeted set 33 passed including control store and ten real pinned Autobiz integration
  tests. Counts overlap and are not summed. Autobiz tests run against the current working tree,
  including its pending CAS changes; they are not final business-demo acceptance.
- Node and Web typecheck passed with repository --composite false. Changed-file ESLint exits 0.
  A first lint run found an empty test stop method, subsequently corrected; existing files still
  carry unrelated formatting warnings.
- Focused production Electron: 4 checks, exit 0, ordinary build restored. Actual physical file
  mutation reaches the existing watcher, host ledger and React summary in 832ms in this run;
  same-content writes preserve validity. Model request count is unchanged and check.result count
  stays one. Off control completes an original model turn with no gate/evidence UI; stale records
  survive renderer reload. Artifacts: 2026-09-23-freshness-artifacts.
- Review: observers cannot block the existing renderer watcher feed; no extra watcher, interval,
  model, test or guest is created by freshness checks. Proof retention and sweep time are bounded.
  Matching uses the actual captured execution workspace as well as the project path. Checkpoint
  authorization remains separate, and its existing fresh capture is still required.
- This validates notification latency/idle/off boundaries, not formal five-round whole-app
  performance, an installer or the final Autobiz business demonstration. UAT was not modified.

- Final integrated Electron 16: **100 checks passed, exit 0**, ordinary output restored.
  Includes classic MCP receipt preservation, bounded feedback, the new freshness path and all
  previous integrated scenarios. Screenshot reviewed. Artifacts: 2026-09-23-electron-16-artifacts.
  Native read control: 500 interleaved samples/100 warmups per arm; absent baseline p95 3.5815ms,
  Mods off p95 3.5330ms (-1.3542%). Single run only. Noop1000 p95 14.0388ms with zero pending
  requests; this does not substitute for the remaining formal app performance gates.

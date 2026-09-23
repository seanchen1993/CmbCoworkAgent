# Status sites validation — 2026-09-23

Production sites: Spinner in ChatContainer; TurnDuration in MessageBubble;
SessionMode beside the preserved AgentModeSwitcher button. No session/manager
entry point or test-only bridge added. Native fallback is produced after host
publication, and duration owners are capped at 32 without evicting existing rows.

## Evidence

- `2026-09-23-status-sites-red.log`: initial 6 new regressions failed, 10 existing
  tests passed. Missing sites and replacement of the rich native fallback were
  reproduced before implementation.
- `2026-09-23-spinner-source-red.log`: new live-source projection test first failed
  because its implementation was absent.
- `2026-09-23-status-sites-green.log`: final **7 files / 41 tests passed**. This
  includes 17 real guest/session site tests, 3 renderer tests, 4 renderer lifecycle
  tests, 1 live-state projection test, 4 pinned-input tests, 7 existing DIY Pane
  tests (including corrected total-token label) and 5 revision-signal tests.
- Full Node TypeScript: `tsc --noEmit -p tsconfig.node.json --composite false`,
  **exit 0**, no diagnostics (exec session 99465).
- Full Web TypeScript: same options with `tsconfig.web.json`, **exit 0**, no
  diagnostics (exec session 68599).
- Independent Electron helper TypeScript:
  `2026-09-23-status-sites-helper-tsconfig.json`, **exit 0**, no diagnostics.
- `2026-09-23-status-sites-eslint.json`: 15 files, **0 errors**. Existing large
  renderer files still report formatting/CRLF warnings: AgentModeSwitcher 659,
  MessageBubble 1315, ChatContainer 41. Other checked files have zero warnings.
  These files were not broadly reformatted to hide those warnings.

Source review checked default-tree publication spoofing, callback owner/generation
binding, capacity without eviction, cancellation confined to the unmounted owner,
existing execution-mode controls and permissions, and honest absent `onScreen`.

## Electron handoff

`verifyStatusSites(page, root, workspace, artifacts, until, pass)` in
`tests/support/mods-status-sites-e2e.ts` creates an isolated project/thread and
installs `tests/fixtures/mods-v2/status-sites`. It uses real composer submissions,
the shared HTTP model fixture's existing `[stall]` response, and actual user-turn
cancellation. It writes `status-sites-native.png`, `status-sites-custom.png`,
`status-sites-off.png` and `status-sites-evidence.json` only when run successfully.

Root owns the combined Electron run. At source freeze, that run has **not yet been
claimed successful**. No local package, full application performance qualification,
formal ingress matrix, shared dependency mutation or UAT worktree change performed.
# Parent Electron verification

2026-09-23 focused production Electron run `electron-status-sites-2` passed all three site
scenarios plus initial opt-in: native/pass-through, custom Spinner/TurnDuration/SessionMode,
and global-off restoration. It used real composer send and stop controls, the actual agent/runtime,
and a local HTTP model. Multiple duration owners and the original mode button remained usable.
Screenshots and evidence: output/mods-validation/e2e-status-sites/.
Earlier fixture failures are retained: Enter did not send under the existing shortcut preference,
and direct backend cancellation omitted the renderer's normal stop-button state transition.
The fixture now uses the same visible controls as a user; production keyboard/cancel behavior was
not changed to make this test pass. This focused run is not the full integrated suite.

# Integrated Electron 14 — 2026-09-23

- Source 1584c03c (v41), isolated Mods v2 worktree. 93 checks, exit 0; ordinary build restored.
- Includes the previous 89 cases plus actual ToolUse/ToolResult and ui.toast/ui.status cases.
  Real desktop/session/utility path, model protocol fixture, real file reads, close/off/re-enable,
  revocation, reload, compaction and completion evidence. This is not Autobiz business acceptance.
- Disabled native read: 500 interleaved samples after 100 warmups/arm. Baseline median 1.2555 ms,
  p95 3.5329 ms; disabled median 1.3128 ms, p95 3.5733 ms (+1.1435%). One-run regression result;
  full five-round/CPU/model-stream performance qualification remains outstanding.
- Artifacts archived in 2026-09-23-electron-14-artifacts. New screenshots were inspected.
- Compatibility SDK feedback rows now match their tested operation rows; six inventory tests,
  with the SDK-member assertion failing before correction. Compact formatting changes no values.
- Subsequent classic output changes and v42 are not covered by this 93-case report. Their full
  integrated run 15 is in progress and must be recorded on actual completion.

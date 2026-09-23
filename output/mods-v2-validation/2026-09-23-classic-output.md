# Classic PostToolUse output effects — 2026-09-23

- First red: production classic bridge dropped updatedToolOutput/updatedMCPToolOutput and the
  presentation helper did not exist. Narrow bridge/helper 24 passed including a real QuickJS
  FunctionSession through runHooks; host publication filters output before projection.
- Native filesystem integration: real LocalSandbox writes preserve actual path/bytes and read
  output changes only with the explicit effect; disabling the injected effect restores the file
  content. That test injects HookResult and complements the real guest and Electron cases.
- Final focused regression: 10 files, 57 tests passed; legacy tool-hook-regression standalone
  passes all 14 scenarios. Node/Web typecheck and scoped ESLint exit 0.
- Focused Electron 1: three checks, exit 0, real utility guest -> classic PostToolUse -> native
  read -> real HTTP model protocol. The model receives one replacement, disk is unchanged;
  same task with Mods off receives original text. No change to native send/approval controls.
- Review: reuse existing protected result projections; preserve ToolMessage status/id, graph
  routing/unrelated messages, filesystem truth and process exit code. Ignore MCP-specific fields
  for native tools. Native stock configuration parsing is not expanded. v42 requires reapproval
  before previously dormant guest output fields acquire effects.
- MCP projection unit tests preserve actual isError/capability identity. Actual scoped MCP code
  is wired, but a real MCP PostToolUse-output-specific Electron scenario is still pending; do not
  treat general existing MCP tests as proof of this new field's full transport semantics.
- Full integrated 15 is running against the final v42 source; report its actual result separately.
  Formal performance gates and real Autobiz acceptance remain pending.

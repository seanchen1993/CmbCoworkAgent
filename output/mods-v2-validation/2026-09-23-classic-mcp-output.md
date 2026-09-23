# Real MCP output effect and integrated regression — 2026-09-23

- Integrated Electron 15: 95 checks, exit 0, ordinary build restored. Frozen v42 source;
  this run predates the added MCP-specific scenario. Artifacts: 2026-09-23-electron-15-artifacts.
- Native read off comparison: 500 interleaved samples after 100 warmups; p95 baseline3.7872 ms,
  off3.7937 ms (+0.1716%). Single-run observation, not full five-round qualification.
- Focused classic-output Electron 3: four checks, exit 0; ordinary build restored, including a real model-raised MCP
  stdio tool. The MCP tool returns isError:true; guest's MCP-specific output includes isError:false
  and overrides its generic replacement. Model receives replacement text, actual counter is one
  invocation, host audit status remains failed. Fixture output contains no external credentials.
- Focused run 2 failed because the focused path had not loaded the test-only fixture initializer;
  fixed test initialization without changing production authority or result processing.
- ESLint for updated runner/helper/protocol fixture passes. The prior capability report holds
  Node/Web, real guest, native filesystem and core result projection evidence.
- No installer, external model or Autobiz business acceptance claim.

# Standalone regression review and terminal compatibility

Base 388005da. Full independent script chain: 84 commands, 78 passed, six failed; all commands executed even after a failure. `2026-09-24-standalone-suite/results.json` records every command, exit and log. Baseline comparison executes the six failures in the existing isolated 0273980c export, never the UAT tree.

Two failures introduced after that baseline were resolved:

- IM desktop bridge: HookHalt extraction for reason/classification had changed the object delivered to the terminal callback. Keep unwrapped reason handling but restore the original caught error in markAutoModeTerminal, preserving caller error identity and retryability. Existing failure test went red to green; the entire IM bridge suite passes, including original-error propagation, aborts, authorization, transcript and success paths.
- Coordinator renderer contract: the new React key precedes showWorkflow; the switcher still receives showWorkflow. Make the existing source-contract assertion independent of JSX attribute order. Six coordinator plumbing groups pass; no renderer behavior changed.

The other four command failures reproduce at 0273980c with the same assertions: agent-registry task-subagent availability; sandbox-elevated three source contracts; IM remote approval Windows display path; IM local Zhaohu journey. These remain failures, not waived successes. Comparison logs: standalone-baseline-0 through -5 and standalone-baseline.json.

Node typecheck passes. ESLint zero errors for the changed production file/test; agent.ts retains broad existing formatting warnings (4172), so no whole-file formatting was applied. Prior Web check passed; this fix changes no renderer behavior. Electron StopFailure focused suite passes six checks: real original failure, observer execution, renderer restart, disabled module comparison, cancellation, revocation and no restart/false success. Ordinary bundle restored. Artifacts: terminal-electron-artifacts/result.json.

The fix adds no operation, IPC or timer; disabled execution follows the existing terminal path. Formal performance remains failed as separately reported; this check is not a new performance acceptance or real business acceptance. Remaining whole-repository baseline failures are disclosed separately.

# Disabled Mods ingress: 2026-09-23

Worktree: C:\ai\CmbCoworkAgent-mods-v2; base 0273980c. No UAT changes.

The application switch used electron-store's synchronous JSON reader on every tool ingress.
The manager also read it even when the known project configuration already denied both Mods
and managed protection. The real Electron disabled-read control showed +47.24% p95 in run 8.

Changes: cache only the disabled application value while dev/inode/size/mtime/ctime are unchanged;
enabled authority is always read again. Writes invalidate the cache, errors fail closed, and a
concurrent metadata change during a settings read cannot authorize work. Known disabled project
configuration returns before reading the application settings. Managed policy, grants, authority,
lease and generation checks remain in their existing paths. This is not a filesystem transaction
or a promise to lock settings until a later tool finishes.

Tests first: old switch behavior failed 4/6; old project ingress read settings 300 times and failed
its regression. After implementation: manager 47, switch 6, evidence UI 4 = 57/57. The manager
suite includes mandatory policy with ordinary Mods off and global disable after enable.
Independent switch/cache review found no blocking issue. Node/Web typecheck and changed-files
ESLint (quiet; no errors) passed. Logs: disabled-switch-red-behavior, disabled-project-red,
disabled-project-evidence-green, node-integrated-11, web-integrated-10, integrated-lint-10.

Electron run 9 exercised the real production native read with the manager absent versus the
same project disabled: 500 interleaved samples per arm after 100 warmups; baseline p95 5.7524ms,
disabled p95 5.0832ms (-11.63%). Medians 1.6715ms and 1.7734ms. This single run was under concurrent
test load, so it is regression evidence, not formal five-round performance qualification.
The run passed its prior native tool, permission, revoke/restart and compaction scenarios but
hit the whole-suite six-minute watchdog before the newly appended status-site cases finished.
The per-operation waits were not relaxed. Final whole-suite/idle performance qualification remains open.

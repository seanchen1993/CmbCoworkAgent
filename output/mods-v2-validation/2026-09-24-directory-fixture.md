# Real directory-limit fixture maintenance — 2026-09-24

The existing filesystem-limit test creates 1,025 real files in batches of at most 32 instead of serially. Its fixture deadline is 30 seconds so shared Windows test load does not exhaust the previous five seconds in setup. Both actual directory-iteration limit assertions and native authorization behavior remain unchanged; no production code changed.

The eight file-access tests passed (`2026-09-24-directory-fixture-final.log`), including physical ancestor/junction substitution and denied entries. The large fixture completed in 544 ms in this run. ESLint passed without warnings. Node typecheck had passed with this test change present. Runtime-clock Electron and real utility/session suites also passed with this fixture revision in the worktree; this test-only change adds no application runtime work and needs no new product E2E scenario.

This is test setup maintenance, not new business acceptance or a relaxation of the production filesystem limit.

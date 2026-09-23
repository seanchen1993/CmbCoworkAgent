# Bundled Function Mods in Electron ASAR — 2026-09-24

Scope: only the Mods v2 worktree. Formal installers remain GitHub Actions outputs; no local NSIS, install, dependency rebuild, UAT mutation or release was performed.

The production example installation IPC now resolves `out/resources/mods` to the actual unpacked directory when main code runs inside an ASAR archive. `asarUnpack` explicitly retains these files on disk, preserving the existing compiler file identity checks. Development paths retain their original location.

Review found the initial helper incorrectly rewrote the first `.asar` ancestor. A new failing regression (`2026-09-24-bundled-path-red.log`) demonstrated `releases.asar/app.asar` resolving into the wrong ancestor. The replacement is now anchored to the application resource suffix; the regression also covers development beneath an archive-like ancestor.

Validation:
- 2 narrow files / 11 tests passed (`2026-09-24-bundled-path-green.log`), including the isolated dependency staging tests retained as optional diagnostics.
- Real Electron ASAR control fails stable-file validation as expected; unpacked Function example compiles with its Client module (`2026-09-24-bundled-electron.log`). This is compiler integration, not a packaged full session or business acceptance claim.
- Ordinary application settings Electron: 10 checks passed, including off mode, uninstall isolation and actual restart restoration (`2026-09-24-package-settings-electron.log`). This build already used the unpacked helper; the new suffix edge case is compiled separately by the ASAR probe.
- Node/Web TypeScript and dedicated packaging harness TypeScript passed; seven packaging/helper files passed ESLint without warnings.
- Closed module remains inactive in the settings E2E. The path helper executes only when explicitly installing examples, so it adds no per-event work. Formal desktop performance remains FAILED (TTFT p95 +203 ms, budget 40 ms); this result does not waive that gate.

The packaged-launch settings harness now verifies `app.isPackaged`, the ASAR app root, and absence of a source entry argument when testing a supplied CI artifact. No CI artifact was available or tested in this run.

Optional private staging scripts address the local shared-dependency junction only. They are not wired into the release workflow and never install/rebuild shared dependencies. Entry hash checks do not constitute a concurrent full-tree snapshot. The previous 2026-09-23 package review did not catch the archive-like ancestor case; the regression above supersedes that part of its conclusion.

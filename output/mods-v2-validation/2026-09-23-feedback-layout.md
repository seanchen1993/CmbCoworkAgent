# Bounded plugin feedback — 2026-09-23

- Actual Electron red: five 9000-character guest messages produced a 6696px feedback rail,
  displacing the original composer. Regression was added before production CSS changed.
- The feedback rail is now limited to 128px, keyboard focusable and scrollable, with contained
  overscroll. Text remains escaped. Original composer behavior is unchanged.
- Focused Electron green2: four checks passed, exit 0, ordinary build restored. The test checks
  actual viewport bounds, keyboard scrolling, typing into the original composer, no script
  elements, off/re-enable and grant revocation. Screenshot reviewed in
  `2026-09-23-feedback-layout-artifacts/ui-feedback-bounded.png`.
- First green attempt hit a test-only Electron viewportSize() null; the test now uses actual
  window.innerHeight. No production workaround was introduced for this harness issue.
- Feedback/session/chat-scroll regression: 3 files, 38 tests passed. Node/Web typecheck and
  changed-file ESLint passed; final lint rerun after test correction also exits 0.
- The bounded layout prevents large text from growing the whole conversation surface. This
  is a layout/regression check, not a formal whole-app CPU/latency qualification.
- No installer or Autobiz business acceptance claim. UAT worktree was not modified.

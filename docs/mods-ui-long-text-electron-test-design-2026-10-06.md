# Long UI text through the actual Electron surface

This is a test-only extension of the approved long-text implementation. It does not change
Session, validators, host stores, renderer components, permissions or timing code. Root runs
the real Electron controller, which builds the fixture app and restores the ordinary build.

## Exact files

- `tests/support/mods-ui-log-e2e.ts`: extend its existing installed plugin and assertions.
- `tests/support/mods-ui-feedback-e2e.ts`: extend assertions for the installed feedback fixture.
- `tests/fixtures/mods-v2/ui-feedback/hooks/register.ts`: add one long-text command and handlers.

The existing tests remain in their original order. In the log helper, the new command runs after
the exact 22-row flood and its layout assertions, before the existing global-off/replacement and
revocation checks. In the feedback helper, it runs after the existing flood, keyboard scrolling,
viewport and composer assertions, before the existing restored command and revocation checks.
The existing hover/hold test helper is untouched.

## Actual long input and publication

Each new `ui.log`, `ui.status` and `ui.toast` call passes exactly 30,000 UTF-16 units from the real
utility-process Guest. A unique input prefix and a final sentinel identify that exact text. The
event handler accepts only that prefix, checks both the full length and final sentinel, then
forwards a distinct hook-success prefix and a fixed artificial credential token before the full
input. Ordinary existing inputs use the original path. No new logger or policy observer is added.

The project already enables the actual output protection policy. Its existing credential rule
must replace the artificial token with `[REDACTED]`. Expected output is the complete rewritten
text with that one fixed replacement, then its first 10,000 units. Require exact whole snapshot
text and exact length 10,000, with the hook-success prefix and no artificial token. This also
distinguishes protection-before-truncation: truncating first would leave a shorter result after
the token replacement. The final sentinel is checked by the Hook, not inferred from a truncated
snapshot. A swallowed Hook failure cannot reproduce the expected success prefix.

For log, find the actual new snapshot row, assert its plugin and ID, extract that exact row's
display text separately from the plugin label, and require the first 2,000 protected units.
Read the real isolated log's matching debug line and require the same full 10,000-unit protected
snapshot text. Keep order of all existing debug lines. Save a screenshot of the actual bounded
log surface; do not print its long text in command output.

For feedback, require the actual status and toast rows to have the same exact protected 10,000
units and original attribution. Use their actual DOM IDs and text spans to require the first
2,000 units. The new toast uses an explicit valid `timeoutMs: 60000` solely so the two complete
snapshot/DOM reads cannot race its expiry. Require that exact timeout in the returned snapshot,
then dismiss that actual native toast with its existing close button before the old command
continues. This does not change the original 2500ms expiry case or any hover/hold clock case.

## Existing gates and evidence

Read the actual transcript before and after each new command and require complete equality.
The log helper also retains its original HTTP request count and exact transcript assertions.
The new text remains presentation data and does not enter model input, messages or checkpoints.
Keep every existing scroll/viewport/composer, off, fresh-session, clear, expiry and revocation
assertion. Keep the real finally paths and existing per-action/controller deadlines.

Record only method, input length, protected snapshot length, actual displayed length, exact-text
comparison result and screenshot path. No production hook/permission bypass or added public API
is permitted. This plan does not claim an Electron result; both design tickets, the frozen scoped
source review and the actual controller result are required before reporting success.

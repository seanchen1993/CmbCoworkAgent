# SDK compatibility boundary review — 2026-09-24

Reviewed the fixed v2.1.278 official declaration against production FunctionSession capabilities, guest construction and individual host consumers. The matrix previously described `$.ui.focus` / `$.ui.scroll` as adapted using evidence for observed events and Pane autoFocus, even though neither SDK method is exposed.

Two regressions failed first (`2026-09-24-sdk-audit-red.log`): the real QuickJS SDK probe returned those two missing callable names; 52 partial SDK rows lacked concrete availability/source records. Updated all 54 resulting partial SDK rows: 32 bounded implementations, two metadata properties and 20 unavailable members. Both imperative UI SDK claims are now partial/unavailable; existing event adaptations remain unchanged. No compatibility claim was upgraded.

Each partial member now states its actual behavior and remaining limits with inspected source paths; existing implemented members link targeted tests. The new callable-name guard excludes only absent APIs, not semantic gaps: successful property lookup does not establish full compatibility. Remaining unavailable interfaces and future renderer request/ack requirements are explicitly documented in `docs/mods-v2-sdk-boundaries-2026-09-24.md`.

Validation:
- 10 files / 83 tests passed (`2026-09-24-sdk-audit-green.log`), including real QuickJS/FunctionSession, actual SQLite state, filesystem, MCP/permission boundaries, Pane generation cleanup and matrix checks.
- All referenced SDK source/evidence files exist. Node typecheck and both changed test files' ESLint passed; no production or renderer code changed in this audit.
- Same production revision already passed the 13-check completion Electron suite and original session-recovery Electron during retention validation. This documentation/test correction does not constitute a new imperative-focus E2E or new SDK implementation.
- Formal full4 performance remains failed at TTFT delta 67.7 ms; CPU/throughput passed. Disabled controls passed in the preceding Electron checks. No runtime work added by this audit.

Remaining matrix totals: 244 rows, 190 partial, 50 adapted, four unsupported, zero full. Partial still includes unavailable SDKs and unconnected classic events; it must not be summarized as full parity or finished development.

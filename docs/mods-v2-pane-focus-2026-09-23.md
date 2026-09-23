# Desktop Pane focus adaptation — 2026-09-23

This implements the previously ignored `ui.open({ focus: true })` and the first drawn control's `autoFocus` request. Compatibility remains **adapted**, not full upstream UI parity.

## Pinned upstream reference

Read-only reference: `C:\ai\claude-code-v2.1.278\mods\types\claude-code.d.ts`, tag `v2.1.278`. The pane focus contract at lines 5938–5946 is a request while the empty composer owns the keyboard, and refuses an occupied composer, other pane control, or dialog. The `autoFocus` contract at lines 8363–8368 chooses the first drawn element when a site takes the keyboard and does not move a ring the person has already moved. `UiFocusInput` starts at line 10475. `holdToasts` at lines 5960–5967 queues transient notifications; the desktop has no equivalent queue.

## Implemented behavior

- Each explicit pane open with `focus: true` creates a host-owned request ID. Snapshot publication cannot alter it. The renderer consumes each request once; refusal is permanent for that request. Ordinary redraws carry the consumed ID and cannot take focus again.
- The renderer requires a visible, active document, an enabled empty composer, and no dialog. It accepts the composer itself or the transient body focus left by desktop command submission. Another control or text already in the composer refuses the request. A keyboard/pointer action, configuration change, thread switch, or unmount while awaiting host validation cancels the DOM focus attempt.
- `paneAct` validates the current pane, runtime authority, generation and request. The host selects the first drawn `autoFocus` control, including a live isolated Client surface. The ordinary `ui.focus` middleware runs before any focus grant is returned. Its owner and origin are pinned; redirection is limited to another drawn control in the same owner/surface. A return without `next`, a refusal after `next`, or an invented result cannot fabricate a host grant.
- A closed/reopened/replaced pane, revoked session, or generation change during dispatch rejects the old request. An isolated Client receives its focus lifecycle update only after the full host hook chain permits it. Removed Clients reject old instance IDs.
- The renderer resolves the returned owner/key/Client address against the live DOM and calls `focus({ preventScroll: true })`. It rechecks the request and user interaction epoch first. Inputs retain stable React identity through callback-handle regeneration; prop value changes update the field without remounting its DOM node.
- Focused pane roots can give the keyboard to their first `autoFocus` control. Native descendant blur updates the host and Client lifecycle. Repeated redraw alone never starts a new request.
- `holdToasts: true` now fails with `MODS_UI_HOLD_TOASTS_UNSUPPORTED` instead of being silently accepted.

## Remaining explicit differences

This is the desktop Pane/Client adaptation. It does not claim all upstream sites, terminal focus-ring navigation, raising/docking tab semantics, a full imperative `$.ui.focus` SDK, or every descendant-to-descendant native focus transition as an upstream event. Automatic focus originates from the pane open or pane root keyboard take; independent Client-root keyboard navigation remains partial. Other unsupported pane options are outside this change.

The desktop's empty-body allowance after command submission is an intentional surface adaptation. Native focused controls and nonempty composer state always win over a plugin request. The renderer remains the trusted source of current keyboard ownership; plugins only receive the bounded host event and cannot call renderer IPC through their guest capability set.

## Reproducible desktop fixture

Install `tests/fixtures/mods-v2/focus-board`, approve its digest, then run `/focus-board` from an empty composer. `First focus field` and `Second focus field` both declare `autoFocus`; only the first should initially have focus. Type in the second field; its input callback invalidates the pane, but focus and text must stay in the second field. `Redraw focus probe` also redraws without creating a new focus request. The text `focus-events:N entered:...` exposes the actual host hook/callback state. Global disable removes the pane and no focus request should run until the plugin is enabled and explicitly opened again.

See `output/mods-v2-validation/2026-09-23-pane-focus.md` for completed checks and pending integrated checks.

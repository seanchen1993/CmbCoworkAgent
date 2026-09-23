# Desktop render sites (2026-09-23)

This change adds production `ui.render` entry points for `AbovePrompt`, `PromptHint`, and `InfoNotice`. These are **adapted**, not full terminal compatibility. The pinned Claude Code v2.1.278 declaration describes these three sites as terminal-only; this application emits `surface: "desktop"` honestly.

## Actual host locations and default content

- `AbovePrompt`: the band immediately above the real chat composer. The host's default tree is empty. DOM width and available window height determine bounded desktop `bodyColumns`/`maxRows`; `scroll` follows the actual band. `hasSurvey` is false because this host has no survey owner, and `view: {}` identifies the main transcript.
- `PromptHint`: the existing composer placeholder, including its actual draft/working/goal/read-only context. `next({...event, props: {...event.props, hint: "..."}})` changes that placeholder. A custom tree appears below the composer instead. No extra default hint sentence is inserted when Mods is off.
- `InfoNotice`: the existing Hook interruption reason in the chat footer. It mounts only when the host has a real interruption notice. Its `text` is the real reason; `command` is null. Default/off rendering keeps the original reason, with the existing host event label, time, dismissal, and blocked state intact. This does not cover every notification/toast in the application.

`InfoNotice.onScreen` is optional in the pinned declaration (absent where the surface does not report it). This desktop adapter currently omits it; it does not claim transcript viewport row tracking. The terminal logo position, terminal row accuracy, Ctrl-X shortcuts, and terminal collapse/hotkey navigation are not emulated.

## Drawings, controls, and lifecycle

The main process issues an opaque owner token for each mounted site. There is one host slot per component, at most three per session. Mounting a replacement removes the old drawing, aborts pending actions, and retires its callbacks. `requestId` is the host-issued owner; each new drawing has a fresh callback generation. The token is presentation identity only: IPC still resolves the real sender/workspace/thread and uses the existing FunctionSession authority, lease, runtime generation and user-action scope.

A mounted site is also a session entry point: approved modules load on the first visible site without running a command first. Concurrent sites share the same session startup. Disabled, unapproved, disabled-plugin, or changed-unapproved-source mounts load no guest. Discovery requests are bounded to 32 and are retired when a workspace is invalidated or a thread closes, including before a session exists. A late readiness result cannot restart that retired request. Reload and reenable obtain new owner tokens through the normal approved-session path.

Sites reuse the existing bounded Pane callback/intent lifetime: exact drawn plugin/handle/generation, no cross-site callbacks, retry deduplication, a 4096-intent session limit, retained callbacks while a valid action is running, and release when a drawing retires. Plugin `ui.invalidate("ui.render")` invalidates both panes and mounted sites. An unchanged drawing uses the same generation and does not call guest `ui.render` again.

The guest's `ui.resolve` verifies the actual event component, request id and drawing scope. Plugins may rewrite `hint` or notice `text`/`command` with valid types. `isDraft`, `isWorking`, AbovePrompt geometry/scroll/view/survey facts, and all site identity fields are pinned. Published controls, rather than hidden pre-publication controls, determine valid callback targets.

`AbovePrompt` supports native user focus/blur and scroll through the existing desktop hook adapter. The first `autoFocus` control is selected when the person enters the band; drawing by itself never steals focus from the composer. Old focus replies are ignored after updates or unmount. The adapter uses the existing desktop scroll event shape; it does not claim all terminal imperative focus/scroll APIs.

`Client` on these sites is explicitly rejected as `MODS_UI_SITE_CLIENT_UNSUPPORTED`. Isolated Client lifecycle remains supported in Pane only. The host never silently accepts a Client it cannot mount.

The renderer separately checks reply lifetime. Configuration changes, cards-changed notifications (including runtime replacement), prop changes and unmount invalidate previous publication tickets. A queued IPC result cannot restore an old tree, placeholder or focus after that boundary. The host still performs the independent authority and drawing checks.

## Installation fixture

Install `tests/fixtures/mods-v2/site-board` through the normal UI and approve its declared capabilities.

1. AbovePrompt shows `SITE_ABOVE count:0`. `Site increment` advances it; `Site note` and `Save site note` exercise a real guest input callback.
2. The real composer placeholder contains `SITE_HINT`, with actual draft/working flags.
3. Submit the ordinary message `SITE_BLOCK_PROBE`. The fixture's actual `classic.UserPromptSubmit` hook blocks it with `SITE_HOST_BLOCK`. The existing interruption notice should show `SITE_NOTICE SITE_HOST_BLOCK` through `InfoNotice`.
4. Disable Mods. AbovePrompt disappears; the original composer placeholder and original interruption reason return. Reenable creates fresh runtime state/drawings; old owner/actions cannot be replayed.

The fixture/session tests prove loader, guest, render and callback behavior. Electron results are recorded separately; these tests are not final business acceptance or evidence of unrelated sites.

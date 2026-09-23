# ui.toast / ui.status — 2026-09-23

- Production: host revision v41, session-owned prompt feedback through existing guest capability,
  operation dispatch, redaction/publication and live authority. Read IPC never creates sessions.
- Failing-before tests: missing implementation; delayed earlier publication overwrites last status;
  multibyte burst exceeds wire budget. Fixed with bounded entries, committed status revisions and
  a 512 KiB aggregate UTF-8 budget that evicts transient entries before pinned status.
- Narrow checks: manager/session/feedback 57 passed; broader six-suite UI/session regression 90
  passed; final UTF-8 and real guest/session regression 16 passed. The latter includes the new bound.
- Node and Web typecheck with repository --composite false: exit 0. ESLint quiet exit 0.
  First direct Node tsc invocation omitted the repository flag and reported TS6307; corrected to
  the existing project command, without modifying configs or unrelated files.
- Real Electron focused run 3: three checks, exit 0, real utility guest and slash commands;
  toast expires, status replaces/clears, renderer reload preserves live state, original messages
  unchanged, off/re-enable never resurrects old state and revoke removes feedback. Screenshots
  inspected and archived in 2026-09-23-ui-feedback-artifacts. Runs 1/2 exposed fixture issues:
  no-argument composer completion selection and malformed revoke thread argument; both fixed.
- Performance controls: 100-entry burst emits one coalesced notification and retains only four
  toasts per plugin; all timers stop after expiry/close; cold/off snapshot does not load a VM.
  These are bounded-work checks, not a claim of whole-application CPU/TTFT qualification.
- Review: identity comes from the caller frame, not hook data; revocation/cancel rechecked after
  async publication; late status cannot undo a newer successful clear; plain React text keeps DOM
  safety. No tool approvals, model messages, completion PASS or checkpoint changes are performed.
- Whole-app integrated run 14 started after the UTF-8 bound; result recorded separately when done.
  Prior integrated 13 passed 89 checks and does not cover these new feedback scenarios.
- Adapted limits: text 10000 chars, toast 0–60000 ms, four/plugin, 40 aggregate entries, 512 KiB;
  desktop prompt rail only. ui.log/ui.notice/ui.ask and holdToasts remain separate work.

# Renderer independent provider render IDs

## Observed failure

The real native-append Electron run completes six requests. The database retains six different
assistant UUIDs and one reused provider source with occurrences 1 through 6. Three renderer
echoes still fail the existing `CanonicalTranscriptEcho.canonical_id` fence.

Main messages transport retains the supplied UUID: the occurrence fallback only applies when
the supplied ID itself represents the provider source. Cross-role normalization also keys its
identity by the supplied ID. The later live append normalizer replaces an unoccupied supplied ID
whenever occurrence is greater than one. Shared append normalization repeats that replacement
when the same provider has an older occurrence. The completed renderer commit then echoes this
manufactured ID instead of the actual UUID.

## Exact change

Only `src/shared/message-role-collision.ts` and
`src/renderer/src/lib/live-stream-messages.ts` change. An exported data-only predicate recognizes
an independent supplied render ID when all these conditions hold:

- `provider_source_id` and `provider_occurrence` are own data properties, respectively a nonempty
  string and a positive integer.
- The supplied nonempty ID differs from that trimmed provider source.
- The ID is neither an existing same-role duplicate encoding nor a cross-role collision encoding.

The predicate does not recognize UUID syntax, read a native stamp, grant a permission, or register
an alias. Both append normalizers retain that ID only for a genuinely new provider-role-occurrence
tuple and an unoccupied ID. First occurrences already preserve it. Shared append still computes
and retains the original occurrence. Live append still visits the same candidates and updates the
same counters. Existing tuple replay runs the existing candidate compatibility checks and keeps
the established baseline render ID. Live candidate selection adds the same native data protections
already used by shared append: exact ID and stamp UUID, no conflicting stamps, and no invalid
marker. A rejected existing tuple is not a new tuple eligible for independent-ID retention.

Occupied IDs, conflicting provider tuples, bare reused provider IDs, malformed tuples and existing
internal collision/duplicate IDs retain the current collision algorithm. Complete snapshot and
cross-role algorithms remain unchanged. No Main transport, IPC schema, canonical DB fence,
native provenance, Source callback or append authority changes.

## Regression and verification

Add colocated regression coverage for independent first/second/third IDs through live append,
shared append, full snapshot and renderer commit/resolution; repeat frames and completed snapshots
must be idempotent. Cover occupied IDs, conflicting tuples, bare provider reuse, invalid/inherited
tuples, encoded internal IDs and incompatible native stamps. Keep the standalone explicit-alias
test's occurrence/ordering requirements while updating its intended independent render IDs.
Existing DB fence negatives remain unchanged. Root runs focused suites and the real Electron
native-append test; this document is not a claim that those gates have passed.

## Review status

Root scoped DESIGN1 and Official independent DESIGN2 pass this precise data interpretation and
the live native-candidate protection. The two production regions, one standalone expectation
update and `independent-provider-render-id.test.ts` with 17 expanded cases are now frozen for
independent source review. No tests have been run by this owner. The successful six-turn Electron
run and its remaining warnings precede this change.

Root and Official scoped source reviews pass the two data regions and their regressions. Root's
first combined gate reports 107/108 PASS, including 16/17 new renderer cases and all original DB
fence negatives. The remaining six-turn fixture compares a freshly inserted sparse display row
against the old merger's complete first-replay projection. Its independent IDs are correct; the
old merger additionally materializes the user source ID and existing optional display fields.
The production merger is unchanged. After both precise design reviews, the test now copies every
complete committed row and adds the old merger's display defaults only for the two incoming IDs.
It requires strict complete equality for that first projection and for a second replay, then uses
the actual projected array in the next turn. The 17 definitions remain frozen for renewed source
review and actual testing. The failed first log is retained
as `output/stage23-renderer-tool-ui-compat-current.log`; no actual zero-echo claim is made yet.

The next combined gate reports 65/66 PASS. Its strict first-replay comparison identifies one
remaining expected field: snapshot rebasing materializes occurrence 1 for each independently
identified user row. The expected current pair now preserves a declared occurrence or explicitly
uses 1, matching the unchanged normalizer's baseline rule. Both whole-array strict comparisons
remain. This test-only delta has both design reviews and awaits renewed source review and actual
testing; the failed log remains `output/stage24-renderer-mention-fence-current.log`.

The corrected fixture and all 17 new renderer definitions now pass Root's actual narrow gate,
recorded in `output/stage24-renderer-complete-replay-current.log`. The original failure logs
remain. The next real Electron run must still verify zero fixed echo-conflict diagnostics both
after the six original requests and after actual application shutdown.

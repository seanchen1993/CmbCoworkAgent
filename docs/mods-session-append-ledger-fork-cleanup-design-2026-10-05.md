# Presentation ledger: native fork and cleanup

Date: 2026-10-05. Root and Latest have each formally approved this narrow design.
The implementation below is source-frozen for independent source review and Root's
actual gates. No test was run by this author and no product acceptance is claimed.

## Observed source gap

`function-conversation-fork.ts` copies the immutable source `orderAnchor`, including
`presentation`, but regenerates the target branch and canonical receipt. The actual appDB
23-column copy and target primary receipt are written by
`function-conversation-fork-transcript.ts:canonical`; the native fork host calls that
writer/verifier through `access`. Neither currently creates the target presentation ledger.
A target blank/plumbing row therefore has an authenticated anchor but no matching ledger,
and the existing presentation reader correctly rejects it as migration required.

`function-conversation-cleanup.ts` selects the actual main family or persisted child
invocation and validates its Keeper/projection receipts before deleting them in the
caller's original transaction. It does not select, validate or delete presentation ledger
rows. This leaves durable rows outside the complete retirement plan.

The ledger's primary key is the physical thread ID, encoded actual incarnation and UUID.
Its twelve scalar fields also authenticate the logical target, canonical receipt/full-row
digest, native payload digest, full 23-column projection digest and complete anchor digest.
Consequently a source ledger cannot be copied verbatim into the target.

## Native fork contract

Keep the existing exact Saver membership/cut, source/target guards, UUID, sequence, full
native payload, all original projection flags/times/provider tuple/ordinal, and journal
once/unknown-COMMIT behavior. Do not modify intake frontier or create a new note/task.

The actual transcript adapter will perform these steps in `canonical`:

1. Build the same original source selection from the captured native source thread,
   incarnation, source ref and original Keeper row. Read the full primary receipt/raw23
   seal and call `readFunctionConversationPresentationDisposition` with those same
   authenticated columns. Missing or altered source ledger for an anchored row rejects
   before any target write. Legacy no-anchor/no-ledger remains visible.
2. In the existing target copy transaction, insert the original raw23 with only the
   existing target thread/stamp replacements. After recording the new target primary
   receipt, call `recordFunctionConversationPresentationDisposition` with the target
   selection, copied Keeper row and exact target raw23. It recalculates all target facts;
   only the original anchor/disposition/intent and original native data are retained.
3. Record only on a genuinely new target insertion. An already present target row must
   have its original target primary receipt and presentation ledger. Never recreate a
   deleted ledger on retry or infer one from the anchor alone.
4. The verifier reads the complete target receipt and target ledger, then re-reads the
   source receipt and source ledger. Compare source kind/fingerprint with the initial
   read. Perform original source/target guards before the final data-only seal and ledger
   reads; do not return a successful verification after a callback can change that data.
   Fragment/state absence remains part of the exact canonical copy proof.

`FunctionConversationForkNativeImport.copyPage`, `copyVisiblePage`, page resume,
post-COMMIT readback and `finish` already call this actual transcript verifier. They must
continue doing so; no alternate raw/visible projection writer is introduced. Their real
tests will demonstrate the complete caller path rather than testing only a ledger helper.
The generic fork module's custom writer API remains unchanged. Its existing exact copied
`orderAnchor` check and original writer/verifier are the enforcement seam, not a role scan.

`clearForkImportJournalInTransaction` will also reject if an exact target physical
incarnation still has a presentation ledger row after claimed target retirement. It will
not delete such rows itself or clear the journal as though cleanup had completed.

## Cleanup contract

All discovery, validation and deletion remain in the caller's original appDB transaction.
No schema creation occurs while cleaning or reading an old database.

For every already selected projection receipt, cleanup first retains its existing full
validation: actual family/child owner, logical target/branch, immutable Keeper payload and
receipt/full-row/native digests, stored raw23/projection digest/stamp, encoded physical
incarnation, and current physical raw23/fragments when that original incarnation still
exists. It then constructs the presentation helper's fourteen data facts only from this
validated original record and checks the genuine ledger with
`readFunctionConversationPresentationDispositionData`.

That data call proves only the ledger's agreement with the previously validated sealed
record. It does **not** assert that missing physical UI bytes still exist. If the old
physical incarnation was replaced, cleanup may retire its exact old receipt and old
ledger while `removeRaw=false`; it must leave the replacement's raw row, receipt and
ledger untouched. The existing raw deletion plan is not widened.

Ledger discovery also covers exact physical thread/incarnation and the selected logical
conversation IDs, in bounded pages. Every discovered ledger must join an already selected
and fully validated exact projection key. An orphan, foreign target, altered key/digest,
missing required ledger, or malformed selected schema rejects the entire cleanup; none
is silently erased or downgraded to an ordinary row. A legacy database with neither the
canonical family nor presentation table retains its original cleanup behavior.

After the original final native destination/source callbacks, a data-only tail rechecks
the selected sealed receipt identities and presentation observations, plus the ledger
discovery set. There is no host callback between that tail and deletion. Delete each
ledger by all three exact primary-key fields alongside its projection receipt, before
deleting its Keeper/family rows. Do not delete by UUID alone, logical thread alone or
current physical ID alone. The final caller guard is followed by a pure check that no
selected exact ledger or receipt was inserted again. Any failure rolls back the caller's
whole transaction.

## Regression gates

Use real appDB/Store primary receipts, native classes and actual Saver membership for
these cases; no fabricated storage success or stamp-only capability:

- Fork blank, plumbing and persisted native prompt rows through the actual native host.
  The target keeps the original full native payload/UUID/ordinal/time, receives a different
  actual target ref/receipt/incarnation, and has a recalculated target ledger. Existing
  full presentation readers return the same kind. Source data remains unchanged.
- Delete or alter source ledger: no target raw/primary receipt/ledger or journal progress
  is committed. Delete target ledger after a successful copy: retry/resume/finish rejects
  and performs no recertification. A COMMIT that actually committed but reported failure
  is accepted only by existing exact post-COMMIT verification, including the target ledger.
- A valid target copy plus a synchronous original guard which changes ledger data must
  fail verification. Keep the original full 23-column/provenance tests and large row bytes.
- Cleanup actual main family, one actual child invocation and siblings: only selected
  exact ledgers disappear; unrelated family and sibling ledgers remain.
- Cleanup the old child incarnation while a replacement reuses physical ID/UUID: old
  ledger/receipt disappear while replacement raw/current-incarnation ledger stay intact.
- Missing/altered/orphan selected ledger and synchronous tail mutation cause atomic
  cleanup rollback. Legacy table absence remains an actual old-DB positive.
- Clearing a retired fork journal while its exact target ledger remains is rejected.

CPU gates are run only by Root. Static source approval and these fixture definitions must
not be reported as passing tests or completed Stage23 native producer coverage.

## Ownership

Implementation, after two formal design votes: cleanup and its tests; generic fork's
retired-journal check and tests; native fork host regressions; fork transcript adapter's
`canonical` region and focused tests. Root has approved inclusion of that actual writer.
No edits to canonical display/Worker aggregate, index/read engine, Store, native projection
or transcript ACK-tail regions, runtime, keeper or protection modules.

## Frozen source handoff

The three production regions are cleanup, the native fork transcript `canonical` adapter,
and the generic fork's exact retired-journal check. The host keeps its original actual
writer/verifier calls; its new real Saver regressions exercise that complete caller path.
The four suites define 92 cases: cleanup 30, transcript copy 23, fork journal 24 and native
host 15 (23 new cases). These are definitions awaiting execution, not passing results.
An unrelated unused `getThreadMessages` import in `ipc/threads.ts` was removed separately
at Root's request after its actual TypeScript gate; no display behavior changed.

## Outer caller final boundary amendment

This amendment has Root and Latest's two formal design votes, with Legacy's additional
independent review. Its source is frozen for independent source review and actual gates.
The scoped adapter/cleanup changes above have independent source approval; their first
actual gate is 92/92 PASS. That result does not close the additional outer caller issue.

Source evidence: `copyForkImportPage.verifyPage` calls a verifier for each row. A later
row's source guard can change an earlier row's ledger after that earlier verifier's pure
tail. `finishForkImport.verifyRows` has the same loop, followed by checkpoint proof,
`assertPlan` and journal callbacks. The native host's `copyVisiblePage` likewise invokes
source/target/plan guards after all transcript adapters return. Calling the original
verifier a second time would reopen these callbacks, rather than establish a final tail.

The actual transcript factory will therefore mint a private
`FunctionConversationForkTranscriptDataTail` capability. A WeakMap binds it to the same
native transcript access, actual appDB, and fixed source/target physical incarnations.
The capability is not a callback supplied by a caller, a JSON proof, or a global/ambient
read scope. It records only rows which this access's real writer/verifier has successfully
authenticated. Each observation keeps fixed keys and complete SQL-data fingerprints,
not all native/UI bodies. Reverification of the same key must preserve its first complete
observation; it cannot refresh an altered row into a healthy observation.

The minimum interface is:

```ts
// Returned only by captureFunctionConversationForkTranscriptAccess.
access.dataTail: FunctionConversationForkTranscriptDataTail

// Internal native reader; no source, policy, proof, writer or verifier callback.
assertFunctionConversationForkTranscriptDataTail(
  tail,
  actualDatabase,
  expectedTargets // UUID + target branch for the actual private plan's bounded page
): void
```

The known factory reader authenticates the capability before using its private records.
For every required key it freshly checks complete source and target Keeper rows, fixed
physical/logical identities, original payload/bytes/receipt and canonical stamp, all 23
columns and primary receipts, presentation ledger, provider/alias identity, and original
fragments/state. Results must equal that access's original observation. An expected key
without a prior genuine observation rejects. Ordinary persisted copies retain their
original raw columns/provider identity/fragments plus their ordinary absence checks.
All reads use fixed native SQL and captured data-only selections. A capability cannot
create a primary receipt, ledger, membership, new projection, or successful ACK by itself.

`copyForkImportPage` gains only an optional native capability argument. Custom generic
writer/verifier callers retain their current API; the real native host must supply its
same access's capability. The private plan pins that capability on its first native copy
and refuses replacement by another access. Before COMMIT and after COMMIT/unknown-COMMIT,
it first completes all original plan/source/target/verifier callbacks, then checks the
pure journal/progress and copied source/target rows and the complete native data tail.
No callback follows that tail before COMMIT or before returning a page ACK.

`finishForkImport` separates callback-bearing validation from its pure final validation.
It completes the original selected proof, exact stored checkpoint reads, all row verifiers,
and last `assertPlan`/journal guards first. Its final tail then reads the pinned complete
journal, physical incarnation, branch topology, exact checkpoint receipts/member rows,
all source/target Keeper rows/progress markers, and the native access observations. This
walk uses bounded 64-row pages and holds one full row at a time. No verifier or membership
proof callback is run inside that walk. Status CAS/COMMIT and cheap native transaction/
closed checks follow it. The already-ready path and uncertain-COMMIT readback must use
the same final boundary; a final call to callback-bearing `journal` is not permitted.

The native host uses the same capability for `copyVisiblePage`. After its original final
source/target/plan callbacks, it performs one complete data-only page tail before COMMIT
and another after committed verification. Canonical and ordinary rows in one page share
the final boundary. A page must not be acknowledged merely because its last row is sound.

Required new real Store/Saver/AppDB regressions are: a later row's actual source guard
alters an earlier copied ledger; the final plan or target guard alters an earlier ledger;
the selected checkpoint proof's final guard alters a copied row; and a canonical/ordinary
visible page has an earlier raw/fragment row changed by its final guard. Each must reject
ACK/ready, perform no replay or ledger repair, preserve original mutation/effect counts,
and roll back the original transaction when the change occurs before COMMIT. Committed
unknown-COMMIT damage remains present but cannot receive a successful readback ACK.

The source checkpoint's original complete appDB receipt and member index are also pinned
as a private fingerprint after the real proof is validated. Every pure plan tail reads
those exact rows again and checks the original snapshot/target/all member fields. A final
source callback cannot delete a member or change a receipt and borrow the previously
captured proof object. This fingerprint stores no native/UI history body and grants no
Saver authority.

The three amended source files are `function-conversation-fork.ts`,
`function-conversation-fork-transcript.ts`, and `function-conversation-fork-host.ts`.
The transcript suite now defines 27 cases and the real native host suite 24. Together
with the unchanged generic fork 24 and cleanup 30, the scoped gate defines 105 cases;
13 are new boundary regressions. The latest status regression awaits Root's execution. The
actual 92/92 prior scoped gate remains separate. Cleanup's already data-only family tail
and the original membership/frontier definitions are unchanged by this amendment.

The first outer gate was actually 100 PASS / 2 FAIL out of 102, retained in
`output/stage23-ledger-fork-outer-batch-first.log`. Both failing new fragment fixtures
omitted the provider tuple required by the actual ordinary delta API, so it returned
false and their later fragment UPDATE affected no rows. The revised fixtures use the
actual tuple, require successful delta creation, and assert the real fragment rows before
testing their original rejection/rollback boundary. No ordinary delta production rule or
denial assertion is relaxed.

The independent visible-page plan gap is closed by the factory-only
`assertForkImportDataCurrent(plan)` pure reader. After the last callback-bearing
`assertForkImportCurrent`, the native host freshly rechecks the complete original source
checkpoint receipt/member index and immutable journal, then the whole transcript page.
The pre-COMMIT, committed readback, and uncertain-COMMIT paths use the same verifier.
Two additional real Saver/AppDB cases mutate those source members or journal from the
last target guard and require rejection, rollback, one mutation and no ledger replay.

The second outer gate actually passed all 104 cases in 17.56s, recorded in
`output/stage23-ledger-fork-outer-batch-second.log`. Subsequent independent source review
found the ready retry used its pre-callback journal status after the pure full tail had
validated a newer preparing status. `finishForkImport` now requires the freshly returned
status to equal this operation's observed status before its ready early return. A new
real ready target-guard regression changes only that status and requires rejection,
one change, no repair and no ledger replay. This new case is not included in 104 PASS.

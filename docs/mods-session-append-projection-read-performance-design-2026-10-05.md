# Native projection read performance: proposed bounded consolidation

This is a source-based optimization proposal, not an implemented change or a performance PASS.
The current 31 projection tests remain frozen. The default five-second limit remains unchanged.

## Evidence

Root's actual long-case profile is `output/stage23-native-projection.cpuprofile`. Reported self
times include `statementRows` 2237.5 ms, native `all` 888.8 ms, crypto updates 672 + 481 ms,
projection-receipt `current` 662 ms, and `rowDigest` 200 ms. Actual phase measurements were
Store 898 ms, register 742 ms, serialize 2282 ms, parse 683 ms, and read 707 ms. These are
measurements of the current implementation; they do not predict the optimized runtime.

The repeated work is visible in the source:

- `native-sqlite-adapter.ts:82` uses `StatementSync.all`; `exec` also copies each result through
  the sql.js-compatible columns/values shape. `prepareReadOne` at line 240 already supports a
  fresh `StatementSync.get` on an actual connection, with no result cache or iterator.
- `function-conversation-projection-seal.ts:126` reads and hashes the complete Keeper payload.
  Its `assertStoredProjectionReceipt` at line 151 then enters the receipt verifier.
- `function-conversation-projection-receipt.ts:99` reads and hashes that complete payload again.
  `projection` at line 171 calls it twice, and `readFunctionConversationProjectionReceipt` at
  line 239 calls it a third time. One stored-seal read therefore materializes and checks the
  same full Keeper payload four times, besides repeated thread, target, receipt, schema and
  fragment reads.
- `index.ts:4960` reads the raw message before the complete stored seal. The strict partition
  at line 4970 calls the seal during discovery and again during its full echo comparison.
  `native-conversation-stream-projection.ts:108` calls snapshot read followed by partition.
  This can reach twelve full Keeper payload reads for one `current(entry)` boundary.

The complete checks are necessary. The proposed change removes repeated materialization inside
one synchronous check; it does not replace any check with a timestamp, status cache, public
stamp or previously returned snapshot.

## Fixed prepared query and fresh observations

Introduce a private fixed SELECT reader for an exact physical thread/incarnation/message ID.
Only the prepared query is retained in a WeakMap keyed by the actual NativeSqliteAdapter.
Every observation calls `prepareReadOne`'s real `get` with fresh primitive bindings. Mark the
query in use before prepare/get; synchronous re-entry uses a temporary prepared reader. An
error evicts only the failing cached reader and clears the in-use marker in `finally`. A closed
or reopened connection never borrows the old connection's query or row.

The SELECT returns one joined, detached observation containing:

1. Every one of the 23 current `thread_messages` columns, each under an explicit unique alias.
2. Every stored projection-receipt field, including full `projection_json`, its digest, the
   original target JSON, Keeper receipt/row digest, and native-payload digest.
3. The complete Keeper row, including original `payload_json`, hash, byte length, sequence,
   branch, UUID, receipt, input digest, door and creation time.
4. Physical and logical thread creation/metadata values, and the actual logical-session,
   conversation and branch columns currently checked by `assertTarget`.
5. Fresh existence flags for both fragments and orphan fragment states.
6. A fresh exact schema check using the current table-valued schema query. Added, missing or
   renamed columns and missing dependencies still fail closed. A prepared SELECT is not a
   schema-version cache.

Keep all existing target-envelope canonicalization, physical/logical incarnation checks,
branch/sequence checks, payload hash/bytes and shape checks, complete row equality, stamp/role
and Tool call pairing, complete 23-column validation, and all stored receipt comparisons.
The comparison order may be factored into pure functions, but the rules do not change. Never
invoke the display normalizer, clamp, renderer parser or a raw object's serialization method.
Bindings and input selectors are fixed before any native guard callback. Joins must not
overwrite identically named fields; a missing/null Keeper or receipt is an error, never an
ordinary successful echo. Missing receipt/schema retains the existing migration/schema error.

## Guard re-entry and final freshness

The operation pins the original actual DB, selector, native guard and expected input before
calling any host callback. It invokes the original source/target guards at the start, reads
observation A, and performs the complete pure validation. It then invokes the final original
guards and reads observation B with a second real `get`.

Every selected value in B must exactly equal its counterpart in A: all 23 projection columns,
receipt fields, complete Keeper bytes and scalars, physical/logical thread metadata, actual
target/branch/sequence fields, schema results, and both fragment flags. A difference is a
conflict at this read boundary. It does not retry, refresh a held capability or claim success.
For identical observations only, the operation may reuse its own just-computed JSON parse and
hash results. This is equality of fresh observations during one synchronous operation, not
a cache across operations. The second observation is mandatory even if the guard usually
does not write. A guard can synchronously change a row, fragment, receipt, schema or thread.

After observation B, only pure comparisons and cheap original closed/signal/connection checks
may run. There must be no user callback, host guard callback, await, normalizer, getter,
`toJSON`, alias-changing callback or native mutation before returning. In particular, do not
put an arbitrary tail guard after the last fresh query and then return the previously read
projection. The existing projection boundary still performs its final descriptor-safe native
message digest check, so a synchronous guard cannot mutate the BaseMessage unnoticed.

This consolidation remains read-only both outside a transaction and inside the original
writer's transaction. It does not issue BEGIN, COMMIT, schema creation, migration, receipt
replacement or a Store write, and does not certify physical COMMIT.

## Snapshot and strict partition in one private synchronous operation

Provide an exact-ID composed native read returning the safe snapshot and its strict partition
result from the same validated observations. Inside that private operation, the immutable
columns feed both snapshot construction and the existing full echo comparison once. Provider
tuple, alias/collision discovery, fork readiness, delta rejection, allowed-field checks,
optional stamp, raw content/calls, every scalar/date/ordinal and prompt-origin comparison
remain mandatory. Any provider or alias ambiguity still rejects.

The composed operation is for an already admitted exact ID, not an alternate public stamp
route. It does not pass a JSON bundle or transferable read certificate from snapshot read to
an unrelated partition call. Existing public snapshot and partition APIs independently obtain
fresh observations when called separately. Ordinary alias/provider discovery and the legacy
upsert stale-echo fence retain their contracts and `changed=0` behavior.

`current(entry)` and ordinary registration can consume this composed result. History and
intake still invoke their actual private proof/publication readers on every boundary. They
must not substitute a stored projection seal for checkpoint membership, a source grant or an
intake capability. The full native message digest, row/snapshot digest equality, exact owner,
signal, policy/lifetime, actual DB identity, and closed-owner rejection all remain in place.
Each serializer, parser, transfer and later read obtains a new observation; there is no
per-tick or per-wire DB-result cache.

Initially limit integration to the read-only stored-seal and native projection read path. Do
not alter the write/adoption/unknown-COMMIT paths merely to obtain performance. Any subsequent
reuse by those paths requires an explicit review of their original transaction guards.

## Required actual regression gates

Retain all existing receipt, seal, 35 strict-partition and 31 projection assertions. Add real
SQLite cases for every mutable category at a synchronous final guard: all 23 columns, Keeper
payload/hash/bytes/receipt, original projection receipt, physical and logical incarnation,
target/branch, new schema column, fragment and orphan-state insertion. No guard-mutated old
observation may return as success. Check original guard failures, async guard rejection,
selector pinning, connection close/reopen and re-entry cleanup.

Verify the optimized singleton reads do not call `.all`, create schema, run a write or cache a
row. Query again after actual DB mutation and prove that the new operation sees it. Use an
actual second connection as well as same-connection guard mutations. Preserve missing receipt
and wrong echo/delta/stamp/provider/time rejection, long display non-clamping, explicit false
Tool presentation, same-owner CP reuse and closed-owner/old-wire rejection.

Root runs the unchanged long native case under its default five-second bound and records the
same phase trace/profile. A source PASS or reduction in query count is not a performance PASS.
Failure remains visible; no timeout increase, row truncation or smaller fixture is proposed.

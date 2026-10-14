# Shared native current: synchronous data reads

Status: A/B and the named pure dependencies are implemented and frozen for independent
source review. Root and Latest approved the precise design, including the smaller lexical
A variant. No CPU run or performance result belongs to this snapshot. The original
five-second tests and full inputs stay.

## Evidence and actual call relationships

The latest shared-derived gate has 11 successes and two default-timeout failures: the
two-generation Tool case took 9,906 ms and the parallel case 5,313 ms. Earlier true-only
shared diagnostics reported 329,834 fresh read-one gets, about 4,509 ms in queries, and a
6,409 ms body. Earlier resident HTTP diagnostics reported 348,360 physical source checks
and a 34.5-second body; the eight actual protect calls took 42–260 ms each. These are
different snapshots and are not summed or presented as a post-optimization result.

`native-model-current.ts` makes two original full policy checks and three policy data-tail
checks in each `full()`. An independent `tail()` makes two policy data-tail checks. Its raw
capture callback checks the actual signal and monotonic cut only; it does not execute SQL
once per message field. The outer sources account for the SQL multiplication.

The actual shared Manager policy full check retains `runtime.assertCurrent()`, a policy
data tail, the original `protects()` call, and a second policy data tail. The actual Manager
data tail already ends in the captured Producer's `assertDataCurrent()`. The policy-source
wrapper currently calls that original tail and immediately calls the same Producer's
`assertDataCurrent()` again. Therefore the three wrapped data tails within Model `full()`
alone cause six complete fresh destination JOINs. Including the two Manager full-policy
checks, that Model `full()` has ten explicit Producer data checks in addition to the
Producer checks nested inside the two runtime full calls.

Producer `assertDataCurrent()` already uses one fresh complete destination JOIN for the
qualified registration/family/owner thread facts. Producer full checks still call, in order,
the original Active full guard, original native-read/scope full guard, original registration
full guard, original destination full guard, and final Producer data check.

The registration full guard calls Family full, owner full, Registry target full, and
destination full in that order. Its final pure `assertDataCurrent()` still performs Family's
checkpoint and destination ThreadCore reads and a separate owner ThreadCore read.
Its existing private `captureDataChecker()` already proves that the genuine destination
JOIN covers those exact three facts.

## A: one same-Producer data read in a certified policy tail

The approved smaller implementation changes no PolicySource registration qualification,
mint API, reader, or wrapper. In the actual Manager's shared `capturePolicy()` lexical
factory, split the existing tail into `assertPolicyData()` (all original Manager fields,
maps, runtime/authority relations, closed/signal facts, settings identity/epoch and
descriptor-safe full policy facts) and `assertTail()` (that same data function followed
by the original Producer's complete `assertDataCurrent()`).

The original full `assertPolicy()` still calls `assertTail()` twice around the original
`protects()` call; both full checks and their complete source relationships remain.
Only the argument passed to `registerFunctionConversationSharedNativePolicySource()`
changes to the Manager's self-built `assertPolicyData` function. That registrar retains
its existing unconditional `input.assertTail(); actual.assertDataCurrent()` wrapper and
its original complete Producer admission/publication. Its resulting certified tail
therefore checks the complete Manager facts and takes one complete fresh Producer JOIN.
Unknown/generic callers still use the same mandatory wrapper and cannot skip Producer
validation. There is no coverage boolean, arbitrary callback qualification, new capsule,
or Manager/Desktop value import into a pure module.

The facts function is produced only inside the original Manager factory from its fixed
private captures. Failure propagates; it never selects a generic retry. Each independent
tail call takes a new snapshot. No snapshot survives an await, a source callback, a Store
call, another independent guard, or another message. Both original full policy calls,
both `protects()` observations, all runtime full calls, and the Model raw captures remain.

Pure dependency prerequisite: the actual Manager field checker currently iterates its
private descriptor entries with a late Array iterator, and deployment copy uses late
`some`/`push`; the destination snapshot/scope coverage also uses late `some`. Within this
candidate's actual pure tail these must use equivalent private index loops or original
intrinsics. This is limited to the named functions, retains key order and every comparison,
and needs actual late-prototype getter/replacement tests. Without this prerequisite the
claim that nothing between the two snapshots can run host code is not established.

Additional dependency found during the final read: `prepareReadOne()` currently copies
the fresh native `.get()` result with `Object.entries(row).map(...)` and
`Object.fromEntries`. Array `map` and the entries iterator can execute late code after
the SQL snapshot but before it is validated; binding-array normalization uses late
`map` before `.get()`. The read-one path used by the JOIN needs an equivalent fixed
index scalar/blob copy and fixed index binding normalization before a scope is described
as callback-free. This is a separately approved adapter leaf prerequisite, not approval
to alter generic `exec`, to cache row values, or to bypass `assertOpen` and binding checks.

## B: registration full postflight uses its already-proven joined data checker

The Coordinator retains all four original full callbacks in their original order. Only
after the destination full callback returns does it choose the private registration
checker for the exact authority, native destination, DB, owner, target and parent ref.
The choice is captured by the original Producer completion, after the mapping and
registration already exist; it does not reuse or prolong the consumed native-read proof.

Recommended semantic seam: Producer completion may bind the genuine native destination
to the original registration's private postflight record. Binding is once, before the
first qualified registration full check, and requires the existing original
`captureFunctionConversationSharedRegistrationDataChecker()` relationship. There is no
caller-supplied inspector and no replacement of `registration.assertCurrent`.

After the four full callbacks, the qualified postflight starts a NEW
`withFunctionConversationNativeDestinationDataScope(destination, actualDB, ...)`. It
executes only the existing module-owned checker: Coordinator/owner fixed maps and
descriptors; Family actual lease/authority/signal/maps and both thread incarnations;
Registry actual target data; and the exact owner thread incarnation. The scope reads the
complete original mapping, target/parent refs and all four thread rows once and retires
in `finally`. Its first-query reading latch, caught-reentry sticky failure, field/leaf
descriptor validation, original collection/signal intrinsics, and irreversible Scope
closed check remain.

Unqualified registrations use the old three ThreadCore reads. A callback may change
data after a previous guard's JOIN, so a scope from before any of the four full callbacks
must never be reused here. No Family, owner, Registry, destination, restore or admission
full callback is deleted. Source callback counts and their order remain identical.

## Boundaries and deferred alternatives

Model `full()`'s two full policy calls bracket raw capture and are retained. Model tail's
two policy calls bracket complete raw capture and remain separate in this proposal.
Keeper's M/A/T/D guards, mutation lifecycle, Store read/commit, projection full A/B,
ledger B, aliases, true drain, signals, cut and final writer data tail remain. The prior
R-only Keeper optimization is not broadened.

Family full's three ThreadCore reads and Store current's two fixed SELECTs are additional
possible hot leaves. They are not changed by A/B. A new joined Store read would need its
own precise scope, error-priority and generic-compatibility design; the earlier read-one
approval explicitly retained two queries and does not authorize such a JOIN.

## Actual regression requirements

- A: genuine Manager/Producer/certificate case reads one fresh JOIN per wrapped tail;
  independent second reads observe changed mapping/thread data; unknown and foreign
  callbacks retain their original two checks. All original full and `protects()` counts
  and order remain. A last source callback changing policy/authority/lease/maps must
  still reject, including caught reentry and restored getter cases.
- B: genuine registration postflight performs one fresh complete JOIN; qualification
  miss retains three old thread reads. Assert all four full callbacks still execute.
  Mutation by the last destination callback is rejected by the new postflight. Check
  checkpoint, destination and owner ABA/deletion, extra mapping columns, alias collision,
  late mapping change, scope reuse, foreign DB and caught-query reentry.
- Pure dependencies: inject late Array iterator/some/push getter or replacement only
  at an actual source boundary. Assert zero hostile executions, full rejection or exact
  unchanged output as appropriate, and no SQL side effect/ACK. Keep actual full body,
  provider/tool/Hook/CP/raw23/ledger/parallel-isolation assertions.
- Root alone runs the narrow gates and unchanged five-second shared/native/resident
  gates. Source approval does not predict that these two changes will meet the budget.

## Additive measurement proposal

Under one explicit test diagnostic environment variable, observe actual functions and
fresh read-one handles using the original function once, same receiver/arguments, and
same return object/Promise. Report fixed category counts and cumulative milliseconds:
`producer-full`, `producer-data-join`, `registration-full`, `registration-postflight`,
`family-full`, `runtime-full`, `policy-full`, `policy-tail`, `model-current-full`,
`model-raw`, `model-current-tail`, plus fresh `.get` categories for `thread-core`,
`store-current-thread`, `store-current-target`, and `destination-join`.

Only fixed labels, counts and elapsed times are printed. Never print SQL, parameters,
IDs, body, metadata, keys, credentials or error reasons. Distinguish nested inclusive
timings from nonoverlapping totals; do not add nested times together. Promise settling
is not physical drain proof. Retain original parents/nodes/children through true finally,
then restore observers before the original resource close. No benchmark, timeout,
message-count or Worker-policy change is part of this proposal.

## Frozen implementation and tests

`manager.ts` changes only the shared `capturePolicy` lexical tail: the original full
policy closure still calls its complete tail twice, while registration receives the
self-built Manager-only facts closure. The pure policy-source registrar and wrapper
are unchanged.

`conversation-coordinator.ts` adds
`bindFunctionConversationSharedRegistrationPostflight(registration, authority, destination)`.
Only actual Producer completion calls it, using the original registration and complete
destination. The module's existing private data checker must prove all coverage before
the original private postflight record is published. A coverage miss keeps the old data
chain. A duplicate bound record is poisoned. Its qualified reads use a first-query
reading latch, sticky failure and a new complete destination scope each time. Registration
full retains all four original callbacks before this postflight.

The exact production files in this batch are `src/main/mods/manager.ts`,
`src/main/mods/v2/conversation-coordinator.ts`, `src/main/mods/v2/conversation-shared-restore.ts`,
`src/main/mods/v2/conversation-child-family.ts`, `src/main/mods/v2/conversation-registry.ts`,
`src/main/mods/v2/conversation-shared-checkpointer.ts`,
`src/main/db/function-conversation-native-destination.ts`,
`src/main/db/native-sqlite-adapter.ts`, and `src/main/agent/thread-run-lease.ts`.
`src/main/mods/v2/manager.ts` is not an A/B edit. ChildFamily/Registry index
loops, original private collection intrinsics, destination mapping/thread loops, the
Scope free reader and physical lease pointer reader are limited to the pure dependencies
named above. The ordinary full/public paths are retained.

`prepareReadOne` has its own normalizer: positional bindings preserve original length,
sparse holes and inherited indices in original order; named bindings preserve enumerable
own data and special `__proto__` semantics. Native prepare fixes the actual original
Statement get function and receiver before publishing the reader. Every later call
uses that same get address exactly once through `Reflect.apply`, followed by a new scalar
and blob row copy. Generic binding normalization, `exec` and cursors are unchanged.
This does not assert that native statement creation itself is callback-free.

Independent source review found the last original `this.assertOpen()` lookup could also
execute late code after the fresh SQL read. The separately approved read-one supplement
fixes the original class method at module evaluation. The factory and all three original
read-check locations validate the same adapter prototype and own `closed` data boolean
and original descriptor flags before applying that original method with the original
receiver. A real closed adapter still throws the original closed error. Late own or
prototype method getters are not executed; an accessor replacing `closed` is rejected
before the method reads it. Generic open checks and close are unchanged.

`src/main/mods/v2/conversation-shared-data-scope.test.ts` has 66 definitions: the original 51 and 15 new
real Manager/lease/Coordinator/Scope/Saver cases. The new cases compare unqualified
registration's three ThreadCore reads with two independently qualified postflights' two
JOINs; compare original full source callback counts; require one fresh JOIN per policy
tail and unchanged full/protects counts; reject mapping changes between reads and after
the last original source callback; poison caught same-registration read reentry; and
inject Array iterator/some and WeakMap/Map get getter/replacement after actual JOIN
return, restoring before assertions and checking zero callbacks and unchanged stored
facts. Two additional real last-source callbacks install getters on the actual DB's
`assertOpen` or `closed`; open-method lookup is avoided and the changed closed data is
rejected with callback zero. The joined raw result and original public provider/message
paths remain actual.

`src/main/db/native-sqlite-read-one-array-tail.test.ts` has eleven definitions using actual
DatabaseSync and original statement get: late row-copy iterator/map attacks, late get
getter/replacement, sparse/inherited/named/blob/null/special-data binding and fresh
update/delete/closed-reader behavior, including three post-get open-check attacks.
`src/main/agent/thread-run-lease-captured-data.test.ts` has two
definitions requiring late Map get callback zero and refusing release/reacquire of the
same public tuple. Together this batch has 79 definitions, none run by this reviewer.
Tracked-file scoped `diff --check` returned zero; untracked source and tests were also
read directly. That formatting check is not a type or runtime gate.

Root's first actual gate passed the eleven adapter and two lease cases, but the scope
suite failed during title collection: passing `Map.prototype` itself to a `%s` title
made Vitest/loupe read its non-instance size getter. The fixture now uses fixed kind
labels and selects the same original prototype inside the body; all eight attacks and
every assertion remain. The first log is retained, and scope functionality has not yet
been counted as passing.

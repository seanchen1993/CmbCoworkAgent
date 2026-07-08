/**
 * Regression coverage for runtime checkpointer leases and close coordination.
 *
 * Run:
 *   npx tsx tests/checkpointer-lru.spec.ts
 */

import assert from "assert"
import { mkdtemp, rm, mkdir, rename } from "fs/promises"
import { SqlJsSaver } from "../src/main/checkpointer/sqljs-saver"
import { tmpdir } from "os"
import { join } from "path"
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint"
import type { RunnableConfig } from "@langchain/core/runnables"

function config(threadId: string): RunnableConfig {
  return { configurable: { thread_id: threadId, checkpoint_ns: "" } }
}

function checkpoint(id: string): Checkpoint {
  return {
    v: 1,
    id,
    ts: new Date().toISOString(),
    channel_values: { value: id },
    channel_versions: { value: 1 },
    versions_seen: {},
    pending_sends: []
  } as Checkpoint
}

const metadata = {
  source: "input",
  step: 0,
  writes: {},
  parents: {}
} as CheckpointMetadata

async function main(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "checkpointer-lru-"))
  process.env.HOME = home
  process.env.USERPROFILE = home

  const runtime = await import("../src/main/agent/runtime")
  try {
    await runtime.withCheckpointer("pinned-thread", async (pinned) => {
      await pinned.put(config("pinned-thread"), checkpoint("pinned-cp"), metadata)

      // Exceed MAX_CACHED_CHECKPOINTERS while the first entry is leased.
      for (let index = 0; index < 16; index++) {
        await runtime.getCheckpointer(`other-${index}`)
      }

      const tuple = await pinned.getTuple(config("pinned-thread"))
      assert.equal(tuple?.checkpoint.id, "pinned-cp", "leased checkpointer must remain usable")
    })

    let releaseOperation: (() => void) | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const blocker = new Promise<void>((resolve) => {
      releaseOperation = resolve
    })

    const operation = runtime.withCheckpointer("close-waits", async (checkpointer) => {
      await checkpointer.put(config("close-waits"), checkpoint("close-cp"), metadata)
      markStarted?.()
      await blocker
    })
    await started

    let closeSettled = false
    const closing = runtime.closeCheckpointer("close-waits").finally(() => {
      closeSettled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.equal(closeSettled, false, "explicit close must wait for an active lease")

    releaseOperation?.()
    await Promise.all([operation, closing])

    // ── Sub-threads never participate in LRU eviction ──
    // A workflow/worker subagent holds its saver for the whole run WITHOUT
    // registering in the busy guard; evicting it mid-run would orphan a live
    // writer. Flood the cache and assert the sub-thread instances survive.
    const wfSubId = "evict-parent__wf_run1_a0"
    const workerSubId = "evict-parent__worker__w1"
    const wfSub = await runtime.getCheckpointer(wfSubId)
    const workerSub = await runtime.getCheckpointer(workerSubId)
    for (let index = 0; index < 16; index++) {
      await runtime.getCheckpointer(`evict-filler-${index}`)
    }
    assert.strictEqual(
      await runtime.getCheckpointer(wfSubId),
      wfSub,
      "a __wf_ sub-thread checkpointer must never be LRU-evicted"
    )
    assert.strictEqual(
      await runtime.getCheckpointer(workerSubId),
      workerSub,
      "a __worker__ sub-thread checkpointer must never be LRU-evicted"
    )

    // ── retireThreadCheckpointers: tombstone + poison ──
    const retireParent = "retire-parent"
    const retireSub = `${retireParent}__wf_run1_a0`
    const parentSaver = await runtime.getCheckpointer(retireParent)
    const subSaver = await runtime.getCheckpointer(retireSub)
    await subSaver.put(config(retireSub), checkpoint("sub-cp"), metadata)
    await runtime.retireThreadCheckpointers(retireParent)

    // Held references (a hung run outliving deletion) must fail fast, never
    // re-initialize and write again.
    for (const [saver, id] of [
      [parentSaver, retireParent],
      [subSaver, retireSub]
    ] as const) {
      let refused = false
      try {
        await saver.put(config(id), checkpoint("late-cp"), metadata)
      } catch {
        refused = true
      }
      assert.equal(refused, true, `late put via held reference must be refused: ${id}`)
    }

    // Tombstone: no NEW checkpointer for the dead parent or ANY of its
    // sub-threads — not even ids that never had one.
    for (const id of [retireParent, retireSub, `${retireParent}__wf_run9_a9`]) {
      let refused = false
      try {
        await runtime.getCheckpointer(id)
      } catch {
        refused = true
      }
      assert.equal(refused, true, `checkpointer for a deleted thread must be refused: ${id}`)
    }
    let withRefused = false
    try {
      await runtime.withCheckpointer(retireSub, async () => undefined)
    } catch {
      withRefused = true
    }
    assert.equal(withRefused, true, "withCheckpointer on a deleted thread must be refused")

    // ── Revive: a fixed-id service thread (heartbeat) recreated after deletion ──
    runtime.reviveRetiredThread(retireParent)
    const revived = await runtime.getCheckpointer(retireParent)
    assert.notStrictEqual(
      revived,
      parentSaver,
      "a revived id must get a FRESH saver, never the poisoned one"
    )
    await revived.put(config(retireParent), checkpoint("revived-cp"), metadata)
    const revivedTuple = await revived.getTuple(config(retireParent))
    assert.equal(
      revivedTuple?.checkpoint.id,
      "revived-cp",
      "the revived incarnation must be fully usable"
    )
    const revivedSub = await runtime.getCheckpointer(`${retireParent}__wf_run2_a0`)
    assert(revivedSub, "sub-threads of the revived id must be unblocked too")

    // Re-kill cycle: a deletion's LATE retire can land after a revive and
    // tombstone the new incarnation again (heartbeat racing threads:delete).
    // The service re-asserts revival every beat, so revive-after-re-kill must
    // work indefinitely, not just once.
    await runtime.retireThreadCheckpointers(retireParent)
    let rekilledRefused = false
    try {
      await runtime.getCheckpointer(retireParent)
    } catch {
      rekilledRefused = true
    }
    assert.equal(rekilledRefused, true, "a late retire must re-tombstone the revived id")
    runtime.reviveRetiredThread(retireParent)
    const reRevived = await runtime.getCheckpointer(retireParent)
    await reRevived.put(config(retireParent), checkpoint("re-revived-cp"), metadata)
    assert(
      (await reRevived.getTuple(config(retireParent)))?.checkpoint.id === "re-revived-cp",
      "revive after a re-kill must fully restore the id (per-beat assertion converges)"
    )

    // ── Concurrency: retire while a reusable close is waiting on a pin ──
    // closeCheckpointer waits for the pinned operation; retire must await that
    // in-flight close AND still poison the instance (mirrored at close start),
    // so a held reference cannot re-initialize after deletion.
    const racedId = "retire-during-close"
    let releaseRacedOp: (() => void) | undefined
    let markRacedStarted: (() => void) | undefined
    const racedStarted = new Promise<void>((resolveStarted) => {
      markRacedStarted = resolveStarted
    })
    const racedBlocker = new Promise<void>((resolveBlocker) => {
      releaseRacedOp = resolveBlocker
    })
    let racedSaver: import("../src/main/checkpointer/sqljs-saver").SqlJsSaver | undefined
    const racedOperation = runtime.withCheckpointer(racedId, async (saver) => {
      racedSaver = saver
      await saver.put(config(racedId), checkpoint("raced-cp"), metadata)
      markRacedStarted?.()
      await racedBlocker
    })
    await racedStarted
    const racedClose = runtime.closeCheckpointer(racedId) // now waiting on the pin
    const racedRetire = runtime.retireThreadCheckpointers(racedId)
    await new Promise((resolveTick) => setTimeout(resolveTick, 30))
    releaseRacedOp?.()
    await Promise.all([racedOperation, racedClose, racedRetire])
    let racedHeldRefused = false
    try {
      await racedSaver!.put(config(racedId), checkpoint("late-raced-cp"), metadata)
    } catch {
      racedHeldRefused = true
    }
    assert.equal(
      racedHeldRefused,
      true,
      "the instance closed by an in-flight reusable close must still end up poisoned"
    )
    let racedNewRefused = false
    try {
      await runtime.getCheckpointer(racedId)
    } catch {
      racedNewRefused = true
    }
    assert.equal(racedNewRefused, true, "the raced id must stay tombstoned after retire")

    // ── REAL .bak recovery fixture: mid-init recovery write-back must be re-swept ──
    // openRecoveredSqliteDatabase persists a selected .bak back to the live
    // .sqlite INSIDE initialize(), before the post-init refusal check — a write
    // the retire gate cannot stop. Deterministic ordering: the get's entry
    // tombstone check passes BEFORE the retire registers, so it must proceed
    // into initialize (running the recovery write) and then hit the ACTIVE
    // tombstone at the post-init check — refusal + re-sweep, no timing luck.
    const recoveryId = "recovery-mid-init"
    const threadsDir = join(home, ".cmbcoworkagent", "threads")
    await mkdir(threadsDir, { recursive: true })
    {
      // Craft a valid sqlite file and plant it as the .bak recovery candidate
      // (no live file → initialize WILL select it and write live back).
      const fixturePath = join(home, "recovery-fixture.sqlite")
      const fixture = new SqlJsSaver(fixturePath)
      await fixture.put(config(recoveryId), checkpoint("recovered-cp"), metadata)
      await fixture.flush()
      await fixture.close()
      await rename(fixturePath, join(threadsDir, `${recoveryId}.sqlite.bak`))
    }
    const pendingRecoveryGet = runtime.getCheckpointer(recoveryId) // entry check passes now
    const recoveryRetire = runtime.retireThreadCheckpointers(recoveryId) // registered before init resumes
    let recoveryRefused = false
    try {
      await pendingRecoveryGet
    } catch {
      recoveryRefused = true
    }
    await recoveryRetire
    assert.equal(
      recoveryRefused,
      true,
      "the recovering init must be refused: tombstone is active at the post-init check"
    )
    {
      const { readdirSync } = await import("fs")
      const leftovers = readdirSync(threadsDir).filter((file) => file.startsWith(recoveryId))
      assert.equal(
        leftovers.length,
        0,
        `the recovery write-back (live) AND the .bak candidate must be re-swept on refusal, found: ${leftovers.join(", ")}`
      )
    }
    runtime.reviveRetiredThread(recoveryId) // hygiene: don't leak the tombstone to later scenarios

    // ── Empty-registry retire still fences (and sweeps for) a fixed-id reviver ──
    // A thread whose saver is NOT cached anywhere (file on disk only) must
    // still get a retiring-channel entry AND a clean disk before that entry
    // settles — else a revived heartbeat's warm-path init could load the dead
    // incarnation's bytes from the not-yet-swept file.
    const bareId = "bare-retire-sweep"
    {
      // Plant on-disk state with NO cached saver (bypasses the runtime maps).
      const bare = new SqlJsSaver(join(threadsDir, `${bareId}.sqlite`))
      await bare.put(config(bareId), checkpoint("dead-incarnation-cp"), metadata)
      await bare.flush()
      await bare.close()
    }
    await runtime.retireThreadCheckpointers(bareId)
    {
      const { readdirSync } = await import("fs")
      const leftovers = readdirSync(threadsDir).filter((file) => file.startsWith(bareId))
      assert.equal(
        leftovers.length,
        0,
        `retire must sweep the uncached id's durable files before settling, found: ${leftovers.join(", ")}`
      )
    }
    runtime.reviveRetiredThread(bareId)
    const bareRevived = await runtime.getCheckpointer(bareId)
    assert.equal(
      await bareRevived.getTuple(config(bareId)),
      undefined,
      "the revived incarnation must start clean — no dead-incarnation bytes may leak through"
    )

    // ── Tombstone race: retire lands while getCheckpointer is still initializing ──
    // The new instance is in NO registry during initialize(), so retire can't
    // poison it — the post-initialize re-check must refuse and retire it instead
    // of caching a live writable saver for a deleted thread.
    const midInitId = "retire-mid-init"
    const pendingCreate = runtime.getCheckpointer(midInitId) // suspended at its first await
    const midInitRetire = runtime.retireThreadCheckpointers(midInitId) // tombstone lands mid-init
    let midInitRefused = false
    try {
      await pendingCreate
    } catch {
      midInitRefused = true
    }
    await midInitRetire
    assert.equal(
      midInitRefused,
      true,
      "a checkpointer initializing when its thread is deleted must be refused, never cached"
    )
    // initialize() can WRITE before the refusal check (recovery persists a
    // .bak/.tmp back to live; setup queues a save) — the refusal must re-sweep,
    // leaving zero on-disk artifacts for the still-tombstoned id.
    {
      const checkpointDirCandidates = [
        join(home, ".cmbcoworkagent", "threads"),
        join(home, ".cmbcoworkagent")
      ]
      const { readdirSync, existsSync: existsSyncFs } = await import("fs")
      const leftovers: string[] = []
      for (const dir of checkpointDirCandidates) {
        if (!existsSyncFs(dir)) continue
        for (const file of readdirSync(dir)) {
          if (file.startsWith(midInitId)) leftovers.push(join(dir, file))
        }
      }
      assert.equal(
        leftovers.length,
        0,
        `mid-init refusal must leave no on-disk artifacts, found: ${leftovers.join(", ")}`
      )
    }
    let midInitStillRefused = false
    try {
      await runtime.getCheckpointer(midInitId)
    } catch {
      midInitStillRefused = true
    }
    assert.equal(midInitStillRefused, true, "the mid-init-raced id must stay tombstoned")

    // ── Revive racing an in-flight retire (heartbeat's per-beat revive) ──
    // retireThreadCheckpointers registers its per-id teardown in the closing
    // map SYNCHRONOUSLY, so a revived fixed-id thread's getCheckpointer waits
    // the retire out instead of creating its new saver alongside the old one's
    // in-flight teardown.
    const raceReviveId = "revive-during-retire"
    const oldSaver = await runtime.getCheckpointer(raceReviveId)
    await oldSaver.put(config(raceReviveId), checkpoint("old-cp"), metadata)
    const retireInFlight = runtime.retireThreadCheckpointers(raceReviveId)
    runtime.reviveRetiredThread(raceReviveId) // the beat's unconditional revive
    const newSaver = await runtime.getCheckpointer(raceReviveId) // must wait retire settle
    await retireInFlight
    assert.notStrictEqual(
      newSaver,
      oldSaver,
      "a revive racing the retire must get a FRESH saver, never the one being torn down"
    )
    let oldStillPoisoned = false
    try {
      await oldSaver.put(config(raceReviveId), checkpoint("late-old-cp"), metadata)
    } catch {
      oldStillPoisoned = true
    }
    assert.equal(oldStillPoisoned, true, "the retired old saver stays poisoned after the revive")
    await newSaver.put(config(raceReviveId), checkpoint("new-cp"), metadata)
    assert.equal(
      (await newSaver.getTuple(config(raceReviveId)))?.checkpoint.id,
      "new-cp",
      "the revived incarnation's saver is fully usable"
    )

    // ── Same race, but in heartbeat's REAL order: pin FIRST, then revive+get ──
    // Pinned callers skip the reusable-close wait, so the retire must live on
    // its own pin-immune wait channel — this is exactly the path the previous
    // (unpinned) scenario missed and reviewers reproduced a bypass on.
    const pinnedRaceId = "pinned-revive-during-retire"
    const pinnedOldSaver = await runtime.getCheckpointer(pinnedRaceId)
    await pinnedOldSaver.put(config(pinnedRaceId), checkpoint("pinned-old-cp"), metadata)
    const releasePinnedRace = runtime.pinCheckpointer(pinnedRaceId) // heartbeat pins first
    try {
      const pinnedRetire = runtime.retireThreadCheckpointers(pinnedRaceId)
      runtime.reviveRetiredThread(pinnedRaceId) // the beat's unconditional revive
      const pinnedNewSaver = await runtime.getCheckpointer(pinnedRaceId) // pinned get
      await pinnedRetire
      assert.notStrictEqual(
        pinnedNewSaver,
        pinnedOldSaver,
        "a PINNED revive-then-get must also wait the retire out, never reuse the retiring saver"
      )
      let pinnedOldPoisoned = false
      try {
        await pinnedOldSaver.put(config(pinnedRaceId), checkpoint("late-pinned-cp"), metadata)
      } catch {
        pinnedOldPoisoned = true
      }
      assert.equal(pinnedOldPoisoned, true, "the retired saver stays poisoned on the pinned path")
      await pinnedNewSaver.put(config(pinnedRaceId), checkpoint("pinned-new-cp"), metadata)
      assert.equal(
        (await pinnedNewSaver.getTuple(config(pinnedRaceId)))?.checkpoint.id,
        "pinned-new-cp",
        "the pinned revived incarnation's saver is fully usable"
      )
    } finally {
      releasePinnedRace()
    }

    // ── Mid-init DELETE + REVIVE: the retire-epoch fence ──
    // A saver whose initialize() began before a delete is in no registry; if a
    // revive lands before initialize() returns, the tombstone re-check alone
    // passes and the PRE-deletion-born saver would be cached as the new
    // incarnation. Race-tolerant assertion: whichever side wins the timing,
    // the end state must never be a WRITABLE pre-deletion saver.
    const epochRaceId = "retire-epoch-mid-init"
    const pendingEpochGet = runtime.getCheckpointer(epochRaceId)
    await new Promise((resolveTick) => setTimeout(resolveTick, 0)) // let it enter initialize
    const epochRetire = runtime.retireThreadCheckpointers(epochRaceId)
    runtime.reviveRetiredThread(epochRaceId) // revive clears the tombstone mid-init
    let epochRefused = false
    let epochGot: import("../src/main/checkpointer/sqljs-saver").SqlJsSaver | undefined
    try {
      epochGot = await pendingEpochGet
    } catch {
      epochRefused = true
    }
    await epochRetire
    if (!epochRefused && epochGot) {
      // The get won the race (completed before the retire): the saver was in
      // the map, so the retire must have poisoned it.
      let epochPoisoned = false
      try {
        await epochGot.put(config(epochRaceId), checkpoint("stale-cp"), metadata)
      } catch {
        epochPoisoned = true
      }
      assert.equal(
        epochPoisoned,
        true,
        "a pre-deletion saver that finished init before the retire must be poisoned"
      )
    }
    // Either way the revived id must get a FRESH, usable saver afterwards.
    const epochFresh = await runtime.getCheckpointer(epochRaceId)
    if (epochGot) {
      assert.notStrictEqual(
        epochFresh,
        epochGot,
        "the revived incarnation must not reuse the pre-deletion saver"
      )
    }
    await epochFresh.put(config(epochRaceId), checkpoint("fresh-cp"), metadata)
    assert.equal(
      (await epochFresh.getTuple(config(epochRaceId)))?.checkpoint.id,
      "fresh-cp",
      "the revived incarnation's fresh saver is fully usable"
    )

    console.log("checkpointer LRU lease tests passed")
  } finally {
    await runtime.closeRuntime()
    await rm(home, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

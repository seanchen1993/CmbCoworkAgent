/**
 * Regression coverage for runtime checkpointer leases and close coordination.
 *
 * Run:
 *   npx tsx tests/checkpointer-lru.spec.ts
 */

import assert from "assert"
import { mkdtemp, rm } from "fs/promises"
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

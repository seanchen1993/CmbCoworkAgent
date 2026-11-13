import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint"
import type { RunnableConfig } from "@langchain/core/runnables"
import { expect, it } from "vitest"
import { SqlJsSaver } from "./sqljs-saver"

it("keeps future pending interrupts while pruning only existing expired root checkpoints", async () => {
  const root = mkdtempSync(join(tmpdir(), "saver-root-future-writes-"))
  const path = join(root, "checkpoint.sqlite")
  const saver = new SqlJsSaver(path, undefined, {
    maxRootCheckpoints: 1,
    maxRootForkBoundaryCheckpoints: 1
  })
  const threadId = "root-retention"
  const config: RunnableConfig = { configurable: { thread_id: threadId } }
  const checkpoint = (id: string, step: number): Checkpoint => ({
    v: 1,
    id,
    ts: new Date(Date.UTC(2026, 7, 28, 0, 0, step)).toISOString(),
    channel_values: { messages: [{ id: "message-" + id, role: "user", content: id }] },
    channel_versions: { messages: step },
    versions_seen: {}
  })
  const metadata = (step: number): CheckpointMetadata => ({
    source: "loop",
    step,
    parents: {},
    cmb_fork_boundary: {
      source: "agent_run_complete",
      outcome: "completed",
      markedAt: new Date(Date.UTC(2026, 7, 28, 0, 0, step)).toISOString()
    }
  } as CheckpointMetadata)
  const read = () => {
    const database = new DatabaseSync(path, { readOnly: true })
    try {
      return {
        checkpoints: database.prepare(
          "SELECT thread_id, checkpoint_ns, checkpoint_id FROM checkpoints"
        ).all(),
        writes: database.prepare(
          "SELECT thread_id, checkpoint_ns, checkpoint_id, task_id, channel FROM writes"
        ).all()
      }
    } finally {
      database.close()
    }
  }
  const interrupt = {
    id: "pending-host-question",
    value: { protocol: "host-input-test", requestId: "saved-question" }
  }
  try {
    const first = await saver.put(config, checkpoint("past-a", 1), metadata(1))
    const second = await saver.put(first, checkpoint("past-b", 2), metadata(2))
    await saver.putWrites(first, [["stale", "expired"]], "expired-task")
    await saver.putWrites(second, [["retained", "keep"]], "retained-task")
    await saver.put({
      configurable: { thread_id: threadId, checkpoint_ns: "other" }
    }, checkpoint("future", 4), metadata(4))
    await saver.put({
      configurable: { thread_id: "other-thread", checkpoint_ns: "" }
    }, checkpoint("future", 4), metadata(4))
    const future: RunnableConfig = {
      configurable: { thread_id: threadId, checkpoint_ns: "", checkpoint_id: "future" }
    }
    await saver.putWrites(future, [["__interrupt__", [interrupt]]], "future-task")
    await saver.putWrites({
      configurable: { thread_id: threadId, checkpoint_ns: "other", checkpoint_id: "future" }
    }, [["other", "other-namespace"]], "other-namespace-task")
    await saver.putWrites({
      configurable: { thread_id: "other-thread", checkpoint_ns: "", checkpoint_id: "future" }
    }, [["other", "other-thread"]], "other-thread-task")

    const before = read()
    expect(before.checkpoints.filter(row => row.thread_id === threadId &&
      row.checkpoint_ns === "").map(row => row.checkpoint_id).sort()).toEqual(["past-a", "past-b"])
    expect(before.checkpoints.some(row => row.thread_id === threadId &&
      row.checkpoint_ns === "" && row.checkpoint_id === "future")).toBe(false)
    expect(before.writes.filter(row => row.task_id === "future-task")).toHaveLength(1)
    expect(before.writes.filter(row => row.task_id === "expired-task")).toHaveLength(1)
    expect(before.writes.filter(row => row.task_id === "retained-task")).toHaveLength(1)

    const third = await saver.put(second, checkpoint("past-c", 3), metadata(3))
    const after = read()
    expect(after.checkpoints.filter(row => row.thread_id === threadId &&
      row.checkpoint_ns === "").map(row => row.checkpoint_id).sort()).toEqual(["past-b", "past-c"])
    expect(after.writes.filter(row => row.task_id === "future-task")).toHaveLength(1)
    expect(after.writes.filter(row => row.task_id === "expired-task")).toHaveLength(0)
    expect(after.writes.filter(row => row.task_id === "retained-task")).toHaveLength(1)
    expect(after.writes.filter(row => row.task_id === "other-namespace-task")).toHaveLength(1)
    expect(after.writes.filter(row => row.task_id === "other-thread-task")).toHaveLength(1)

    const savedFuture = await saver.put(third, checkpoint("future", 4), metadata(4))
    expect((await saver.getTuple(savedFuture))?.pendingWrites).toEqual([
      ["future-task", "__interrupt__", [interrupt]]
    ])
  } finally {
    await saver.close()
    rmSync(root, { recursive: true, force: true })
  }
})

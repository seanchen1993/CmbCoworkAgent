import { afterEach, describe, expect, it, vi } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost } from "./host"
import type { AgentRunTerminal } from "../agent/agent-run-service"
import { createBotNotificationDispatcher } from "./notification-dispatch"
import { WORKFLOW_NOTIFICATION_TURN_PROMPT } from "../../shared/internal-notification-turn"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

function coordinatorFixture(terminals: AgentRunTerminal[]) {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db)
  let starts = 0
  const host = new LocalBotHost(store, {
    onAvailable: () => () => {},
    acquire: () => {
      let terminal: AgentRunTerminal
      return {
        execute: async () => {
          terminal = terminals[starts++] ?? { outcome: "success", code: "normal", coordinatorNotificationDelivered: true }
          return terminal.outcome === "success"
            ? { state: "completed" as const, result: "Result delivered" }
            : { state: "failed" as const, error: "Controlled summary failure" }
        },
        notificationTerminal: () => terminal,
        release: () => {}
      }
    }
  })
  cleanups.push(async () => { await host.stop(); db.close() })
  const bot = host.create({ name: "Linked Team", instructions: "", color: "#123456", modelRef: null })
  const dispatch = createBotNotificationDispatcher(
    () => ({ metadata: JSON.stringify({ botId: bot.id, botHostId: "local" }) }), () => host
  )
  const notice = { threadId: bot.threadId, kind: "coordinator" as const, key: "queue-a" }
  return { store, host, bot, dispatch, notice, starts: () => starts }
}

describe("Bot notification routing", () => {
  it("retries only the failed summary before coordinator results were checkpointed", async () => {
    const failure: AgentRunTerminal = { outcome: "error", code: "setup_error", coordinatorNotificationDelivered: false }
    const f = coordinatorFixture([failure])
    expect(await f.dispatch(f.notice)).toMatchObject({ terminal: failure, acknowledged: false })
    expect(f.starts()).toBe(1)
    expect(await f.dispatch(f.notice)).toMatchObject({ terminal: { outcome: "success", coordinatorNotificationDelivered: true }, acknowledged: true })
    expect(f.starts()).toBe(2)
    await f.dispatch(f.notice)
    expect(f.starts()).toBe(2)
    expect(f.store.recentTasks()).toHaveLength(2)
  })

  it("does not retry a consumed result on later model failure or block another result batch", async () => {
    const f = coordinatorFixture([{ outcome: "error", code: "setup_error", coordinatorNotificationDelivered: true }])
    expect(await f.dispatch(f.notice)).toMatchObject({ acknowledged: true })
    expect(await f.dispatch(f.notice)).toMatchObject({ acknowledged: true })
    expect(f.starts()).toBe(1)
    expect(await f.dispatch({ ...f.notice, key: "queue-b" })).toMatchObject({ acknowledged: true })
    expect(f.starts()).toBe(2)
  })

  it.each(["cancelled", "hook_halt", "recovery_interrupted"] as const)(
    "does not retry or acknowledge unconsumed results after %s", async (code) => {
      const f = coordinatorFixture([{ outcome: "error", code, coordinatorNotificationDelivered: false }])
      expect(await f.dispatch(f.notice)).toMatchObject({ terminal: { code }, acknowledged: false })
      await f.dispatch(f.notice)
      expect(f.starts()).toBe(1)
    }
  )
  it("leaves ordinary threads alone and queues local Bot work with trusted group identity", async () => {
    const enqueueNotification = vi.fn()
    let metadata: Record<string, unknown> = { agentMode: "workflow" }
    const dispatch = createBotNotificationDispatcher(
      () => ({ metadata: JSON.stringify(metadata) }),
      () => ({ enqueueNotification, waitForNotification: vi.fn(), acknowledgeNotification: vi.fn() })
    )
    const notice = {
      threadId: "group-g-a",
      kind: "workflow" as const,
      key: "wf-1",
      runStartedAt: "2026-10-18T13:00:00.000Z"
    }
    expect(await dispatch(notice)).toBe(false)
    expect(enqueueNotification).not.toHaveBeenCalled()
    metadata = { botId: "a", botHostId: "local", botGroupId: "g" }
    expect(await dispatch(notice)).toBe(true)
    expect(enqueueNotification).toHaveBeenCalledWith(
      "a",
      "group-g-a",
      "workflow",
      "wf-1",
      WORKFLOW_NOTIFICATION_TURN_PROMPT,
      "g",
      notice.runStartedAt
    )
  })
  it("does not run a foreign host locally or silently bypass an unavailable Bot queue", async () => {
    const getHost = vi.fn(() => {
      throw new Error("unavailable")
    })
    let host = "remote"
    const dispatch = createBotNotificationDispatcher(
      () => ({ metadata: JSON.stringify({ botId: "a", botHostId: host }) }),
      getHost
    )
    const notice = { threadId: "t", kind: "coordinator" as const, key: "receipt" }
    expect(await dispatch(notice)).toBe(true)
    expect(getHost).not.toHaveBeenCalled()
    host = "local"
    await expect(dispatch(notice)).rejects.toThrow("unavailable")
  })
})

import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync
} from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, describe, expect, it } from "vitest"
import { ManagedRunStore, resolveManagedRunProjectRoot } from "./managed-run-store"

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function makeStore(): ManagedRunStore {
  const directory = mkdtempSync(join(tmpdir(), "managed-run-store-"))
  temporaryDirectories.push(directory)
  return new ManagedRunStore({ rootDir: directory })
}

function eventPath(store: ManagedRunStore, runId: string): string {
  return join(store.getRootDir(), "feature-1", runId, "events.ndjson")
}

function runPath(store: ManagedRunStore, runId: string): string {
  return join(store.getRootDir(), "feature-1", runId, "run.json")
}

describe("ManagedRunStore", () => {
  it("places project-scoped runs under .cmbdevclaw/managed-runs", () => {
    expect(resolveManagedRunProjectRoot(join("workspace", "project"))).toBe(
      join("workspace", "project", ".cmbdevclaw", "managed-runs")
    )
  })

  it("writes second-precision GMT+8 events and persists the latest decision", () => {
    const store = makeStore()
    const snapshot = store.createRun("project-1", "feature-1")

    const started = store.appendEvent(snapshot, { type: "run_started", summary: "启动" })
    const updated = store.updateSnapshot(snapshot, {
      type: "managed_run_decision",
      scope: "stage",
      sourceEventId: started.eventId,
      sourceEventType: started.type,
      decisionActor: "controller",
      decisionChannel: "system",
      decisionAction: "start_new_thread",
      policyResult: {
        type: "biz_progress",
        proposedAction: "start_new_thread",
        reasonCode: "next_action_resolved",
        facts: {
          currentNodeId: "dev.plan",
          featureStatus: "in_progress",
          currentNodeStatus: "in_progress",
          slashSkill: "dev-plan",
          changedFields: ["currentNode"],
          initialInspection: false,
          bizRetryCount: 0,
          providerRetryCount: 0,
          terminalOutcome: "success"
        },
        rule: "阶段发生变化时推进。"
      },
      summary: "创建下一个工作单元"
    })
    const event = store.listEvents(snapshot).events.at(-1)

    expect(event?.version).toBe(2.5)
    expect(event?.eventId).toEqual(expect.any(String))
    expect(event?.createTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u)
    expect(updated.lastDecision).toMatchObject({
      policyResult: {
        type: "biz_progress",
        proposedAction: "start_new_thread",
        reasonCode: "next_action_resolved",
        rule: "阶段发生变化时推进。",
        facts: { changedFields: ["currentNode"] }
      },
      decisionActor: "controller",
      decisionChannel: "system",
      decisionAction: "start_new_thread",
      summary: "创建下一个工作单元"
    })
    expect(store.getLatestRun("project-1", "feature-1")?.lastDecision).toEqual(updated.lastDecision)
  })

  it("persists separate current-session and hashed decision-baseline state", () => {
    const store = makeStore()
    const snapshot = store.createRun("project-1", "feature-1")
    const updated = store.updateSnapshot({
      ...snapshot,
      currentSession: {
        threadId: "thread-1",
        workspacePath: "/workspace/project"
      },
      decisionBaseline: {
        nodeId: "dev.plan",
        featureStateHash: `v1:sha256:${"a".repeat(64)}`,
        featureStatus: "in_progress",
        nodeStatus: "in_progress",
        nextActionHash: `v1:sha256:${"b".repeat(64)}`
      }
    })

    expect(store.getRun(updated).snapshot).toMatchObject({
      currentSession: { threadId: "thread-1" },
      decisionBaseline: {
        nodeId: "dev.plan",
        featureStateHash: `v1:sha256:${"a".repeat(64)}`,
        nextActionHash: `v1:sha256:${"b".repeat(64)}`
      }
    })
  })

  it("uses opaque byte cursors to read recent events before older pages", () => {
    const store = makeStore()
    const snapshot = store.createRun("project-1", "feature-1")
    for (let index = 0; index < 4; index += 1) {
      store.appendEvent(snapshot, {
        type: "managed_agent_turn_ended",
        nodeId: "dev.plan",
        threadId: `thread-${index}`,
        outcome: "success",
        endReason: { code: "normal" },
        summary: `Turn ${index}`
      })
    }

    const first = store.listEvents(snapshot, undefined, 2)
    const second = store.listEvents(snapshot, first.nextCursor, 2)

    expect(first.events).toHaveLength(2)
    expect(first.hasMore).toBe(true)
    expect(first.nextCursor).toEqual(expect.any(String))
    expect(second.events).toHaveLength(2)
    expect(first.events.map((event) => event.summary)).toEqual(["Turn 2", "Turn 3"])
    expect(second.events.map((event) => event.summary)).toEqual(["Turn 0", "Turn 1"])
    expect(second.events[0]?.eventId).not.toBe(first.events[0]?.eventId)
  })

  it("truncates a malformed journal tail before appending", () => {
    const store = makeStore()
    const snapshot = store.createRun("project-1", "feature-1")
    const started = store.appendEvent(snapshot, { type: "run_started", summary: "启动" })
    appendFileSync(eventPath(store, snapshot.runId), "{broken-tail")

    store.appendEvent(snapshot, {
      type: "managed_run_decision",
      sourceEventId: started.eventId,
      sourceEventType: started.type,
      decisionActor: "controller",
      decisionChannel: "system",
      decisionAction: "start_new_thread",
      policyResult: {
        type: "biz_progress",
        proposedAction: "start_new_thread",
        reasonCode: "initial_action_resolved",
        rule: "测试尾行修复后仍可写入决策事件。"
      },
      summary: "尾行修复后继续"
    })

    expect(store.listEvents(snapshot).events.map((event) => event.type)).toEqual([
      "run_started",
      "managed_run_decision"
    ])
  })

  it("preserves a valid final event that is missing only its newline", () => {
    const store = makeStore()
    const snapshot = store.createRun("project-1", "feature-1")
    store.appendEvent(snapshot, { type: "run_started", summary: "启动" })
    const path = eventPath(store, snapshot.runId)
    truncateSync(path, statSync(path).size - 1)

    store.appendEvent(snapshot, {
      type: "managed_agent_turn_ended",
      nodeId: "dev.plan",
      threadId: "thread-1",
      outcome: "success",
      endReason: { code: "normal" },
      summary: "补齐换行后继续"
    })

    expect(store.listEvents(snapshot).events.map((event) => event.type)).toEqual([
      "run_started",
      "managed_agent_turn_ended"
    ])
  })

  it("persists structured session completion facts", () => {
    const store = makeStore()
    const snapshot = store.createRun("project-1", "feature-1")

    store.appendEvent(snapshot, {
      type: "managed_agent_turn_ended",
      scope: "stage",
      threadId: "thread-1",
      outcome: "error",
      endReason: { code: "provider_error", message: "upstream unavailable" },
      summary: "会话结束"
    })

    expect(store.listEvents(snapshot).events.at(-1)).toMatchObject({
      type: "managed_agent_turn_ended",
      outcome: "error",
      endReason: { code: "provider_error", message: "upstream unavailable" }
    })
  })

  it("fails closed for corruption before a later complete event", () => {
    const store = makeStore()
    const snapshot = store.createRun("project-1", "feature-1")
    appendFileSync(
      eventPath(store, snapshot.runId),
      `{broken}\n${JSON.stringify({
        version: 2.5,
        eventId: "later-event",
        createTime: "2026-08-23 20:00:00",
        type: "run_stop_requested",
        runId: snapshot.runId,
        scope: "global",
        summary: "请求停止"
      })}\n`
    )

    expect(() => store.listEvents(snapshot)).toThrow(/JSON|event/iu)
    expect(store.getLatestRun("project-1", "feature-1")?.status).toBe("corrupt")
    expect(store.findRunningRun("project-1", "feature-1")).toBeNull()

    const replacement = store.createRun("project-1", "feature-1")
    expect(store.findRunningRun("project-1", "feature-1")?.runId).toBe(replacement.runId)
  })

  it("marks a snapshot with a malformed decision baseline as corrupt", () => {
    const store = makeStore()
    const snapshot = store.createRun("project-1", "feature-1")
    const path = runPath(store, snapshot.runId)
    const persisted = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    persisted.currentSession = { threadId: "thread-1" }
    persisted.decisionBaseline = { nodeId: "dev.plan", featureStatus: "invalid" }
    writeFileSync(path, `${JSON.stringify(persisted, null, 2)}\n`, "utf8")

    expect(store.getLatestRun("project-1", "feature-1")?.status).toBe("corrupt")
    expect(store.findRunningRun("project-1", "feature-1")).toBeNull()

    const replacement = store.createRun("project-1", "feature-1")
    expect(store.findRunningRun("project-1", "feature-1")?.runId).toBe(replacement.runId)
  })

  it("fails closed for malformed nested decision facts before a later event", () => {
    const store = makeStore()
    const snapshot = store.createRun("project-1", "feature-1")
    appendFileSync(
      eventPath(store, snapshot.runId),
      `${JSON.stringify({
        version: 2.5,
        eventId: "invalid-decision",
        createTime: "2026-08-24 10:00:00",
        type: "managed_run_decision",
        runId: snapshot.runId,
        scope: "stage",
        sourceEventId: "source-event",
        sourceEventType: "run_started",
        decisionActor: "controller",
        decisionChannel: "system",
        decisionAction: "start_new_thread",
        policyResult: {
          type: "biz_progress",
          proposedAction: "start_new_thread",
          reasonCode: "initial_action_resolved",
          facts: {
            currentNodeId: "dev.plan",
            featureStatus: "in_progress",
            currentNodeStatus: "in_progress",
            changedFields: "currentNode",
            initialInspection: false,
            bizRetryCount: 0,
            providerRetryCount: 0
          },
          rule: "无效 facts 不应通过校验"
        },
        summary: "无效决策"
      })}\n${JSON.stringify({
        version: 2.5,
        eventId: "later-run-failed",
        createTime: "2026-08-24 10:00:01",
        type: "run_failed",
        runId: snapshot.runId,
        scope: "global",
        decisionEventId: "invalid-decision",
        summary: "失败"
      })}\n`
    )

    expect(() => store.listEvents(snapshot)).toThrow(/invalid schema/iu)
    expect(store.getLatestRun("project-1", "feature-1")?.status).toBe("corrupt")
  })

  it("keeps terminal history while allowing a later run", () => {
    const store = makeStore()
    const first = store.createRun("project-1", "feature-1")
    const started = store.appendEvent(first, { type: "run_started", summary: "启动" })
    const decision = store.appendEvent(first, {
      type: "managed_run_decision",
      sourceEventId: started.eventId,
      sourceEventType: started.type,
      decisionActor: "controller",
      decisionChannel: "system",
      decisionAction: "complete_managed_run",
      policyResult: {
        type: "run_termination",
        proposedAction: "complete_managed_run",
        reasonCode: "feature_terminal"
      },
      summary: "特性已进入终态"
    })
    const completed = store.updateSnapshot(
      { ...first, status: "completed" },
      {
        type: "run_completed",
        scope: "global",
        decisionEventId: decision.eventId,
        summary: "完成"
      }
    )
    expect(store.findRunningRun("project-1", "feature-1")).toBeNull()

    const second = store.createRun("project-1", "feature-1")
    expect(second.runId).not.toBe(completed.runId)
    expect(store.findRunningRun("project-1", "feature-1")?.snapshot?.runId).toBe(second.runId)
    expect(store.listRuns()).toHaveLength(2)
  })
})

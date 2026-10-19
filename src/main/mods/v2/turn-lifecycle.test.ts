import { describe, it, expect, vi } from "vitest"
import { AIMessage } from "@langchain/core/messages"
import { setImmediate as tick } from "node:timers/promises"
import {
  FunctionTurnLifecycle,
  FunctionTurnAbortBudget,
  type FunctionTurnBinding
} from "./turn-lifecycle"
import type { FunctionTurnComplete } from "../../../shared/mods/v2/turn"

function fixture() {
  const busy = new Set<string>()
  const starts: string[] = []
  const ends: FunctionTurnComplete[] = []
  const anchors: Array<string | undefined> = []
  const error = vi.fn()
  let idle!: (threadId: string) => void
  let now = 10
  const dispose = vi.fn()
  const lifecycle = new FunctionTurnLifecycle(
    {
      start: async (_binding, input) => {
        starts.push(input.turnId)
      },
      complete: async (_binding, input, _signal, anchorMessageId) => {
        ends.push(input)
        anchors.push(anchorMessageId)
      },
      isBusy: (threadId) => busy.has(threadId),
      onIdle: (listener) => {
        idle = listener
        return dispose
      },
      error
    },
    () => now
  )
  function binding(runId = "run", turnId = "turn"): FunctionTurnBinding {
    const controller = new AbortController()
    return {
      workspace: "/workspace",
      threadId: "thread",
      runId,
      turnId,
      text: "prompt",
      signal: controller.signal,
      cancel: () => controller.abort(),
      assertCurrent: vi.fn()
    }
  }
  return {
    lifecycle,
    binding,
    starts,
    ends,
    anchors,
    busy,
    error,
    dispose,
    advance: () => {
      now += 20
    },
    idle: () => idle("thread")
  }
}

describe("function turn lifecycle", () => {
  it("reports real registered start before its hook and clears a rejected private start receipt", async () => {
    const f = fixture()
    const bad = f.binding()
    bad.onStarted = () => {
      expect(f.lifecycle.stats).toEqual({ entries: 1, running: 1 })
      expect(f.starts).toEqual([])
      throw Error("ACTUAL_RECEIPT_EXPIRED")
    }
    await expect(f.lifecycle.start(bad)).rejects.toThrow("ACTUAL_RECEIPT_EXPIRED")
    expect(f.lifecycle.stats).toEqual({ entries: 0, running: 0 })
    expect(f.starts).toEqual([])
    const next = f.binding("next-run", "next-turn")
    next.onStarted = () => {
      expect(f.lifecycle.hasUnsettled("thread")).toBe(true)
      expect(f.starts).toEqual([])
    }
    await f.lifecycle.start(next)
    expect(f.starts).toEqual(["next-turn"])
    f.lifecycle.finish("thread", "next-run", { reason: "answer" })
    await tick()
    f.lifecycle.close()
  })
  it("configuration stays busy after the physical task ends until actual terminal dispatch settles", async () => {
    const entered = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>()
    const settled = vi.fn()
    const f = fixture()
    const original = f.lifecycle["host"].complete
    f.lifecycle["host"].complete = async (...args) => {
      entered.resolve()
      await finish.promise
      return original(...args)
    }
    const stop = f.lifecycle.onSettled(settled)
    await f.lifecycle.start(f.binding())
    expect(f.lifecycle.hasUnsettled("thread")).toBe(true)
    f.lifecycle.finish("thread", "run", { reason: "answer" })
    await entered.promise
    expect(f.busy.size).toBe(0)
    expect(f.lifecycle.hasUnsettled("thread")).toBe(true)
    expect(settled).not.toHaveBeenCalled()
    finish.resolve()
    await tick()
    expect(f.lifecycle.hasUnsettled("thread")).toBe(false)
    expect(settled).toHaveBeenCalledWith("thread")
    stop()
    f.lifecycle.close()
  })
  it("captures only the original run publication and does not wait for a new leased turn", async () => {
    const f = fixture()
    const entered = Promise.withResolvers<void>(),
      publish = Promise.withResolvers<void>()
    const original = f.lifecycle["host"].complete
    f.lifecycle["host"].complete = async (...args) => {
      entered.resolve()
      await publish.promise
      return original(...args)
    }
    await f.lifecycle.start(f.binding())
    const first = f.lifecycle.captureSettlement("thread", "run")!
    expect(f.lifecycle.captureSettlement("thread", "foreign")).toBeUndefined()
    f.lifecycle.finish("thread", "run", { reason: "answer" })
    await entered.promise
    f.busy.add("thread")
    await f.lifecycle.start(f.binding("next", "next-turn"))
    const next = f.lifecycle.captureSettlement("thread", "next")!
    let nextSettled = false
    void next.then(
      () => {
        nextSettled = true
      },
      () => {
        nextSettled = true
      }
    )
    publish.resolve()
    await first
    expect(nextSettled).toBe(false)
    expect(f.ends.map((end) => end.turnId)).toEqual(["turn"])
    expect(f.lifecycle.hasUnsettled("thread")).toBe(true)
    f.lifecycle.finish("thread", "next", { reason: "answer" })
    f.busy.delete("thread")
    f.idle()
    await next
    f.lifecycle.close()
  })
  it("rejects a captured run when its original entry is invalidated", async () => {
    const f = fixture()
    f.busy.add("thread")
    await f.lifecycle.start(f.binding())
    const settlement = f.lifecycle.captureSettlement("thread", "run")!
    f.lifecycle.finish("thread", "run", { reason: "answer" })
    f.lifecycle.invalidate("/workspace", "thread")
    await expect(settlement).rejects.toThrow("MODS_TURN_SCOPE_CHANGED")
    f.busy.delete("thread")
    f.idle()
    await tick()
    expect(f.ends).toEqual([])
    f.lifecycle.close()
  })
  it("an expired exact settlement owner cannot invalidate a new entry with the same run id", async () => {
    const f = fixture()
    f.busy.add("thread")
    await f.lifecycle.start(f.binding())
    const old = f.lifecycle.captureSettlementOwner("thread", "run")!
    old.invalidate()
    await expect(old.settlement).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
    await f.lifecycle.start(f.binding("run", "new-turn"))
    const next = f.lifecycle.captureSettlementOwner("thread", "run")!
    old.invalidate()
    expect(f.lifecycle.stats).toEqual({ entries: 1, running: 1 })
    f.lifecycle.finish("thread", "run", { reason: "answer" })
    f.busy.delete("thread")
    f.idle()
    await next.settlement
    expect(f.ends.map((end) => end.turnId)).toEqual(["new-turn"])
    f.lifecycle.close()
  })
  it("dispatches a host message anchor separately from the public hook event", async () => {
    const f = fixture()
    await f.lifecycle.start(f.binding())
    f.lifecycle.observe("thread", "run", new AIMessage({ id: "actual", content: "answer" }))
    f.lifecycle.finish("thread", "run", { reason: "answer" })
    await tick()
    expect(f.anchors).toEqual(["actual"])
    expect(f.ends[0]).not.toHaveProperty("anchorMessageId")
    f.lifecycle.close()
  })
  it.each(["answer", "error", "aborted"] as const)(
    "keeps refusal ahead of %s except for explicit cancellation",
    async (reason) => {
      const f = fixture()
      await f.lifecycle.start(f.binding())
      f.lifecycle.observe(
        "thread",
        "run",
        new AIMessage({
          content: "Provider refused",
          response_metadata: {
            stop_reason: "refusal",
            stop_details: { category: "policy", explanation: "Provider explanation" }
          }
        })
      )
      f.lifecycle.finish("thread", "run", { reason })
      await tick()
      expect(f.ends[0]).toMatchObject({
        reason: reason === "aborted" ? "aborted" : "refusal",
        answer: "Provider refused",
        isAborted: reason === "aborted"
      })
      if (reason === "aborted") expect(f.ends[0]).not.toHaveProperty("refusal")
      else
        expect(f.ends[0]).toHaveProperty("refusal", {
          category: "policy",
          explanation: "Provider explanation"
        })
      f.lifecycle.close()
    }
  )

  it("reports a child's explicit refusal separately from its parent's answer", async () => {
    const f = fixture()
    f.busy.add("thread")
    await f.lifecycle.start(f.binding())
    const child = f.lifecycle.startChild({
      ...f.binding("child-run", "child-turn"),
      agentId: "child"
    })
    child.observe(
      new AIMessage({ content: "", response_metadata: { finish_reason: "content_filter" } })
    )
    child.finish("answer")
    await tick()
    expect(f.ends[0]).toMatchObject({
      agentId: "child",
      reason: "refusal",
      refusal: { category: null, explanation: null }
    })
    f.lifecycle.observe("thread", "run", new AIMessage("Parent answer"))
    f.lifecycle.finish("thread", "run", { reason: "answer" })
    f.busy.delete("thread")
    f.idle()
    await tick()
    expect(f.ends[1]).toMatchObject({ answer: "Parent answer", reason: "answer" })
    expect(f.ends[1]).not.toHaveProperty("refusal")
    f.lifecycle.close()
  })

  it("completes an independent child while its main turn still owns the thread", async () => {
    const f = fixture()
    f.busy.add("thread")
    await f.lifecycle.start(f.binding())
    const child = f.lifecycle.startChild({
      ...f.binding("child-run", "child-turn"),
      agentId: "worker",
      parentRunId: "run"
    })
    child.observe(
      new AIMessage({
        id: "child-response",
        content: "child answer",
        response_metadata: { model_name: "child-model" },
        usage_metadata: { input_tokens: 3, output_tokens: 1, total_tokens: 4 }
      })
    )
    f.advance()
    child.finish("answer")
    child.finish("error")
    await tick()
    expect(f.starts).toEqual(["turn"])
    expect(f.ends).toEqual([
      {
        turnId: "child-turn",
        agentId: "worker",
        answer: "child answer",
        reason: "answer",
        isAborted: false,
        durationMs: 20,
        usage: {
          model: "child-model",
          input_tokens: 3,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0
        }
      }
    ])
    expect(f.lifecycle.stats).toEqual({ entries: 1, running: 1 })
    expect(() => f.lifecycle.abort("/workspace", "thread", "child-turn")).toThrow(
      "MODS_TURN_SCOPE_CHANGED"
    )
    f.lifecycle.abort("/workspace", "thread", "turn")
    f.lifecycle.finish("thread", "run", { reason: "answer" })
    f.busy.delete("thread")
    f.idle()
    await tick()
    expect(f.ends[1]).toMatchObject({ turnId: "turn", reason: "aborted", answer: "" })
    expect(f.ends[1].usage).toBeUndefined()
    expect(f.lifecycle.stats).toEqual({ entries: 0, running: 0 })
    f.lifecycle.close()
  })

  it("attributes child partial output only to its current physical owner", async () => {
    const f = fixture()
    const binding = f.binding("child", "child-turn")
    const child = f.lifecycle.startChild({ ...binding, agentId: "worker", parentRunId: "run" })
    const payload = (content: string) => [{ type: "ai", id: "response", content }]
    f.lifecycle.observeChildStream("thread", "old-run", "worker", payload("stale"), "delta")
    f.lifecycle.observeChildStream("thread", "run", "other-worker", payload("other"), "delta")
    f.lifecycle.observeChildStream("thread", "run", "worker", payload("partial"), "delta")
    binding.cancel()
    child.finish("error")
    await tick()
    expect(f.ends[0]).toMatchObject({
      agentId: "worker",
      turnId: "child-turn",
      answer: "partial",
      reason: "aborted"
    })
    f.lifecycle.observeChildStream("thread", "run", "worker", payload("late"), "delta")
    expect(f.lifecycle.stats).toEqual({ entries: 0, running: 0 })
    f.lifecycle.close()
  })

  it("old child settlement cannot clear a replacement using the same agent id", async () => {
    const f = fixture()
    const old = f.lifecycle.startChild({
      ...f.binding("old", "old"),
      agentId: "worker",
      parentRunId: "run"
    })
    const current = f.lifecycle.startChild({
      ...f.binding("new", "new"),
      agentId: "worker",
      parentRunId: "run"
    })
    old.finish("error")
    f.lifecycle.observeChildStream(
      "thread",
      "run",
      "worker",
      [{ type: "ai", id: "r", content: "new answer" }],
      "delta"
    )
    current.finish("answer")
    await tick()
    expect(f.ends.map((event) => [event.turnId, event.answer])).toEqual([
      ["old", ""],
      ["new", "new answer"]
    ])
    f.lifecycle.close()
  })

  it("keeps authority-owned child output isolated from reused public tool labels", async () => {
    const f = fixture()
    const binding = f.binding("private-run", "private-turn")
    const child = f.lifecycle.startChild({
      ...binding,
      agentId: "mod-task:private",
      parentRunId: "run",
      streamSource: "authority"
    })
    const payload = (content: string) => [{ type: "ai", id: "response", content }]
    // Even a public label equal to the private id is not the stream's authority.
    f.lifecycle.observeChildStream("thread", "run", "mod-task:private", payload("spoof"), "delta")
    child.observeStream(payload("partial"), "delta")
    f.lifecycle.observeChildStream(
      "thread",
      "run",
      "mod-task:private",
      payload("duplicate"),
      "delta"
    )
    binding.cancel()
    child.finish("error")
    child.observeStream(payload("late"), "delta")
    await tick()
    expect(f.ends).toHaveLength(1)
    expect(f.ends[0]).toMatchObject({
      agentId: "mod-task:private",
      answer: "partial",
      reason: "aborted"
    })
    f.lifecycle.close()
  })

  it("rejects an expired authority observer and ignores it after replacement", async () => {
    const f = fixture()
    let current = true
    const child = f.lifecycle.startChild({
      ...f.binding("private-run", "private-turn"),
      agentId: "mod-task:private",
      streamSource: "authority",
      assertCurrent: () => {
        if (!current) throw Error("expired")
      }
    })
    current = false
    expect(() => child.observeStream([{ type: "ai", id: "r", content: "late" }], "delta")).toThrow(
      "expired"
    )
    f.lifecycle.invalidate("/workspace", "thread")
    expect(() =>
      child.observeStream([{ type: "ai", id: "r", content: "late" }], "delta")
    ).not.toThrow()
    expect(f.ends).toEqual([])
    f.lifecycle.close()
  })

  it("shares the main/child capacity bound and invalidates pending child callbacks", async () => {
    const f = fixture()
    const children = Array.from({ length: 100 }, (_, index) =>
      f.lifecycle.startChild({
        ...f.binding(`run-${index}`, `turn-${index}`),
        agentId: `worker-${index}`
      })
    )
    await expect(f.lifecycle.start(f.binding())).rejects.toThrow("MODS_TURN_CAPACITY")
    expect(() => f.lifecycle.startChild({ ...f.binding(), agentId: "overflow" })).toThrow(
      "MODS_TURN_CAPACITY"
    )
    children[0].finish("answer")
    f.lifecycle.invalidate("/workspace", "thread")
    children[1].observe(new AIMessage("late"))
    children[1].finish("error")
    await tick()
    expect(f.ends).toEqual([])
    expect(f.lifecycle.stats).toEqual({ entries: 0, running: 0 })
    f.lifecycle.close()
  })

  it("bounds pending turns, ignores detached streams and releases overflowed observations", async () => {
    const f = fixture()
    f.busy.add("thread")
    for (let index = 0; index < 100; index++) {
      await f.lifecycle.start(f.binding(`run-${index}`, `turn-${index}`))
      f.lifecycle.finish("thread", `run-${index}`, { reason: "answer" })
    }
    await expect(f.lifecycle.start(f.binding("overflow"))).rejects.toThrow("MODS_TURN_CAPACITY")
    f.lifecycle.invalidate()
    expect(f.lifecycle.stats).toEqual({ entries: 0, running: 0 })
    await f.lifecycle.start(f.binding())
    const part = (text: string) => [{ type: "ai", id: "part", content: text }]
    f.lifecycle.observeStream("thread", "wrong-run", part("wrong"), "delta")
    f.lifecycle.suspend("thread", "run")
    f.lifecycle.observeStream("thread", "run", part("paused"), "delta")
    await f.lifecycle.start(f.binding("resumed"))
    const settled = vi.fn()
    f.lifecycle.onSettled(settled)
    f.lifecycle.observeStream("thread", "resumed", part("x".repeat(1024 * 1024 + 1)), "delta")
    f.lifecycle.finish("thread", "resumed", { reason: "answer" })
    expect(f.lifecycle.stats).toEqual({ entries: 0, running: 0 })
    expect(f.error).toHaveBeenCalledOnce()
    expect(settled).toHaveBeenCalledWith("thread")
    expect(f.ends).toEqual([])
    f.lifecycle.close()
  })

  it("deduplicates retries and waits for the actual lease release before completion", async () => {
    const f = fixture()
    const binding = f.binding()
    f.busy.add("thread")
    await Promise.all([f.lifecycle.start(binding), f.lifecycle.start(binding)])
    f.advance()
    f.lifecycle.finish("thread", "run", { answer: "answer", reason: "answer" })
    f.lifecycle.finish("thread", "run", { answer: "duplicate", reason: "error" })
    await tick()
    expect(f.starts).toEqual(["turn"])
    expect(f.ends).toEqual([])
    expect(() => f.lifecycle.abort("/workspace", "thread", "turn")).toThrow("MODS_TURN_NOT_RUNNING")
    f.busy.delete("thread")
    f.idle()
    await tick()
    expect(f.ends).toEqual([
      { turnId: "turn", answer: "answer", reason: "answer", isAborted: false, durationMs: 20 }
    ])
    expect(f.lifecycle.stats).toEqual({ entries: 0, running: 0 })
    f.lifecycle.close()
    expect(f.dispose).toHaveBeenCalledOnce()
  })

  it("preserves one logical turn and responses across an approval pause and resume", async () => {
    const f = fixture()
    await f.lifecycle.start(f.binding())
    f.lifecycle.observe(
      "thread",
      "run",
      new AIMessage({
        id: "response-1",
        content: "before pause",
        response_metadata: { model_name: "model-1" },
        usage_metadata: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }
      })
    )
    f.lifecycle.suspend("thread", "run")
    expect(() => f.lifecycle.abort("/workspace", "thread", "turn")).toThrow("MODS_TURN_NOT_RUNNING")
    await f.lifecycle.start(f.binding("resume"))
    f.lifecycle.finish("thread", "run", { reason: "error" })
    f.lifecycle.observe(
      "thread",
      "resume",
      new AIMessage({
        id: "response-2",
        content: "done",
        response_metadata: { model_name: "model-2" },
        usage_metadata: { input_tokens: 20, output_tokens: 3, total_tokens: 23 }
      })
    )
    f.lifecycle.finish("thread", "resume", { reason: "answer" })
    await tick()
    expect(f.starts).toEqual(["turn"])
    expect(f.ends[0]).toMatchObject({
      answer: "done",
      usage: { input_tokens: 30, output_tokens: 5, model: "model-2" }
    })
    f.lifecycle.close()
  })

  it("checks exact turn and workspace, cancels the real controller and keeps the aborted terminal", async () => {
    const f = fixture()
    const binding = f.binding()
    await f.lifecycle.start(binding)
    expect(() => f.lifecycle.abort("/other", "thread", "turn")).toThrow("MODS_TURN_SCOPE_CHANGED")
    expect(() => f.lifecycle.abort("/workspace", "thread", "old")).toThrow(
      "MODS_TURN_SCOPE_CHANGED"
    )
    expect(binding.signal.aborted).toBe(false)
    f.lifecycle.abort("/workspace", "thread", "turn")
    expect(binding.signal.aborted).toBe(true)
    expect(() => f.lifecycle.abort("/workspace", "thread", "turn")).toThrow("MODS_TURN_ENDING")
    f.lifecycle.finish("thread", "run", { reason: "answer" })
    await tick()
    expect(f.ends[0]).toMatchObject({ reason: "aborted", isAborted: true, answer: "" })
    expect(f.ends[0]).not.toHaveProperty("usage")
    f.lifecycle.close()
  })

  it("does not let an old finish cancel or finish its successor", async () => {
    const f = fixture()
    f.busy.add("thread")
    await f.lifecycle.start(f.binding())
    const next = f.binding("new-run", "new-turn")
    await f.lifecycle.start(next)
    f.lifecycle.finish("thread", "run", { reason: "error" })
    expect(() => f.lifecycle.abort("/workspace", "thread", "turn")).toThrow(
      "MODS_TURN_SCOPE_CHANGED"
    )
    expect(next.signal.aborted).toBe(false)
    f.lifecycle.finish("thread", "new-run", { reason: "answer" })
    f.busy.delete("thread")
    f.idle()
    await tick()
    expect(f.ends.map((value) => value.turnId)).toEqual(["turn", "new-turn"])
    f.lifecycle.close()
  })

  it("drops pending completion on configuration change and releases every entry", async () => {
    const f = fixture()
    f.busy.add("thread")
    await f.lifecycle.start(f.binding())
    f.lifecycle.finish("thread", "run", { reason: "answer" })
    f.lifecycle.invalidate("/workspace")
    f.busy.delete("thread")
    f.idle()
    await tick()
    expect(f.ends).toEqual([])
    expect(f.lifecycle.stats).toEqual({ entries: 0, running: 0 })
    f.lifecycle.close()
  })

  it("counts abort attempts per plugin with the frozen 2s / 50 limits", () => {
    let now = 0
    const budget = new FunctionTurnAbortBudget(() => now)
    budget.take("a")
    expect(() => budget.take("a")).toThrow("MODS_TURN_ABORT_RATE")
    budget.take("b")
    for (let count = 1; count < 50; count++) {
      now += 2000
      budget.take("a")
    }
    now += 2000
    expect(() => budget.take("a")).toThrow("MODS_TURN_ABORT_BUDGET")
    expect(() => budget.take("b")).not.toThrow()
  })
})

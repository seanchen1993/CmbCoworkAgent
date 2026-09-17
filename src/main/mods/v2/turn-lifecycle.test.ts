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
  const error = vi.fn()
  let idle!: (threadId: string) => void
  let now = 10
  const dispose = vi.fn()
  const lifecycle = new FunctionTurnLifecycle(
    {
      start: async (_binding, input) => {
        starts.push(input.turnId)
      },
      complete: async (_binding, input) => {
        ends.push(input)
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
    f.lifecycle.observeStream("thread", "resumed", part("x".repeat(1024 * 1024 + 1)), "delta")
    f.lifecycle.finish("thread", "resumed", { reason: "answer" })
    expect(f.lifecycle.stats).toEqual({ entries: 0, running: 0 })
    expect(f.error).toHaveBeenCalledOnce()
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

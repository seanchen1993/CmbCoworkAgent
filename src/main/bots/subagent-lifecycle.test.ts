import { afterEach, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { BotWorkflowStore } from "./workflow-store"
import type { BotRuntimeRequest } from "./host"
import type { BotSkillHooks } from "./skill-hooks"
import { BotSubagentLifecycle, assertBotChildLifecycle } from "./subagent-lifecycle"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cmb-child-lifecycle-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "bots.sqlite")
  let store = new BotStore(path)
  cleanup.push(() => store.close())
  const { bot, conversationId } = store.createBot({ nonce: "owner", name: "Engineer" })
  store.send({ nonce: "task", conversationId, text: "Parent private context" })
  const parent = store.claim("host")!
  const workflow = BotWorkflowStore.open(store, parent.lease, "workflow", {
    script: 'export const meta={name:"Review",description:"Review"}; return await agent("task");',
    maxConcurrency: 2,
    defaultModelId: "test",
    agentProfiles: [],
    authority: { project: "fixture" }
  })
  const controller = new AbortController()
  const hooks = { run: vi.fn<BotSkillHooks["run"]>().mockResolvedValue(null) }
  const child = (n = 0) => {
    const claimed = store.workflowChildren.claim(workflow, parent.lease, {
      prompt: "Assigned review only",
      agentType: "Explore",
      agentIndex: n + 1,
      toolStreamKey: `${"a".repeat(64)}_c${n}`,
      durableCallKey: `${"a".repeat(64)}_n${n}`,
      label: "Inspect code",
      phase: null,
      shellAccess: "read_only"
    })
    const request = (): BotRuntimeRequest => ({
      store,
      bot,
      run: claimed.run,
      lease: claimed.lease!,
      signal: controller.signal,
      messages: []
    })
    return {
      request,
      lifecycle: () => new BotSubagentLifecycle(request(), hooks)
    }
  }
  return {
    child,
    hooks,
    controller,
    parent,
    store: () => store,
    reopen() {
      store.close()
      store = new BotStore(path)
    }
  }
}

it("binds the resolved role and child identity without sending the parent's private task", async () => {
  const f = fixture(),
    a = f.child(),
    b = f.child(1)
  await Promise.all([a.lifecycle().start(), b.lifecycle().start()])
  const contexts = f.hooks.run.mock.calls.map(([event, context]) => ({ event, context }))
  expect(contexts.map((c) => c.context.subagent)).toEqual([
    { id: a.request().run.id, name: "Explore", status: "started" },
    { id: b.request().run.id, name: "Explore", status: "started" }
  ])
  expect(contexts[0]).toMatchObject({
    event: "SubagentStart",
    context: { toolArgs: { task_description: "Assigned review only" } }
  })
  expect(JSON.stringify(contexts)).not.toContain("Parent private context")
  f.reopen()
  await a.lifecycle().start()
  await b.lifecycle().start()
  expect(f.hooks.run).toHaveBeenCalledTimes(2)
})

it.each([false, true])(
  "persists child settlement (failed=%s) before reporting to the parent",
  async (failed) => {
    const f = fixture(),
      a = f.child()
    await a.lifecycle().start()
    await a.lifecycle().finish(failed)
    expect(f.hooks.run.mock.lastCall).toMatchObject([
      "SubagentStop",
      {
        subagent: {
          id: a.request().run.id,
          name: "Explore",
          status: failed ? "failed" : "completed"
        }
      },
      "lifecycle:subagent-stop"
    ])
    f.reopen()
    await a.lifecycle().finish(failed)
    expect(f.hooks.run).toHaveBeenCalledTimes(2)
    expect(() => assertBotChildLifecycle(f.store(), f.parent.run.id)).not.toThrow()
    await expect(a.lifecycle().finish(!failed)).rejects.toMatchObject({
      code: "subagent_hook_outcome"
    })
  }
)

it("keeps a halt authoritative for the parent after recovery and after a caught child error", async () => {
  const f = fixture(),
    a = f.child()
  await a.lifecycle().start()
  f.hooks.run.mockResolvedValue({
    exitCode: 0,
    stdout: "",
    stderr: "",
    blocked: false,
    continue: false,
    stopReason: "Missing release evidence"
  })
  await expect(a.lifecycle().finish(false)).rejects.toMatchObject({ code: "subagent_hook_halted" })
  expect(() => assertBotChildLifecycle(f.store(), f.parent.run.id)).toThrow(
    "Missing release evidence"
  )
  expect(() => assertBotChildLifecycle(f.store(), a.request().run.id)).not.toThrow()
  f.reopen()
  expect(() => assertBotChildLifecycle(f.store(), f.parent.run.id)).toThrow(
    "Missing release evidence"
  )
  await expect(a.lifecycle().finish(false)).rejects.toThrow("Missing release evidence")
  expect(f.hooks.run).toHaveBeenCalledTimes(2)
})

it("cannot launch lifecycle operations after cancellation", async () => {
  const f = fixture(),
    a = f.child()
  f.controller.abort(new Error("Cancelled"))
  await expect(a.lifecycle().start()).rejects.toThrow("Cancelled")
  await expect(a.lifecycle().finish(true)).rejects.toThrow("Cancelled")
  expect(f.hooks.run).not.toHaveBeenCalled()
})

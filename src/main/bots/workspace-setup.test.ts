import { afterEach, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { BotStore } from "./store"
import { BotWorkspaceSetup } from "./workspace-setup"
import type { BotRuntimeRequest } from "./host"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn()
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cmb-workspace-setup-")),
    path = join(directory, "bots.sqlite")
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  let now = Date.now(),
    store = new BotStore(path, () => now)
  cleanup.push(() => store.close())
  let n = 0
  const task = () => {
    const owner = store.createBot({
      nonce: `owner-${n++}`,
      name: `Owner ${n}`,
      workspacePath: directory
    })
    store.send({ nonce: `task-${n}`, conversationId: owner.conversationId, text: "Use project" })
    const claim = store.claim("host")!,
      abort = new AbortController()
    const request = (): BotRuntimeRequest => ({
      ...claim,
      store,
      bot: owner.bot,
      signal: abort.signal,
      messages: []
    })
    const init = (configuration = "original", ino = "1") =>
      new BotWorkspaceSetup(
        request(),
        { root: directory, dev: "1", ino },
        configuration,
        async () => {
          abort.signal.throwIfAborted()
          store.assertDispatch(claim.lease)
        }
      )
    return { ...claim, request, init, abort, owner }
  }
  return {
    task,
    store: () => store,
    advance() {
      now += 60000
    },
    reopen() {
      store.close()
      store = new BotStore(path, () => now)
    }
  }
}

it("initializes a shared project once while releasing the waiting Bot's execution slot", async () => {
  const f = fixture(),
    a = f.task(),
    b = f.task()
  let release!: () => void
  const execute = vi.fn(async () => {
    await new Promise<void>((resolve) => (release = resolve))
    return null
  })
  const first = a.init().run(execute)
  await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce())
  const second = b.init().run(execute)
  await vi.waitFor(() => expect(f.store().getRun(b.run.id).status).toBe("waiting_input"))
  release()
  await Promise.all([first, second])
  expect(execute).toHaveBeenCalledOnce()
  expect(f.store().getRun(b.run.id).status).toBe("running")
  f.reopen()
  await b.init().run(execute)
  expect(execute).toHaveBeenCalledOnce()
})

it.each(["definition", "identity"] as const)(
  "rechecks initialization when project %s changes",
  async (change) => {
    const f = fixture(),
      a = f.task(),
      execute = vi.fn(async () => null)
    await a.init().run(execute)
    f.store().finish(a.lease, "succeeded", "Ready")
    const b = f.task()
    await b
      .init(change === "definition" ? "changed" : "original", change === "identity" ? "2" : "1")
      .run(execute)
    expect(execute).toHaveBeenCalledTimes(2)
  }
)

it("keeps a failed initialization incomplete and permits a later task to retry", async () => {
  const f = fixture(),
    a = f.task()
  await expect(
    a.init().run(async () => ({ exitCode: 1, stdout: "", stderr: "Setup failed", blocked: true }))
  ).rejects.toThrow("Setup failed")
  expect(f.store().db.exec("SELECT completed_at FROM bot_workspace_setup")[0].values).toEqual([
    [null]
  ])
  f.store().finish(a.lease, "failed", "Setup failed")
  const b = f.task(),
    execute = vi.fn(async () => null)
  await b.init().run(execute)
  expect(execute).toHaveBeenCalledOnce()
})

it("cancels a waiting task without cancelling or marking the owner's initialization complete", async () => {
  const f = fixture(),
    a = f.task(),
    b = f.task()
  let release!: () => void
  const first = a.init().run(async () => {
    await new Promise<void>((resolve) => (release = resolve))
    return null
  })
  await vi.waitFor(() => expect(release).toBeTypeOf("function"))
  const second = b.init().run(async () => {
    throw new Error("Must not run")
  })
  const rejected = expect(second).rejects.toMatchObject({ name: "AbortError" })
  await vi.waitFor(() => expect(f.store().getRun(b.run.id).status).toBe("waiting_input"))
  b.abort.abort(new Error("Wait cancelled"))
  await rejected
  expect(f.store().getRun(b.run.id).status).toBe("running")
  expect(f.store().db.exec("SELECT completed_at FROM bot_workspace_setup")[0].values).toEqual([
    [null]
  ])
  release()
  await first
})

it("does not resume initialization with a stale execution lease", async () => {
  const f = fixture(),
    a = f.task()
  let release!: () => void
  const promise = a.init().run(async () => {
    await new Promise<void>((resolve) => (release = resolve))
    return null
  })
  const rejected = expect(promise).rejects.toMatchObject({ code: "stale_lease" })
  await vi.waitFor(() => expect(release).toBeTypeOf("function"))
  f.advance()
  f.store().recoverExpired()
  release()
  await rejected
  expect(f.store().db.exec("SELECT completed_at FROM bot_workspace_setup")[0].values).toEqual([
    [null]
  ])
})

it("waits for human resolution of an interrupted initialization instead of executing another copy", async () => {
  const f = fixture(),
    a = f.task()
  await expect(
    a.init().run(async () => {
      const action = { hook: { command: "initialize" } }
      const approval = f
        .store()
        .requestInteraction(a.lease, { kind: "approval", action, prompt: JSON.stringify(action) })
      f.store().answerInteraction({
        id: approval.id,
        revision: approval.revision,
        answer: "approve"
      })
      f.store().beginEffect(a.lease, { id: "setup-effect", action, approvalId: approval.id })
      throw new Error("Host lost")
    })
  ).rejects.toThrow("Host lost")
  f.advance()
  f.store().recoverExpired()
  f.reopen()
  const b = f.task(),
    execute = vi.fn(async () => null),
    pending = b.init().run(execute)
  await vi.waitFor(() => expect(f.store().getRun(b.run.id).status).toBe("waiting_input"))
  await delay(300)
  expect(execute).not.toHaveBeenCalled()
  const interrupted = f.store().getRun(a.run.id)
  f.store().recover({
    id: interrupted.id,
    revision: interrupted.revision,
    decision: "cancel",
    note: "Verified interrupted setup",
    effects: [{ id: "setup-effect", outcome: "failed", note: "No effect completed" }]
  })
  await pending
  expect(execute).toHaveBeenCalledOnce()
})

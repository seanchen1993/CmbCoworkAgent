import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { ModsManager } from "../manager"
import { queryFunctionSessionRead } from "./session-read-host"
import { AIMessage, HumanMessage } from "@langchain/core/messages"
import type { FunctionSessionReadMethod } from "../../../shared/mods/v2/session"

const read = vi.hoisted(() => vi.fn())
vi.mock("./session-repo", () => ({ readFunctionSessionRepo: read }))
const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
  vi.clearAllMocks()
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mods-session-read-"))
  const realm = join(root, "realm")
  const execution = join(root, "execution")
  mkdirSync(realm)
  mkdirSync(execution)
  const manager = new ModsManager(
    join(root, "control.sqlite"),
    () => [],
    async () => true,
    () => {}
  )
  manager.configure(realm, true, false)
  cleanup.push(() => {
    manager.close()
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("mods-session-read-")
    )
      throw Error("Unexpected cleanup target")
    rmSync(root, { recursive: true, force: true })
  })
  read.mockResolvedValue(null)
  const controller = new AbortController()
  const plain = vi.fn()
  const workspace = vi.fn()
  return {
    manager,
    realm,
    execution,
    controller,
    plain,
    workspace,
    query: () =>
      queryFunctionSessionRead(
        manager,
        plain,
        workspace,
        realm,
        "thread",
        "session.repo",
        controller.signal
      )
  }
}

it("uses the actual execution directory and preserves the original grant realm", async () => {
  const f = fixture()
  const release = f.manager.bindThread({
    workspace: f.realm,
    executionWorkspace: f.execution,
    threadId: "thread",
    turnId: "turn"
  })
  cleanup.push(release)
  expect(await f.query()).toBeNull()
  expect(read.mock.calls[0][0]).toBe(f.manager.workspaceKey(f.execution))
  expect(f.plain).not.toHaveBeenCalled()
  expect(f.manager.store.audit(f.manager.workspaceKey(f.realm))).toEqual([])
})

it("requires an ordinary cold thread and rejects a different workspace before reading", async () => {
  const f = fixture()
  await f.query()
  expect(f.plain).toHaveBeenCalledWith("thread")
  read.mockClear()
  f.plain.mockImplementation(() => {
    throw Error("not foreground")
  })
  await expect(f.query()).rejects.toThrow("not foreground")
  expect(read).not.toHaveBeenCalled()
  f.workspace.mockImplementation(() => {
    throw Error("workspace changed")
  })
  await expect(f.query()).rejects.toThrow("workspace changed")
  expect(read).not.toHaveBeenCalled()
})

it("rejects a metadata response after replacing the runtime binding or cancelling the query", async () => {
  const f = fixture()
  let resolveRead!: (value: null) => void
  read.mockImplementation(
    () =>
      new Promise<null>((resolve) => {
        resolveRead = resolve
      })
  )
  const pending = f.query()
  const rejected = expect(pending).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
  cleanup.push(f.manager.bindThread({ workspace: f.realm, threadId: "thread", turnId: "new" }))
  resolveRead(null)
  await rejected
  const cancelled = f.query()
  const cancelledResult = expect(cancelled).rejects.toThrow("cancelled")
  f.controller.abort(Error("cancelled"))
  resolveRead(null)
  await cancelledResult
})

it("reads the actual main model and messages inside a shared child without opening a checkpoint", async () => {
  const f = fixture()
  const binding = { workspace: f.manager.workspaceKey(f.realm), threadId: "thread", turnId: "turn" }
  const instance = f.manager.createRuntimeAuthority(binding)
  cleanup.push(instance.release)
  cleanup.push(f.manager.bindThread({ ...binding, runtimeAuthority: instance.authority }))
  f.manager.bindFunctionSession(instance.authority, "actual-main-model", 1000)
  f.manager.updateFunctionSessionMessages(instance.authority, [new HumanMessage("actual prompt")])
  const cold = vi.fn()
  const query = (method: FunctionSessionReadMethod) =>
    queryFunctionSessionRead(
      f.manager,
      f.plain,
      f.workspace,
      f.realm,
      "thread",
      method,
      f.controller.signal,
      cold
    )
  expect(await query("session.model")).toBe("actual-main-model")
  expect(await query("session.turns")).toBe(1)
  expect(await query("session.usage")).toEqual({ context: { window: 1000 }, rateLimits: [] })
  await f.manager.withSharedAgent(
    instance.authority,
    "child",
    f.controller.signal,
    { blockedToolNames: new Set(), readOnly: true },
    async () => {
      expect(await query("session.model")).toBe("actual-main-model")
      expect(await query("session.messages")).toEqual([
        { role: "user", text: "actual prompt", toolUses: [] }
      ])
    }
  )
  expect(cold).not.toHaveBeenCalled()
  expect(f.manager.store.audit(binding.workspace)).toEqual([])
  f.manager.updateFunctionSessionMessages(instance.authority, [
    new AIMessage({
      content: "actual",
      usage_metadata: { input_tokens: 250, output_tokens: 10, total_tokens: 260 }
    })
  ])
  expect(await query("session.usage")).toEqual({
    context: { window: 1000, tokens: 250, percent: 25 },
    rateLimits: []
  })
  f.manager.updateFunctionSessionMessages(instance.authority, [], {
    _summarizationEvent: { usageStartIndex: 1 }
  })
  expect(await query("session.usage")).toEqual({ context: { window: 1000 }, rateLimits: [] })
})

it("invalidates a pending cold read on close and on a new runtime even when the adapter is still absent", async () => {
  for (const action of ["close", "replace"] as const) {
    const f = fixture()
    let finish!: (value: { value: number; assertLive(): void }) => void
    const cold = vi.fn(
      () =>
        new Promise<{ value: number; assertLive(): void }>((resolve) => {
          finish = resolve
        })
    )
    const query = queryFunctionSessionRead(
      f.manager,
      f.plain,
      f.workspace,
      f.realm,
      "thread",
      "session.turns",
      f.controller.signal,
      cold
    )
    const rejected = expect(query).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
    if (action === "close") f.manager.closeFunctionThread("thread")
    else
      cleanup.push(
        f.manager.createRuntimeAuthority({ workspace: f.realm, threadId: "thread", turnId: "new" })
          .release
      )
    finish({ value: 0, assertLive: () => undefined })
    await rejected
  }
})

it("releases successful cold reads and rejects a metadata replacement before publication", async () => {
  const f = fixture()
  const current = vi.fn()
  const cold = vi.fn(async () => ({ value: 2, assertLive: current }))
  for (let index = 0; index < 105; index++)
    expect(
      await queryFunctionSessionRead(
        f.manager,
        f.plain,
        f.workspace,
        f.realm,
        "thread",
        "session.turns",
        f.controller.signal,
        cold
      )
    ).toBe(2)
  current.mockImplementation(() => {
    throw Error("metadata changed")
  })
  await expect(
    queryFunctionSessionRead(
      f.manager,
      f.plain,
      f.workspace,
      f.realm,
      "thread",
      "session.turns",
      f.controller.signal,
      cold
    )
  ).rejects.toThrow("metadata changed")
})

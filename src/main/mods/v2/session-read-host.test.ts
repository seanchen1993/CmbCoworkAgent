import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { ModsManager } from "../manager"
import { compactFunctionSession, queryFunctionSessionRead } from "./session-read-host"
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages"
import type { FunctionSessionReadMethod } from "../../../shared/mods/v2/session"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"

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
  const query = (method: FunctionSessionReadMethod, usageArgs = {}) =>
    queryFunctionSessionRead(
      f.manager,
      f.plain,
      f.workspace,
      f.realm,
      "thread",
      method,
      f.controller.signal,
      cold,
      usageArgs
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
  f.manager.updateFunctionSessionRequest(instance.authority, {
    systemMessage: new SystemMessage("system"),
    tools: [{ name: "inspect", description: "Inspect", input_schema: {} }]
  })
  const breakdown = (await query("session.usage", { breakdown: "full", columns: 60 })) as {
    context: {
      breakdown?: { model: string; apiUsage: unknown; categories: unknown[]; totalTokens: number }
    }
  }
  expect(breakdown.context.breakdown).toMatchObject({
    model: "actual-main-model",
    apiUsage: {
      input_tokens: 250,
      output_tokens: 10
    }
  })
  expect(breakdown.context.breakdown?.categories).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "System prompt" }),
      expect.objectContaining({ name: "System tools" }),
      expect.objectContaining({ name: "Messages" })
    ])
  )
  const summary = (await query("session.usage", { breakdown: "summary", columns: 60 })) as {
    context: { breakdown?: { totalTokens: number } }
  }
  expect(summary.context.breakdown?.totalTokens).not.toBe(breakdown.context.breakdown?.totalTokens)
  f.manager.updateFunctionSessionMessages(instance.authority, [], {
    _summarizationEvent: { usageStartIndex: 1 }
  })
  expect(await query("session.usage")).toEqual({ context: { window: 1000 }, rateLimits: [] })
})

it("rejects non-positive or non-integral breakdown columns at the host boundary", async () => {
  const f = fixture()
  await expect(
    queryFunctionSessionRead(
      f.manager,
      f.plain,
      f.workspace,
      f.realm,
      "thread",
      "session.usage",
      f.controller.signal,
      undefined,
      { breakdown: "summary", columns: 0 }
    )
  ).rejects.toThrow("MODS_SESSION_USAGE_ARGUMENT")
})

it("compacts the live main session through its bound controller", async () => {
  const f = fixture()
  const binding = { workspace: f.manager.workspaceKey(f.realm), threadId: "thread", turnId: "turn" }
  const instance = f.manager.createRuntimeAuthority(binding)
  cleanup.push(instance.release)
  cleanup.push(f.manager.bindThread({ ...binding, runtimeAuthority: instance.authority }))
  const compact = vi.fn(async (instructions: string, messages: readonly unknown[]) => ({
    messages: messages.length,
    tokensBefore: instructions.length,
    tokensAfter: 20
  }))
  f.manager.bindFunctionSession(instance.authority, "model", 1000, compact)
  f.manager.updateFunctionSessionMessages(instance.authority, [new HumanMessage("prompt")])
  await expect(
    compactFunctionSession(
      f.manager,
      f.plain,
      f.workspace,
      f.realm,
      "thread",
      "Keep the user goal.",
      f.controller.signal
    )
  ).resolves.toEqual({ messages: 1, tokensBefore: "Keep the user goal.".length, tokensAfter: 20 })
  expect(compact).toHaveBeenCalledWith(
    "Keep the user goal.",
    expect.arrayContaining([expect.any(HumanMessage)]),
    {},
    expect.any(AbortSignal)
  )
})

it("rejects compact while the thread run lease is occupied", async () => {
  const f = fixture()
  const binding = { workspace: f.manager.workspaceKey(f.realm), threadId: "thread", turnId: "turn" }
  const instance = f.manager.createRuntimeAuthority(binding)
  cleanup.push(instance.release)
  cleanup.push(f.manager.bindThread({ ...binding, runtimeAuthority: instance.authority }))
  f.manager.bindFunctionSession(instance.authority, "model", 1000, async () => ({
    messages: [{ role: "user", text: "summary", toolUses: [] }]
  }))
  f.manager.updateFunctionSessionMessages(instance.authority, [new HumanMessage("prompt")])
  const lease = claimLocalThreadRunLease({ threadId: "thread", owner: "desktop", runId: "run" })
  expect(lease.acquired).toBe(true)
  try {
    await expect(
      compactFunctionSession(
        f.manager,
        f.plain,
        f.workspace,
        f.realm,
        "thread",
        "",
        f.controller.signal
      )
    ).rejects.toThrow("MODS_CONTEXT_COMPACTION_ACTIVE")
  } finally {
    releaseLocalThreadRunLease("thread", "desktop", "run")
  }
})

it("does not publish a compact result after the live authority is revoked", async () => {
  const f = fixture()
  const binding = { workspace: f.manager.workspaceKey(f.realm), threadId: "thread", turnId: "turn" }
  const instance = f.manager.createRuntimeAuthority(binding)
  cleanup.push(instance.release)
  cleanup.push(f.manager.bindThread({ ...binding, runtimeAuthority: instance.authority }))
  let finish!: () => void
  f.manager.bindFunctionSession(instance.authority, "model", 1000, async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return { messages: [{ role: "user", text: "summary", toolUses: [] }] }
  })
  f.manager.updateFunctionSessionMessages(instance.authority, [new HumanMessage("prompt")])
  const pending = compactFunctionSession(
    f.manager,
    f.plain,
    f.workspace,
    f.realm,
    "thread",
    "Keep it.",
    f.controller.signal
  )
  const rejected = expect(pending).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
  f.manager.closeFunctionThread("thread")
  finish()
  await rejected
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

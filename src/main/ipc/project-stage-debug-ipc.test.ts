import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { beforeEach, expect, it, vi } from "vitest"
import { registerProjectPreviewHandlers } from "./project-preview"
import type { ProjectStageDebugSessions } from "../mods/devtools/project-stage-debug"
import type { HostProjectService } from "../harness-board/project-runtime/host-service"

const state = vi.hoisted(() => ({
  trusted: true,
  incarnation: "original",
  enabled: true
}))
vi.mock("../mods/devtools/development-service", () => ({
  getModDevelopmentService: () => ({
    projectAuthoringContext(threadId: string) {
      if (!state.enabled || threadId !== "creator") throw Error("DEVELOPMENT_SCOPE_CHANGED")
      const incarnation = state.incarnation
      return {
        scope: {
          threadId,
          workspace: "native-owner-workspace",
          incarnation: { token: incarnation, legacyCreatedAt: 1 }
        },
        assertCurrent: () => {
          if (!state.enabled || state.incarnation !== incarnation)
            throw Error("DEVELOPMENT_SCOPE_CHANGED")
        }
      }
    }
  })
}))

beforeEach(() => {
  state.trusted = state.enabled = true
  state.incarnation = "original"
})
function fixture() {
  const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>()
  const backend = {
    list: vi.fn(() => ({ snapshots: [], branches: [], diagnostics: [] })),
    compare: vi.fn(async () => ({})),
    prepare: vi.fn(async () => ({})),
    create: vi.fn(async () => ({})),
    reconcileHooks: vi.fn(async () => ({ remaining: 0, diagnostics: [] }))
  }
  const resolve = vi.fn(() => backend as unknown as ProjectStageDebugSessions)
  registerProjectPreviewHandlers(
    {
      handle: (channel, callback) => {
        handlers.set(channel, callback)
      }
    } as IpcMain,
    () => {
      if (!state.trusted) throw Error("UNTRUSTED_NATIVE_CALL")
    },
    () => ({}) as HostProjectService,
    () => "native-retained-package",
    resolve
  )
  const invoke = (kind: string, input: unknown) =>
    Promise.resolve().then(() =>
      handlers.get(`project-preview:stage-debug-${kind}`)!({} as IpcMainInvokeEvent, input)
    )
  return { invoke, backend, resolve }
}
const prepareInput = {
  threadId: "creator",
  snapshotId: "a".repeat(64),
  draftId: "docs",
  revision: 2,
  expectedDigest: "b".repeat(64),
  mode: "stage"
}

it("checks the native caller before initializing or accessing the debug service", async () => {
  const f = fixture()
  state.trusted = false
  for (const [kind, input] of [
    ["list", "creator"],
    ["prepare", prepareInput],
    ["create", {}],
    ["reconcile-hooks", {}],
    ["compare", { threadId: "creator", projectId: "11111111-1111-4111-8111-111111111111" }]
  ])
    await expect(f.invoke(String(kind), input)).rejects.toThrow("UNTRUSTED_NATIVE_CALL")
  expect(f.resolve).not.toHaveBeenCalled()
})

it("passes only exact native recovery consent and leaves outcome inspection read-only", async () => {
  const f = fixture()
  const base = { threadId: "creator", preparationId: "11111111-1111-4111-8111-111111111111",
    expectedDigest: "b".repeat(64) }
  const approved = { ...base, recoveryApproval: {
    policyDigest: "a".repeat(64), allowNetworkSideEffects: true
  } }
  await f.invoke("create", approved)
  expect(f.backend.create).toHaveBeenCalledWith(expect.objectContaining({ guard: expect.any(Function) }), approved)
  await expect(f.invoke("create", { ...base, recoveryApproval: {
    policyDigest: "a".repeat(64), allowNetworkSideEffects: false
  } })).rejects.toThrow()
  await expect(f.invoke("create", { ...approved, recoveryApproval: {
    ...approved.recoveryApproval, secret: "private"
  } })).rejects.toThrow()
  const inspect = { threadId: "creator", projectId: base.preparationId }
  await f.invoke("reconcile-hooks", inspect)
  expect(f.backend.reconcileHooks).toHaveBeenCalledWith(expect.objectContaining({ guard: expect.any(Function) }), inspect)
  await expect(f.invoke("reconcile-hooks", { ...inspect, outcome: "completed" })).rejects.toThrow()
  await expect(f.invoke("reconcile-hooks", { ...inspect, threadId: "other" })).rejects.toThrow("SCOPE_CHANGED")
  expect(f.backend.reconcileHooks).toHaveBeenCalledTimes(1)
})

it("derives creator scope natively and refuses forged authority or workspace fields", async () => {
  const f = fixture()
  await f.invoke("list", "creator")
  expect(f.backend.list).toHaveBeenCalledWith({
    scope: {
      threadId: "creator",
      workspace: "native-owner-workspace",
      incarnation: { token: "original", legacyCreatedAt: 1 }
    },
    guard: expect.any(Function)
  })
  for (const additional of [{ approved: true }, { workspace: "outside" }, { stageIndex: 9 }])
    await expect(f.invoke("prepare", { ...prepareInput, ...additional })).rejects.toThrow()
  await expect(
    f.invoke("create", {
      threadId: "creator",
      preparationId: "11111111-1111-4111-8111-111111111111",
      expectedDigest: "b".repeat(64),
      approved: true
    })
  ).rejects.toThrow()
  expect(f.backend.prepare).not.toHaveBeenCalled()
  expect(f.backend.create).not.toHaveBeenCalled()
  await expect(f.invoke("prepare", { ...prepareInput, threadId: "other" })).rejects.toThrow(
    "DEVELOPMENT_SCOPE_CHANGED"
  )
})

it("keeps the original creator guard effective across asynchronous native preparation", async () => {
  const f = fixture()
  f.backend.prepare.mockImplementation(async (...args: unknown[]) => {
    const context = args[0] as { guard(): void }
    context.guard()
    await Promise.resolve()
    state.incarnation = "recreated"
    context.guard()
    return {}
  })
  await expect(f.invoke("prepare", prepareInput)).rejects.toThrow("DEVELOPMENT_SCOPE_CHANGED")
  expect(f.backend.create).not.toHaveBeenCalled()
})

it("keeps hash comparison native scoped, strict and revocable without preparing or creating a branch", async () => {
  const f = fixture()
  const input = { threadId: "creator", projectId: "11111111-1111-4111-8111-111111111111" }
  await f.invoke("compare", input)
  expect(f.backend.compare).toHaveBeenCalledWith({ scope: {
    threadId: "creator", workspace: "native-owner-workspace",
    incarnation: { token: "original", legacyCreatedAt: 1 }
  }, guard: expect.any(Function) }, input)
  for (const forged of [{ workspace: "outside" }, { root: "outside" }, { approved: true }, { includeContents: true }])
    await expect(f.invoke("compare", { ...input, ...forged })).rejects.toThrow()
  await expect(f.invoke("compare", { ...input, threadId: "other" })).rejects.toThrow("DEVELOPMENT_SCOPE_CHANGED")
  f.backend.compare.mockImplementation(async (...args: unknown[]) => {
    const context = args[0] as { guard(): void }
    await Promise.resolve()
    state.incarnation = "recreated"
    context.guard()
    return {}
  })
  await expect(f.invoke("compare", input)).rejects.toThrow("DEVELOPMENT_SCOPE_CHANGED")
  expect(f.backend.prepare).not.toHaveBeenCalled()
  expect(f.backend.create).not.toHaveBeenCalled()
})

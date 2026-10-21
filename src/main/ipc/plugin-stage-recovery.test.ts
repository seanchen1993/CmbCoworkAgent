import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { expect, it, vi } from "vitest"
import { registerPluginStageRecoveryHandlers } from "./plugin-stage-recovery"
import type { PluginStageRecoverySessions } from "../mods/devtools/plugin-stage-recovery"

const trialId = "creator-business-trial:11111111-1111-4111-8111-111111111111"
const base = { threadId: "creator", expectedWorkspace: "C:\\Workspace", trialId }
const operation = {
  threadId: base.threadId,
  expectedWorkspace: base.expectedWorkspace,
  preparationId: "22222222-2222-4222-8222-222222222222",
  expectedDigest: "a".repeat(64)
}
const preparation = {
  ...base,
  stageId: "draft",
  stateMode: "target_in_progress",
  expectedPackageDigest: "a".repeat(64),
  expectedAdapterDigest: "b".repeat(64),
  expectedInputsDigest: "c".repeat(64),
  allowNetworkSideEffects: true
}

function fixture() {
  const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>()
  const state = { trusted: true, alive: true, incarnation: "original", frame: {} }
  const backend = Object.fromEntries(
    ["inspect", "latest", "prepare", "apply", "reconcile"].map((name) => [
      name,
      vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({}))
    ])
  ) as Record<
    "inspect" | "latest" | "prepare" | "apply" | "reconcile",
    ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>
  >
  const nativeScope = {
    threadId: "creator",
    workspace: "c:/workspace",
    incarnation: { token: "original", legacyCreatedAt: 1 }
  }
  const sender = {
    get mainFrame() {
      return state.frame
    },
    isDestroyed: () => !state.alive
  }
  const event = { sender } as unknown as IpcMainInvokeEvent
  const trusted = vi.fn(() => {
    if (!state.trusted) throw Error("UNTRUSTED_CALLER")
  })
  const context = vi.fn((threadId: string) => {
    if (threadId !== "creator") throw Error("NATIVE_CONTEXT_CHANGED")
    const incarnation = state.incarnation
    return {
      scope: nativeScope,
      assertCurrent() {
        if (state.incarnation !== incarnation) throw Error("NATIVE_CONTEXT_CHANGED")
      }
    }
  })
  registerPluginStageRecoveryHandlers(
    {
      handle: (channel: string, handler: Parameters<IpcMain["handle"]>[1]) => {
        handlers.set(channel, handler)
      }
    } as unknown as IpcMain,
    backend as unknown as PluginStageRecoverySessions,
    { trusted, normalizeWorkspace: (value) => value.replaceAll("\\", "/").toLowerCase(), context }
  )
  const invoke = (action: string, input: unknown) =>
    Promise.resolve().then(() =>
      handlers.get(`mods:development:plugin-stage-recovery:${action}`)!(event, input)
    )
  return { backend, state, invoke, context, nativeScope, trusted }
}

it("checks the native caller before parsing, resolving context or accessing any recovery backend", async () => {
  const f = fixture()
  f.state.trusted = false
  for (const action of ["inspect", "latest", "prepare", "apply", "reconcile"])
    await expect(f.invoke(action, {})).rejects.toThrow("UNTRUSTED_CALLER")
  expect(f.context).not.toHaveBeenCalled()
  for (const method of Object.values(f.backend)) expect(method).not.toHaveBeenCalled()
})

it("derives scope in Main and passes a live native guard without accepting forged paths or authority", async () => {
  const f = fixture()
  await f.invoke("inspect", base)
  expect(f.backend.inspect).toHaveBeenCalledWith(f.nativeScope, trialId, expect.any(Function))
  for (const forged of [
    { scope: f.nativeScope },
    { workspace: "outside" },
    { incarnation: f.nativeScope.incarnation },
    { guard: "approved" },
    { approved: true }
  ])
    await expect(f.invoke("prepare", { ...preparation, ...forged })).rejects.toThrow(
      "INVALID_INPUT"
    )
  await expect(
    f.invoke("prepare", { ...preparation, expectedWorkspace: "C:/elsewhere" })
  ).rejects.toThrow("SCOPE_CHANGED")
  await expect(f.invoke("prepare", { ...preparation, threadId: "foreign" })).rejects.toThrow(
    "CONTEXT_CHANGED"
  )
  expect(f.backend.prepare).not.toHaveBeenCalled()
  await f.invoke("prepare", preparation)
  expect(f.backend.prepare).toHaveBeenCalledWith(
    {
      scope: f.nativeScope,
      trialId: preparation.trialId,
      stageId: preparation.stageId,
      stateMode: preparation.stateMode,
      expectedPackageDigest: preparation.expectedPackageDigest,
      expectedAdapterDigest: preparation.expectedAdapterDigest,
      expectedInputsDigest: preparation.expectedInputsDigest,
      allowNetworkSideEffects: true
    },
    expect.any(Function)
  )
})

it("never infers network consent or replaces an old source digest with the current one", async () => {
  const f = fixture()
  for (const invalid of [undefined, false, "true", 1]) {
    await expect(
      f.invoke("prepare", { ...preparation, allowNetworkSideEffects: invalid })
    ).rejects.toThrow("INVALID_INPUT")
    await expect(
      f.invoke("apply", { ...operation, allowNetworkSideEffects: invalid })
    ).rejects.toThrow("INVALID_INPUT")
  }
  for (const field of ["expectedPackageDigest", "expectedAdapterDigest", "expectedInputsDigest"])
    await expect(f.invoke("prepare", { ...preparation, [field]: "old-invalid" })).rejects.toThrow(
      "INVALID_INPUT"
    )
  f.backend.prepare.mockRejectedValueOnce(Error("FRESH_APPROVAL_REQUIRED"))
  await expect(f.invoke("prepare", preparation)).rejects.toThrow("FRESH_APPROVAL_REQUIRED")
  expect(f.backend.prepare).toHaveBeenLastCalledWith(
    expect.objectContaining({
      expectedPackageDigest: preparation.expectedPackageDigest,
      expectedAdapterDigest: preparation.expectedAdapterDigest,
      expectedInputsDigest: preparation.expectedInputsDigest
    }),
    expect.any(Function)
  )
  await f.invoke("reconcile", operation)
  expect(f.backend.reconcile).toHaveBeenLastCalledWith(
    {
      scope: f.nativeScope,
      preparationId: operation.preparationId,
      expectedDigest: operation.expectedDigest
    },
    expect.any(Function)
  )
  await expect(
    f.invoke("reconcile", { ...operation, allowNetworkSideEffects: false })
  ).rejects.toThrow("INVALID_INPUT")
  expect(f.backend.apply).not.toHaveBeenCalled()
})

it.each(["frame", "destroyed", "context", "trust"])(
  "keeps %s revocation effective inside the native operation before further effects",
  async (changed) => {
    const f = fixture(),
      effects = vi.fn()
    f.backend.apply.mockImplementation(async (_input, guard) => {
      expect(guard).toEqual(expect.any(Function))
      await Promise.resolve()
      if (changed === "frame") f.state.frame = {}
      if (changed === "destroyed") f.state.alive = false
      if (changed === "context") f.state.incarnation = "recreated"
      if (changed === "trust") f.state.trusted = false
      const assertCurrent = guard as () => void
      assertCurrent()
      effects()
      return {}
    })
    await expect(
      f.invoke("apply", { ...operation, allowNetworkSideEffects: true })
    ).rejects.toThrow(
      changed === "context"
        ? "CONTEXT_CHANGED"
        : changed === "trust"
          ? "UNTRUSTED_CALLER"
          : "WINDOW_CHANGED"
    )
    expect(effects).not.toHaveBeenCalled()
  }
)

it("rechecks the frame before publishing any asynchronous result", async () => {
  const f = fixture()
  f.backend.latest.mockImplementation(async () => {
    f.state.frame = {}
    return { phase: "adopted" }
  })
  await expect(f.invoke("latest", base)).rejects.toThrow("WINDOW_CHANGED")
})

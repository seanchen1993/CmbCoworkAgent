import { expect, it, vi } from "vitest"
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron"
import type { CreatorBusinessService } from "../mods/devtools/creator-business"
import type { ModDevelopmentService } from "../mods/devtools/development-service"
import { registerCreatorBusinessTrialHandlers } from "./creator-business-trial"

const boundary = vi.hoisted(() => ({ source: vi.fn() }))
vi.mock("./native-project-source", () => ({
  registerNativeProjectSourceHandlers: (_ipc: unknown, _prefix: string, resolve: unknown) =>
    boundary.source(resolve)
}))
function fixture() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
  let frame = {}
  const event = {
    sender: {
      get mainFrame() {
        return frame
      },
      isDestroyed: () => false
    }
  } as IpcMainInvokeEvent
  const trials = {
    prepare: vi.fn(),
    refresh: vi.fn(),
    context: vi.fn(),
    selectContext: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    gates: vi.fn(),
    decideGate: vi.fn(),
    feedback: vi.fn(),
    source: vi.fn()
  }
  const business = { requestTrial: vi.fn(), trialService: () => trials }
  const development = { status: vi.fn(() => ({ mode: "creator" })) }
  const owner = { isDestroyed: () => false } as BrowserWindow
  registerCreatorBusinessTrialHandlers(
    {
      handle: (channel: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown) =>
        handlers.set(channel, handler)
    } as unknown as IpcMain,
    business as unknown as CreatorBusinessService,
    development as unknown as ModDevelopmentService,
    (incoming) => {
      if (incoming !== event) throw Error("UNTRUSTED")
    },
    () => owner
  )
  return {
    trials,
    business,
    development,
    event,
    owner,
    replaceFrame: () => {
      frame = {}
    },
    run: (action: string, input: unknown, incoming = event) =>
      handlers.get(`mods:development:business-trial:${action}`)!(incoming, input)
  }
}
const scope = {
  threadId: "creator",
  expectedWorkspace: "workspace",
  trialId: "creator-business-trial:11111111-1111-4111-8111-111111111111",
  digest: "a".repeat(64),
  expectedVersion: 3
}

it("keeps preparation, consent, start and human decisions independent native actions", async () => {
  const f = fixture()
  await f.run("prepare", scope)
  expect(f.trials.prepare).toHaveBeenCalledWith(scope)
  expect(f.trials.start).not.toHaveBeenCalled()
  await f.run("start", scope)
  expect(f.trials.start).toHaveBeenCalledWith(scope, f.owner)
  const decision = { ...scope, notificationId: "real-gate", action: "reject" }
  await f.run("decide-gate", decision)
  expect(f.trials.decideGate).toHaveBeenCalledWith(decision, f.owner)
  expect(f.development.status).toHaveBeenCalledWith(scope.threadId)
})

it("rejects forged paths, sources, grants, outcomes, malformed versions and untrusted senders", () => {
  const f = fixture()
  for (const extra of [
    { sourceRoot: "C:/elsewhere" },
    { projectId: "other" },
    { approved: true },
    { result: "passed" },
    { pluginId: "installed" },
    { expectedVersion: 0 }
  ])
    expect(() => f.run("start", { ...scope, ...extra })).toThrow("INVALID_INPUT")
  expect(() => f.run("prepare", scope, {} as IpcMainInvokeEvent)).toThrow("UNTRUSTED")
  expect(f.trials.start).not.toHaveBeenCalled()
})

it("delegates opaque trial keys to the original native config/source handler with live sender checks", async () => {
  const f = fixture(),
    guard = vi.fn(),
    authorityGuard = vi.fn()
  f.trials.source.mockReturnValue({ guard, authorityGuard })
  const resolver = boundary.source.mock.lastCall![0] as (
    event: IpcMainInvokeEvent,
    id: string
  ) => { guard(): void; authorityGuard(): void }
  const source = resolver(f.event, scope.trialId)
  source.guard()
  expect(guard).toHaveBeenCalledOnce()
  expect(f.trials.source).toHaveBeenCalledWith(scope.trialId)
  f.replaceFrame()
  expect(source.authorityGuard).toThrow("WINDOW_CHANGED")
})

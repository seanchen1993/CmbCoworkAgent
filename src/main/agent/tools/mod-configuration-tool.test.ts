import { afterEach, expect, it, vi } from "vitest"
import { createModConfigurationTool } from "./mod-configuration-tool"
import { setModDevelopmentService, type ModDevelopmentService } from "../../mods/devtools/development-service"
import { setCreatorUserConfigService, type CreatorUserConfigService } from "../../mods/devtools/creator-user-config"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../thread-run-lease"
import { CreatorRequestBudgets } from "../../mods/devtools/creator-request-budget"

const threadId = "configuration-tool"
function fixture() {
  const ledger = new CreatorRequestBudgets()
  const mode = { isCreatorMode: vi.fn(() => true), captureCreatorMode: () => () => {},
    claimAuthoringBudget: (_thread: string, run: string, kind: "operation" | "candidate") =>
      ledger.claim("workspace", run, kind) }
  setModDevelopmentService(mode as unknown as ModDevelopmentService)
  const service = { inspect: vi.fn(async () => ({ fields: [] })),
    status: vi.fn(() => ({ key: "token" })), change: vi.fn(async () => ({ state: "pending" })) }
  setCreatorUserConfigService(service as unknown as CreatorUserConfigService)
  claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "run" })
  return { service, mode, native: createModConfigurationTool({ threadId, workspace: "workspace" }) }
}
afterEach(() => {
  setModDevelopmentService(undefined)
  setCreatorUserConfigService(undefined)
  releaseLocalThreadRunLease(threadId, "desktop", "run")
})

it("routes exact original config bindings while retaining native scope and request budget", async () => {
  const f = fixture()
  expect(JSON.parse(await f.native.invoke({ action: "inspect", pluginId: "p" })).ok).toBe(true)
  await f.native.invoke({ action: "request_input", pluginId: "p", digest: "a".repeat(64),
    revision: 2, key: "token" })
  expect(f.service.change).toHaveBeenCalledWith(threadId, "workspace",
    { pluginId: "p", digest: "a".repeat(64), revision: 2 }, "request_input", "token",
    undefined, expect.any(AbortSignal), expect.any(Function))
  for (let i = 0; i < 30; i++) await f.native.invoke({ action: "status" })
  expect(JSON.parse(await createModConfigurationTool({ threadId, workspace: "workspace" })
    .invoke({ action: "status" }))).toMatchObject({ ok: false, error: "DEVELOPMENT_TURN_BUDGET" })
})

it("rejects stale creator mode and forbids passing values to the native input request", async () => {
  const f = fixture()
  await expect(f.native.invoke({ action: "request_input", pluginId: "p", digest: "a".repeat(64),
    revision: 2, key: "token", value: "secret-must-not-be-an-input" })).rejects.toThrow()
  expect(f.service.change).not.toHaveBeenCalled()
  f.mode.isCreatorMode.mockReturnValue(false)
  expect(JSON.parse(await f.native.invoke({ action: "inspect", pluginId: "p" })))
    .toMatchObject({ ok: false, error: "DEVELOPMENT_TURN_CHANGED" })
  expect(f.service.inspect).not.toHaveBeenCalled()
})

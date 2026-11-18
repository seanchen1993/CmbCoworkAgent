import { afterEach, expect, it, vi } from "vitest"
import { createModAuthoringTool } from "./mod-authoring-tool"
import {
  setModDevelopmentService,
  type ModDevelopmentService
} from "../../mods/devtools/development-service"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../thread-run-lease"

const loadCompiler = vi.hoisted(() => vi.fn())
vi.mock("typescript", async (importOriginal) => {
  await loadCompiler()
  return importOriginal()
})
vi.mock("../../storage", () => ({ getPlugins: vi.fn(() => []) }))

const threadId = "authoring-tool-loading"
const workspace = "workspace"

afterEach(() => {
  releaseLocalThreadRunLease(threadId, "desktop", "first")
  setModDevelopmentService(undefined)
})

it("keeps the compiler off list and rechecks the turn after the first catalog import", async () => {
  setModDevelopmentService({
    isCreatorMode: () => true,
    status: () => ({ enabled: true })
  } as unknown as ModDevelopmentService)
  claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "first" })
  const author = createModAuthoringTool({ threadId, workspace })
  expect(JSON.parse(await author.invoke({ action: "list" }))).toMatchObject({ ok: true })
  expect(loadCompiler).not.toHaveBeenCalled()

  let finishLoading = () => {}
  const loading = new Promise<void>((resolve) => {
    finishLoading = resolve
  })
  const startedLoading = new Promise<void>((resolve) => {
    loadCompiler.mockImplementationOnce(() => {
      resolve()
      return loading
    })
  })
  const controller = new AbortController()
  const cancellable = createModAuthoringTool({ threadId, workspace, signal: controller.signal })
  const query = { action: "catalog", catalogSection: "events", query: "platform.action" } as const
  const initial = cancellable.invoke(query)
  await startedLoading
  controller.abort(Error("DEVELOPMENT_TURN_CHANGED"))
  finishLoading()
  expect(JSON.parse(await initial)).toMatchObject({ ok: false, error: "DEVELOPMENT_TURN_CHANGED" })

  const response = JSON.parse(await author.invoke(query))
  expect(response).toMatchObject({
    ok: true,
    result: { query: "platform.action", matched: true, declarationAvailable: true }
  })
  expect(response.result.content).toContain("capability(descriptor:PlatformDescriptor")
  expect(loadCompiler).toHaveBeenCalledTimes(1)
})

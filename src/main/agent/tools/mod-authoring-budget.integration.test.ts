import { resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { AuthoringDraftStore } from "../../mods/devtools/authoring-store"
import type { AuthoringAtomicSettings } from "../../mods/devtools/authoring-config-snapshot"
import {
  ModDevelopmentService,
  setModDevelopmentService,
  type DevelopmentRuntime
} from "../../mods/devtools/development-service"
import { createAuthoringTemplate } from "../../mods/devtools/authoring-templates"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../thread-run-lease"
import { createModAuthoringTool } from "./mod-authoring-tool"

const threadId = "creator-budget-service-integration"
const workspace = "workspace"
afterEach(() => {
  releaseLocalThreadRunLease(threadId, "desktop", "native-run")
  setModDevelopmentService(undefined)
  vi.restoreAllMocks()
})

function fixture() {
  const values = new Map<string, string>()
  const settings: AuthoringAtomicSettings = {
    getSetting: (key, fallback) => values.get(key) ?? fallback ?? "",
    compareAndSetSetting: (key, expected, value) => {
      if (values.get(key) !== expected) return false
      values.set(key, value)
      return true
    }
  }
  let goal: string | undefined = "goal:original"
  const runtime: DevelopmentRuntime = {
    developmentRetention: vi.fn(() => ({ releasable: true, revisions: [] })),
    stageDevelopment: vi.fn(),
    developmentStatus: vi.fn(() => []),
    approveDevelopment: vi.fn(),
    stopDevelopment: vi.fn()
  }
  const make = () =>
    new ModDevelopmentService({
      drafts: new AuthoringDraftStore(settings),
      runtime,
      historySettings: settings,
      requestGroup: () => goal,
      versionsRoot: resolve("output/test-budget-versions"),
      workerEntry: resolve("output/test-budget-worker.js"),
      changed: vi.fn(),
      context: () => ({
        scope: { workspace, threadId, incarnation: { token: "first", legacyCreatedAt: 1 } },
        assertCurrent: () => {}
      })
    })
  return {
    values,
    runtime,
    make,
    setGoal: (value: string | undefined) => {
      goal = value
    }
  }
}

it("bounds real authoring tools across reconstruction using the original service and host goal", async () => {
  const f = fixture()
  const service = f.make()
  await service.setEnabled(threadId, workspace, true)
  setModDevelopmentService(service)
  claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "native-run" })
  const request = vi.spyOn(service, "requestTrial").mockResolvedValue(service.status(threadId))
  const args = { action: "request_trial" as const, id: "demo", revision: 1 }
  for (let i = 0; i < 3; i++) {
    const result = await createModAuthoringTool({ threadId, workspace }).invoke(args)
    expect(JSON.parse(result).ok).toBe(true)
  }
  const exhausted = await createModAuthoringTool({ threadId, workspace }).invoke(args)
  expect(JSON.parse(exhausted)).toMatchObject({ ok: false, error: "DEVELOPMENT_REPAIR_BUDGET" })
  expect(request).toHaveBeenCalledTimes(3)
  const restored = f.make()
  await restored.setEnabled(threadId, workspace, true)
  expect(restored.status(threadId).request).toMatchObject({
    runId: "native-run",
    groupId: "goal:original",
    candidates: 3,
    operations: 4
  })
  expect(restored.status(threadId).request).not.toHaveProperty("nativeRuns")
  f.setGoal(undefined)
  expect(() => restored.claimAuthoringBudget(threadId, "native-run", "candidate")).toThrow(
    "DEVELOPMENT_REPAIR_BUDGET"
  )
  expect(f.runtime.approveDevelopment).not.toHaveBeenCalled()
  expect(f.runtime.stageDevelopment).not.toHaveBeenCalled()
})

it("keeps drafts readable when accounting is corrupt and never restores authoring admission", async () => {
  const f = fixture()
  const service = f.make()
  await service.setEnabled(threadId, workspace, true)
  const source = createAuthoringTemplate({
    id: "demo",
    name: "Demo",
    instruction: "Demo",
    kind: "command"
  })
  service.save(threadId, { id: "demo", name: "Demo", expectedRevision: 0, files: source.files })
  service.claimAuthoringBudget(threadId, "native-run", "operation")
  const key = [...f.values.keys()].find((key) => key.startsWith("creator-request-budget:"))!
  f.values.set(key, "corrupt")
  const restored = f.make()
  expect(restored.status(threadId)).toMatchObject({
    enabled: false,
    request: { error: "DEVELOPMENT_BUDGET_UNCONFIRMED" },
    drafts: [{ id: "demo", revision: 1 }]
  })
  expect(() => restored.claimAuthoringBudget(threadId, "native-run", "operation")).toThrow(
    "DEVELOPMENT_DISABLED"
  )
  await restored.setEnabled(threadId, workspace, true)
  expect(() => restored.claimAuthoringBudget(threadId, "native-run", "operation")).toThrow(
    "DEVELOPMENT_BUDGET_UNCONFIRMED"
  )
  expect(restored.read(threadId, "demo").currentRevision).toBe(1)
  expect(f.runtime.stageDevelopment).not.toHaveBeenCalled()
})

import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
vi.mock("../../harness-board/service", () => ({
  getHarnessProjectDetail: vi.fn(),
  listHarnessProjects: vi.fn(),
  requireHarnessFeatureWorkspace: vi.fn()
}))
vi.mock("../../storage", () => ({ getBuiltinRobotSettings: vi.fn() }))
vi.mock("../../feature-gates", () => ({ isFeatureGateEnabled: vi.fn() }))
vi.mock("./conversation-state", () => ({ imConversationStateStore: {} }))
import { ImFeatureBindingService, validateImFeatureTarget } from "./feature-binding-service"
import type { ImTargetSnapshot } from "./conversation-state"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "im-feature-workspace-"))
  roots.push(root)
  const original = join(root, "original")
  const next = join(root, "next")
  await mkdir(original)
  await mkdir(next)
  const getFeatureWorkspace = vi.fn(async () => next)
  const service = new ImFeatureBindingService({
    getFeatureWorkspace,
    getSettings: () => ({ enabled: true, remoteAccess: "inbox-and-features" }) as never,
    projectModeEnabled: async () => true,
    listProjects: async () =>
      [
        {
          projectId: "p",
          name: "P",
          lifecycle: { status: "active" },
          boardCompatibility: { compatible: true }
        }
      ] as never,
    getProjectDetail: async () =>
      ({
        project: { projectRootPath: root },
        runs: [{ slug: "f", title: "F", location: "active", featureStatus: "in_progress" }],
        error: null
      }) as never
  })
  const metadata = { workspacePath: original, harnessFeature: { projectId: "p", slug: "f" } }
  const target = {
    kind: "feature",
    projectId: "p",
    featureSlug: "f",
    workspacePath: original
  } as Extract<ImTargetSnapshot, { kind: "feature" }>
  return { original, next, getFeatureWorkspace, service, metadata, target }
}

describe("IM existing session and feature creation workspace boundaries", () => {
  it("uses the latest feature workspace for new sessions only", async () => {
    const f = await fixture()
    expect(await f.service.validateFeature("p", "f")).toMatchObject({
      valid: true,
      workspacePath: realpathSync(f.next)
    })
    f.getFeatureWorkspace.mockClear()
    expect(await validateImFeatureTarget(f.target, f.metadata, f.service)).toMatchObject({
      valid: true,
      workspacePath: realpathSync(f.original)
    })
    expect(f.getFeatureWorkspace).not.toHaveBeenCalled()
  })
  it("blocks new sessions with missing configuration without suspending existing sessions", async () => {
    const f = await fixture()
    f.getFeatureWorkspace.mockRejectedValue(new Error("请配置会话工作区"))
    expect(await f.service.validateFeature("p", "f")).toMatchObject({
      valid: false,
      message: "请配置会话工作区"
    })
    expect(await f.service.validateExistingFeatureThread(f.metadata, f.original)).toMatchObject({
      valid: true
    })
    expect(await validateImFeatureTarget(f.target, f.metadata, f.service)).toMatchObject({
      valid: true
    })
  })
  it("still rejects mismatched feature identity or actual session workspace", async () => {
    const f = await fixture()
    expect(
      await validateImFeatureTarget(
        f.target,
        { ...f.metadata, harnessFeature: { projectId: "other", slug: "f" } },
        f.service
      )
    ).toMatchObject({ valid: false, reasonCode: "REMOTE_THREAD_METADATA_MISMATCH" })
    expect(
      await validateImFeatureTarget(f.target, { ...f.metadata, workspacePath: f.next }, f.service)
    ).toMatchObject({ valid: false, reasonCode: "REMOTE_WORKSPACE_UNAVAILABLE" })
  })
})

import { describe, expect, it } from "vitest"
import { resolve } from "node:path"
import { resolveCapabilityContext } from "./capability-context"

const workspace = resolve("test-projects")
const projectRoot = resolve(workspace, "example")
const thread = (extra: Record<string, unknown> = {}) => ({
  metadata: { workspacePath: workspace, cmb_thread_incarnation: "one", ...extra }
})
const readers = (rows: Record<string, ReturnType<typeof thread>>) => ({
  thread: (id: string) => rows[id] ?? null,
  projectWorkspaces: (id: string) => (id === "project" ? [workspace, projectRoot] : undefined),
  hostProject: () => false
})

describe("host capability usage context", () => {
  it("requires the real isolated project and exact feature binding for hidden legacy sessions", () => {
    const projectId = "composition-legacy:run:unit"
    const rows = {
      t: thread({ isInternalFlowRuntime: true, harnessFeature: { projectId, slug: "feature" } })
    }
    const read = {
      ...readers(rows),
      projectWorkspaces: (id: string) => (id === projectId ? [workspace] : undefined),
      featureWorkspace: (id: string, feature: string) =>
        id === projectId && feature === "feature" ? workspace : undefined
    }
    expect(resolveCapabilityContext(workspace, "t", read)).toMatchObject({
      usage: "project",
      projectId
    })
    expect(() =>
      resolveCapabilityContext(workspace, "t", { ...read, projectWorkspaces: () => undefined })
    ).toThrow("CAPABILITY_PROJECT_UNAVAILABLE")
    expect(() =>
      resolveCapabilityContext(workspace, "t", { ...read, featureWorkspace: () => undefined })
    ).toThrow("CAPABILITY_PROJECT_UNAVAILABLE")
    rows.t = thread({
      isInternalFlowRuntime: true,
      harnessFeature: { projectId: "composition-legacy:forged:unit", slug: "feature" }
    })
    expect(() => resolveCapabilityContext(workspace, "t", read)).toThrow(
      "CAPABILITY_PROJECT_UNAVAILABLE"
    )
    rows.t = thread({
      isInternalFlowRuntime: true,
      harnessFeature: { projectId: "project", slug: "feature" }
    })
    expect(() => resolveCapabilityContext(workspace, "t", read)).toThrow(
      "CAPABILITY_CONTEXT_INVALID"
    )
  })
  it("accepts only the host-bound feature workspace outside the main project directory", () => {
    const featureRoot = resolve("feature-worktree")
    const rows = {
      t: {
        metadata: {
          workspacePath: featureRoot,
          cmb_thread_incarnation: "one",
          harnessFeature: { projectId: "project", slug: "feature" }
        }
      }
    }
    const read = {
      ...readers(rows),
      featureWorkspace: (projectId: string, featureId: string) =>
        projectId === "project" && featureId === "feature" ? featureRoot : undefined
    }
    expect(resolveCapabilityContext(featureRoot, "t", read).usage).toBe("project")
    expect(() =>
      resolveCapabilityContext(featureRoot, "t", { ...read, featureWorkspace: () => undefined })
    ).toThrow("CAPABILITY_PROJECT_UNAVAILABLE")
    expect(() =>
      resolveCapabilityContext(featureRoot, "t", { ...read, projectWorkspaces: () => undefined })
    ).toThrow("CAPABILITY_PROJECT_UNAVAILABLE")
  })
  it("distinguishes chat and project conversations in the same workspace", () => {
    const read = readers({
      chat: thread(),
      project: thread({ harnessProjectSession: { projectId: "project", kind: "chat" } })
    })
    expect(resolveCapabilityContext(workspace, "chat", read).usage).toBe("chat")
    expect(resolveCapabilityContext(workspace, "project", read).usage).toBe("project")
  })
  it("requires a real project, coherent attribution, and an owned workspace", () => {
    for (const extra of [
      { harnessProjectId: "project" },
      { harnessProjectSession: { projectId: "missing", kind: "chat" } },
      { harnessProjectSession: { projectId: "project", kind: "chat" }, harnessProjectId: "other" },
      { harnessFeature: { projectId: "project" } },
      { harnessProjectSession: { projectId: "project", kind: "chat" }, featureId: "forged" }
    ])
      expect(() => resolveCapabilityContext(workspace, "t", readers({ t: thread(extra) }))).toThrow(
        "CAPABILITY_PROJECT_UNAVAILABLE"
      )
    expect(() =>
      resolveCapabilityContext(resolve("elsewhere"), "t", readers({ t: thread() }))
    ).toThrow("CAPABILITY_CONTEXT_CHANGED")
  })
  it("does not trust host-project metadata without the original store proof", () => {
    const read = readers({ t: thread({ hostProjectRuntime: { projectId: "project" } }) })
    expect(() => resolveCapabilityContext(workspace, "t", read)).toThrow()
    expect(
      resolveCapabilityContext(workspace, "t", { ...read, hostProject: () => true }).usage
    ).toBe("project")
  })
  it("never infers workspace ownership from the parent of an indexed project root", () => {
    const read = readers({
      t: thread({ harnessProjectSession: { projectId: "project", kind: "chat" } })
    })
    expect(() =>
      resolveCapabilityContext(workspace, "t", {
        ...read,
        projectWorkspaces: () => [projectRoot]
      })
    ).toThrow("CAPABILITY_PROJECT_UNAVAILABLE")
  })
  it("inherits only bounded internal children, and fingerprints incarnation changes", () => {
    const rows = {
      child: thread({ isInternalFlowRuntime: true, parentThreadId: "parent" }),
      parent: thread({ harnessProjectSession: { projectId: "project", kind: "chat" } })
    }
    const before = resolveCapabilityContext(workspace, "child", readers(rows))
    expect(before.usage).toBe("project")
    rows.parent.metadata.cmb_thread_incarnation = "two"
    expect(resolveCapabilityContext(workspace, "child", readers(rows)).identity).not.toBe(
      before.identity
    )
    rows.child = thread({ parentThreadId: "parent" })
    expect(resolveCapabilityContext(workspace, "child", readers(rows)).usage).toBe("chat")
    rows.child = thread({ isInternalFlowRuntime: true, parentThreadId: "child" })
    expect(() => resolveCapabilityContext(workspace, "child", readers(rows))).toThrow()
  })
})

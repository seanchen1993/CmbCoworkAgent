import { describe, expect, it } from "vitest"
import { resolveClawThread } from "./claw-scope"
import { withProjectActionScope } from "../harness-board/project-action-scope"

describe("isolated original project Claw scope", () => {
  it("keeps internal Host selection isolated inside the original admitted action scope", async () => {
    const binding = { projectId: "host-project", operationId: "operation", stageId: "draft",
      pluginDigest: "a".repeat(64) }
    const row = { metadata: JSON.stringify({ workspacePath: "workspace",
      isInternalFlowRuntime: true, hostProjectRuntime: binding }) }
    let reads = 0, active = true
    const resolve = () => resolveClawThread("host-thread", id => id === "host-thread" ? row : null)
    await withProjectActionScope("host-thread", binding, () => {
      reads++
      if (!active) throw Error("PROJECT_ACTION_SCOPE_CHANGED")
    }, async () => {
      const before = reads
      expect(resolve()).toBeNull()
      expect(reads).toBe(before + 1)
      active = false
      expect(resolve).toThrow("PROJECT_ACTION_SCOPE_CHANGED")
    })
    // A retired/foreign action never turns the project thread into an ordinary parent.
    expect(resolve()).toBeNull()
    await withProjectActionScope("foreign-thread", binding, () => {}, async () => {
      expect(resolve()).toBeNull()
    })
    await withProjectActionScope("host-thread", { ...binding, operationId: "foreign-operation" },
      () => {}, async () => { expect(resolve()).toBeNull() })
  })

  it("preserves the original non-internal Host projection and ordinary chat selection", async () => {
    const binding = { projectId: "host-project", operationId: "operation", stageId: "draft",
      pluginDigest: "a".repeat(64) }
    const rows: Record<string, { metadata: unknown }> = {
      host: { metadata: { workspacePath: "workspace", agentMode: "normal", hostProjectRuntime: binding } },
      ordinary: { metadata: { workspacePath: "workspace", agentMode: "normal" } }
    }
    expect(resolveClawThread("host", id => rows[id] ?? null)).toBeNull()
    await withProjectActionScope("host", binding, () => {}, async () => {
      expect(resolveClawThread("host", id => rows[id] ?? null)?.threadId).toBe("host")
      expect(resolveClawThread("ordinary", id => rows[id] ?? null)?.threadId).toBe("ordinary")
    })
  })
  it.each(["composition-legacy:run:unit", "creator-business-trial:trial"])(
    "never inherits ordinary chat selections for isolated project %s",
    (projectId) => {
      for (const parentThreadId of [undefined, "parent"]) {
        const rows: Record<string, { metadata: unknown }> = {
          internal: {
            metadata: {
              workspacePath: "workspace",
              agentMode: "normal",
              isInternalFlowRuntime: true,
              parentThreadId,
              harnessFeature: { projectId, slug: "feature" }
            }
          },
          parent: { metadata: { workspacePath: "workspace", agentMode: "normal" } }
        }
        expect(resolveClawThread("internal", (id) => rows[id] ?? null)).toBeNull()
      }
    }
  )

  it("preserves ordinary child inheritance and rejection of missing parents", () => {
    const rows: Record<string, { metadata: unknown }> = {
      child: {
        metadata: {
          workspacePath: "workspace",
          agentMode: "normal",
          isInternalFlowRuntime: true,
          parentThreadId: "parent"
        }
      },
      parent: { metadata: { workspacePath: "workspace", agentMode: "normal" } }
    }
    expect(resolveClawThread("child", (id) => rows[id] ?? null)?.threadId).toBe("parent")
    delete rows.parent
    expect(() => resolveClawThread("child", (id) => rows[id] ?? null)).toThrow(
      "CLAW_PARENT_SCOPE_INVALID"
    )
  })
})

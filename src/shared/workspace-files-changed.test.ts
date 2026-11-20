import { describe, expect, it } from "vitest"
import { normalizeWorkspacePathKey } from "./workspace-path"
import { normalizeWorkspaceFilesChangedPayload } from "./workspace-files-changed"

describe("workspace files changed payload", () => {
  it("normalizes and deduplicates a batched physical-workspace event", () => {
    expect(
      normalizeWorkspaceFilesChangedPayload({
        threadIds: ["thread-1", "thread-2", "thread-1", ""],
        workspacePath: "C:/Workspace/",
        changeType: "meta"
      })
    ).toEqual({
      threadIds: ["thread-1", "thread-2"],
      workspacePath: normalizeWorkspacePathKey("C:/Workspace/"),
      changeType: "meta",
      update: { kind: "rescan" }
    })
  })

  it("adapts the former one-thread payload during hot reloads", () => {
    expect(
      normalizeWorkspaceFilesChangedPayload({
        threadId: "legacy-thread",
        workspacePath: "/workspace/"
      })
    ).toEqual({
      threadIds: ["legacy-thread"],
      workspacePath: normalizeWorkspacePathKey("/workspace/"),
      changeType: "file",
      update: { kind: "rescan" }
    })
  })

  it("keeps a bounded, normalized incremental patch", () => {
    expect(
      normalizeWorkspaceFilesChangedPayload({
        threadIds: ["thread-1"],
        workspacePath: "/workspace",
        changeType: "file",
        update: {
          kind: "patch",
          upserts: [
            {
              path: "src\\index.ts",
              is_dir: false,
              size: 12,
              modified_at: "2026-08-21T00:00:00.000Z"
            }
          ],
          deletes: ["old//file.ts"]
        }
      })
    ).toEqual({
      threadIds: ["thread-1"],
      workspacePath: normalizeWorkspacePathKey("/workspace"),
      changeType: "file",
      update: {
        kind: "patch",
        upserts: [
          {
            path: "/src/index.ts",
            is_dir: false,
            size: 12,
            modified_at: "2026-08-21T00:00:00.000Z"
          }
        ],
        deletes: ["/old/file.ts"]
      }
    })
  })

  it("falls back to a rescan for unsafe paths", () => {
    const payload = normalizeWorkspaceFilesChangedPayload({
      threadIds: ["thread-1"],
      workspacePath: "/workspace",
      changeType: "file",
      update: {
        kind: "patch",
        upserts: [],
        deletes: ["../outside.txt"]
      }
    })

    expect(payload?.update).toEqual({ kind: "rescan" })
  })
})

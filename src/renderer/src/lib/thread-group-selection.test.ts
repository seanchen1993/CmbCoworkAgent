import { describe, expect, it, vi } from "vitest"
import {
  haveSameThreadGroupSelection,
  readCompleteThreadGroupSelection,
  THREAD_GROUP_SELECTION_MAX_IDS
} from "./thread-group-selection"

function entry(threadId: string, token: string | null = threadId) {
  return { threadId, incarnation: { token, legacyCreatedAt: 1 } }
}

describe("readCompleteThreadGroupSelection", () => {
  it("collects one coherent identity snapshot without hydrating thread summaries", async () => {
    const readGroupIds = vi.fn().mockResolvedValue({
      entries: Array.from({ length: 130 }, (_, index) => entry(`thread-${index}`))
    })

    const result = await readCompleteThreadGroupSelection(
      { type: "workspace", workspacePath: "C:/repo" },
      readGroupIds
    )

    expect(result).toHaveLength(130)
    expect(readGroupIds).toHaveBeenCalledOnce()
    expect(readGroupIds).toHaveBeenCalledWith({
      selector: { type: "workspace", workspacePath: "C:/repo" }
    })
  })

  it("fails closed for invalid ids or an unsafe total", async () => {
    await expect(
      readCompleteThreadGroupSelection({ type: "workspace", workspacePath: null }, async () => ({
        entries: [entry("")]
      }))
    ).rejects.toThrow("无效会话")

    const oversized = Array.from({ length: THREAD_GROUP_SELECTION_MAX_IDS + 1 }, (_, index) =>
      entry(`thread-${index}`)
    )
    await expect(
      readCompleteThreadGroupSelection(
        { type: "harness-project", projectId: "project" },
        async () => ({ entries: oversized })
      )
    ).rejects.toThrow("为避免误删已停止操作")
  })

  it("fails closed for malformed or conflicting incarnation snapshots", async () => {
    await expect(
      readCompleteThreadGroupSelection({ type: "workspace", workspacePath: null }, async () => ({
        entries: [{ threadId: "thread", incarnation: { token: "", legacyCreatedAt: 1 } }]
      }))
    ).rejects.toThrow("无效会话实例")

    await expect(
      readCompleteThreadGroupSelection({ type: "workspace", workspacePath: null }, async () => ({
        entries: [entry("thread", "one"), entry("thread", "two")]
      }))
    ).rejects.toThrow("冲突的会话实例")
  })
})

describe("haveSameThreadGroupSelection", () => {
  it("compares identity independently of ordering", () => {
    expect(haveSameThreadGroupSelection([entry("a"), entry("b")], [entry("b"), entry("a")])).toBe(
      true
    )
    expect(haveSameThreadGroupSelection([entry("a")], [entry("a"), entry("b")])).toBe(false)
  })

  it("detects same-id recreation between confirmation snapshots", () => {
    expect(haveSameThreadGroupSelection([entry("a", "old")], [entry("a", "new")])).toBe(false)
  })
})

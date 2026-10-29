import { beforeEach, describe, expect, it } from "vitest"

import {
  REQUIREMENT_DESIGN_ASSOCIATIONS_KEY,
  buildRequirementDesignPrompt,
  listRequirementDesignEntries,
  loadActiveRequirementDesignEntry,
  storeActiveRequirementDesignEntry,
  storeRequirementDesignEntries,
  type RequirementDesignEntry
} from "./requirement-design-entry"

const entry: RequirementDesignEntry = {
  requirementId: "req-1",
  requirementName: "step3-todo需求",
  functionName: "FR1 待办管理",
  workspacePath: "/workspace",
  requirementFilePath: "/workspace/requirements/FR1.md",
  prompt: "设计待办管理",
  htmlId: "design-session-1"
}

let values: Map<string, string>
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key)
}

describe("active requirement design entry", () => {
  beforeEach(() => {
    values = new Map()
  })

  it("restores the requirement context for the same design session", () => {
    storeActiveRequirementDesignEntry(entry, entry.htmlId, storage)

    expect(loadActiveRequirementDesignEntry("design-session-1", storage)).toEqual(entry)
  })

  it("does not attach a stale requirement context to another design session", () => {
    storeActiveRequirementDesignEntry(entry, entry.htmlId, storage)

    expect(loadActiveRequirementDesignEntry("another-session", storage)).toBeNull()
  })

  it("clears the persisted context when the requirement binding ends", () => {
    storeActiveRequirementDesignEntry(entry, entry.htmlId, storage)
    storeActiveRequirementDesignEntry(null, entry.htmlId, storage)

    expect(storage.getItem(REQUIREMENT_DESIGN_ASSOCIATIONS_KEY)).toBeNull()
  })

  it("keeps associations for different design sessions independent", () => {
    const another = { ...entry, requirementId: "req-2", htmlId: "design-session-2" }
    storeActiveRequirementDesignEntry(entry, entry.htmlId, storage)
    storeActiveRequirementDesignEntry(another, another.htmlId, storage)

    expect(loadActiveRequirementDesignEntry(entry.htmlId, storage)).toEqual(entry)
    expect(loadActiveRequirementDesignEntry(another.htmlId, storage)).toEqual(another)
  })

  it("removes only the association for the deleted design session", () => {
    const another = { ...entry, requirementId: "req-2", htmlId: "design-session-2" }
    storeActiveRequirementDesignEntry(entry, entry.htmlId, storage)
    storeActiveRequirementDesignEntry(another, another.htmlId, storage)

    storeActiveRequirementDesignEntry(null, entry.htmlId, storage)

    expect(loadActiveRequirementDesignEntry(entry.htmlId, storage)).toBeNull()
    expect(loadActiveRequirementDesignEntry(another.htmlId, storage)).toEqual(another)
  })

  it("stores a batch without discarding existing session associations", () => {
    const second = {
      ...entry,
      functionName: "FR2 待办总结",
      requirementFilePath: "/workspace/requirements/FR2.md",
      htmlId: "design-session-2"
    }
    storeActiveRequirementDesignEntry(entry, entry.htmlId, storage)
    storeRequirementDesignEntries([second], storage)

    expect(loadActiveRequirementDesignEntry(entry.htmlId, storage)).toEqual(entry)
    expect(loadActiveRequirementDesignEntry(second.htmlId, storage)).toEqual(second)
  })

  it("deduplicates function tabs while preferring the active historical session", () => {
    const newer = { ...entry, htmlId: "design-session-new" }
    storeRequirementDesignEntries([entry, newer], storage)

    expect(listRequirementDesignEntries(entry.requirementId, storage)).toEqual([newer])
    expect(
      listRequirementDesignEntries(entry.requirementId, storage, entry.htmlId)
    ).toEqual([entry])
  })
})

describe("requirement design prompt", () => {
  it("describes the attached requirement as the source of truth", () => {
    const prompt = buildRequirementDesignPrompt("FR2 待办总结", "prd/fr-2-doc.md")

    expect(prompt).toContain("核心需求文件「prd/fr-2-doc.md」")
    expect(prompt).toContain("为「FR2 待办总结」完成高保真交互原型设计")
    expect(prompt).toContain("其他附件属于补充参考资料")
    expect(prompt).toContain("以核心需求文件为准")
    expect(prompt).toContain("完整、可独立运行的单页 HTML")
  })
})

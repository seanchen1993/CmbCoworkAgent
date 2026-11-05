import { beforeEach, describe, expect, it } from "vitest"

import {
  REQUIREMENT_DESIGN_ASSOCIATIONS_KEY,
  buildRequirementDesignPrompt,
  buildFullPrdDesignPrompt,
  buildSpaceRequirementDesignPrompt,
  findRequirementDesignEntry,
  listRequirementDesignEntries,
  loadActiveRequirementDesignEntry,
  isRequirementPrototypeStepComplete,
  removeRequirementDesignSessions,
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

  it("stores a requirement-space association without persisting document content", () => {
    const spaceEntry: RequirementDesignEntry = {
      source: "space",
      requirementId: "space:org:REQ-1",
      requirementName: "远端需求",
      requirementFilePath: "space://REQ-1",
      requirementContent: "完整需求正文",
      prompt: "生成原型",
      htmlId: "design-space-1"
    }

    storeActiveRequirementDesignEntry(spaceEntry, spaceEntry.htmlId, storage)

    const restored = findRequirementDesignEntry(spaceEntry.requirementId, storage)
    expect(restored).toMatchObject({
      requirementId: spaceEntry.requirementId,
      htmlId: spaceEntry.htmlId
    })
    expect(restored?.requirementContent).toBeUndefined()
    expect(storage.getItem(REQUIREMENT_DESIGN_ASSOCIATIONS_KEY)).not.toContain("完整需求正文")
  })

  it("removes successful session mappings while preserving failed ones for retry", async () => {
    const failed = { ...entry, htmlId: "design-session-failed" }
    storeRequirementDesignEntries([entry, failed], storage)

    const failedIds = await removeRequirementDesignSessions(
      [entry.htmlId, failed.htmlId],
      async (sessionId) => {
        if (sessionId === failed.htmlId) throw new Error("delete failed")
      },
      storage
    )

    expect(failedIds).toEqual([failed.htmlId])
    expect(loadActiveRequirementDesignEntry(entry.htmlId, storage)).toBeNull()
    expect(loadActiveRequirementDesignEntry(failed.htmlId, storage)).toEqual(failed)
  })

  it("deduplicates function tabs while preferring the active historical session", () => {
    const newer = { ...entry, htmlId: "design-session-new" }
    storeRequirementDesignEntries([entry, newer], storage)

    expect(listRequirementDesignEntries(entry.requirementId, storage)).toEqual([newer])
    expect(listRequirementDesignEntries(entry.requirementId, storage, entry.htmlId)).toEqual([
      entry
    ])
  })
})

describe("requirement design prompt", () => {
  it("describes the attached requirement as the source of truth", () => {
    const prompt = buildRequirementDesignPrompt("FR2 待办总结", "prd/fr-2-doc.md")

    expect(prompt).toContain("需求文件「prd/fr-2-doc.md」")
    expect(prompt).toContain("为「FR2 待办总结」设计高保真交互原型")
    expect(prompt).toContain("其他资料仅作补充")
    expect(prompt).toContain("以需求文件为准")
    expect(prompt).toContain("可独立运行")
  })

  it("builds a single-session prompt from the complete PRD", () => {
    const prompt = buildFullPrdDesignPrompt("prd/product.md")

    expect(prompt).toContain("完整 PRD 文档「prd/product.md」")
    expect(prompt).toContain("整个产品")
    expect(prompt).toContain("信息架构")
  })

  it("builds a prototype prompt for a requirement-space document attachment", () => {
    const prompt = buildSpaceRequirementDesignPrompt("资金结算")

    expect(prompt).toContain("为「资金结算」生成高保真交互原型")
    expect(prompt).toContain("需求文档是业务范围、流程和规则的唯一依据")
    expect(prompt).toContain("完整原型文件")
  })
})

describe("requirement prototype completion", () => {
  it("completes the step when the full PRD prototype has been saved", () => {
    expect(
      isRequirementPrototypeStepComplete({
        skipped: false,
        allFunctionsComplete: false,
        fullPrdHtmlFile: "/workspace/full-prd.html",
        published: false
      })
    ).toBe(true)
  })

  it("keeps the step incomplete while a full PRD session has no saved prototype", () => {
    expect(
      isRequirementPrototypeStepComplete({
        skipped: false,
        allFunctionsComplete: false,
        fullPrdHtmlFile: "",
        published: false
      })
    ).toBe(false)
  })
})

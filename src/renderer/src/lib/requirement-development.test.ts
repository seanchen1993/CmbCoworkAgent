import { describe, expect, it } from "vitest"
import {
  buildRequirementDevelopmentPrompt,
  findRequirementDevelopmentAssociation,
  getStoredRequirementDevelopmentMetadata,
  isMissingRequirementThreadError,
  normalizeRequirementPrdFilePath,
  removeRequirementDevelopmentAssociation,
  resolveRequirementPrdFilePath,
  storeRequirementDevelopmentAssociation,
  type RequirementDevelopmentMetadata
} from "./requirement-development"

function createStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  }
}

function metadata(requirementId: string): RequirementDevelopmentMetadata {
  return {
    requirementId,
    requirementTitle: "测试需求",
    requirementFilePath: `/workspace/requirements/${requirementId}/需求文档.md`,
    prototypeFilePaths: [`/workspace/requirements/${requirementId}/prototype.html`],
    functionCount: 3,
    hasPrototype: true
  }
}

describe("requirement development associations", () => {
  it("resolves a manifest PRD filename inside the requirement prd directory", () => {
    const workspace = String.raw`D:\my-projects\requirements\req-1-简单表格`

    expect(resolveRequirementPrdFilePath(workspace, "简单表格_完整版PRD.md")).toBe(
      String.raw`D:\my-projects\requirements\req-1-简单表格/prd/简单表格_完整版PRD.md`
    )
    expect(resolveRequirementPrdFilePath(workspace, "prd/简单表格_完整版PRD.md")).toBe(
      String.raw`D:\my-projects\requirements\req-1-简单表格/prd/简单表格_完整版PRD.md`
    )
  })

  it("shares the same PRD path normalization used by file opening and project mode", () => {
    expect(normalizeRequirementPrdFilePath("简单表格_完整版PRD.md")).toBe(
      "/prd/简单表格_完整版PRD.md"
    )
    expect(normalizeRequirementPrdFilePath("prd/简单表格_完整版PRD.md")).toBe(
      "/prd/简单表格_完整版PRD.md"
    )
  })

  it("recognizes an already deleted associated thread", () => {
    expect(
      isMissingRequirementThreadError(
        new Error("Error invoking remote method 'threads:delete': Error: Thread not found")
      )
    ).toBe(true)
    expect(isMissingRequirementThreadError(new Error("会话仍在运行"))).toBe(false)
  })

  it("formats Windows paths without Markdown escape-like backslashes", () => {
    const prompt = buildRequirementDevelopmentPrompt({
      title: "简单todolist",
      requirementFilePath: String.raw`D:\my-projects\简单todolist\_完整版PRD.md`,
      prototypeFilePaths: [String.raw`D:\my-projects\简单todolist\prototype_a.html`]
    })

    expect(prompt).toContain("需求文件：`D:/my-projects/简单todolist/_完整版PRD.md`")
    expect(prompt).toContain("  - `D:/my-projects/简单todolist/prototype_a.html`")
    expect(prompt).not.toContain(String.raw`\_完整版PRD.md`)
  })

  it("stores the whole development mapping in one association", () => {
    const storage = createStorage()
    storeRequirementDevelopmentAssociation("thread-1", metadata("space:org:REQ-1"), storage)

    expect(findRequirementDevelopmentAssociation("space:org:REQ-1", storage)).toMatchObject({
      threadId: "thread-1",
      requirementFilePath: "/workspace/requirements/space:org:REQ-1/需求文档.md"
    })
    expect(getStoredRequirementDevelopmentMetadata("thread-1", storage)).toMatchObject({
      requirementTitle: "测试需求",
      functionCount: 3,
      hasPrototype: true
    })
  })

  it("removes only the reset requirement association", () => {
    const storage = createStorage()
    storeRequirementDevelopmentAssociation("thread-1", metadata("space:org:REQ-1"), storage)
    storeRequirementDevelopmentAssociation("thread-2", metadata("space:org:REQ-2"), storage)

    removeRequirementDevelopmentAssociation("space:org:REQ-1", storage)

    expect(findRequirementDevelopmentAssociation("space:org:REQ-1", storage)).toBeNull()
    expect(findRequirementDevelopmentAssociation("space:org:REQ-2", storage)?.threadId).toBe(
      "thread-2"
    )
  })

  it("keeps the session and context available after an app reload", () => {
    const storage = createStorage()
    storeRequirementDevelopmentAssociation("thread-1", metadata("space:org:REQ-1"), storage)

    expect(findRequirementDevelopmentAssociation("space:org:REQ-1", storage)?.threadId).toBe(
      "thread-1"
    )
    expect(getStoredRequirementDevelopmentMetadata("thread-1", storage)?.hasPrototype).toBe(true)
  })
})

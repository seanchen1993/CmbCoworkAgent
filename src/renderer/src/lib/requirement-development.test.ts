import { describe, expect, it } from "vitest"
import {
  findRequirementDevelopmentAssociation,
  getStoredRequirementDevelopmentMetadata,
  removeRequirementDevelopmentAssociation,
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

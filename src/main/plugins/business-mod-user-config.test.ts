import { describe, expect, it } from "vitest"
import {
  assertPortableBusinessBoard,
  mergeBusinessModUserConfig,
  parsePortableBusinessModUserConfig
} from "./business-mod-user-config"

const tone = { type: "string", title: "Tone", description: "Report style", default: "formal" }
describe("portable business Mod configuration declarations", () => {
  it("rejects literal credentials without exposing values or removing original rules", () => {
    const board = { knowledge_config: { leanToken: "private-literal-value", nextAction: "keep" } }
    expect(() => assertPortableBusinessBoard(board)).toThrow("knowledge_config.leanToken")
    try {
      assertPortableBusinessBoard(board)
    } catch (error) {
      expect(String(error)).not.toContain("private-literal-value")
    }
    expect(board.knowledge_config.nextAction).toBe("keep")
    expect(() =>
      assertPortableBusinessBoard({
        knowledge_config: {
          leanToken: "${leanToken}",
          password: "",
          nextAction: { userMessage: "请配置 ${leanToken}" }
        }
      })
    ).not.toThrow()
  })
  it("merges shared declarations without copying installed values", () => {
    expect(
      mergeBusinessModUserConfig([
        { tone },
        { tone },
        {
          knowledgeRoot: {
            type: "directory",
            title: "Knowledge",
            description: "Bind on this machine",
            required: true
          },
          accessToken: {
            type: "string",
            title: "Token",
            description: "Set privately",
            sensitive: true
          }
        }
      ])
    ).toEqual({
      tone,
      knowledgeRoot: {
        type: "directory",
        title: "Knowledge",
        description: "Bind on this machine",
        required: true
      },
      accessToken: { type: "string", title: "Token", description: "Set privately", sensitive: true }
    })
  })
  it("rejects same-key conflicting schemas and the existing host field limit", () => {
    expect(() =>
      mergeBusinessModUserConfig([{ tone }, { tone: { ...tone, default: "casual" } }])
    ).toThrow("声明冲突")
    expect(() =>
      mergeBusinessModUserConfig([
        Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`field${index}`, tone])),
        { extra: tone }
      ])
    ).toThrow("Invalid plugin configuration field: manifest")
  })
  it.each([
    { type: "directory", default: "C:\\private\\knowledge" },
    { type: "file", default: "/home/author/private.txt" },
    { type: "string", sensitive: true, default: "must-not-travel" }
  ])("rejects portable defaults carrying a machine path or secret (%j)", (field) => {
    expect(() =>
      parsePortableBusinessModUserConfig({
        privateField: {
          title: "Private",
          description: "Bind locally",
          ...field
        }
      })
    ).toThrow("不能包含默认值")
  })
  it("rejects mutable installed-value objects in place of a schema", () => {
    expect(() => parsePortableBusinessModUserConfig({ tone: "private installed value" })).toThrow(
      "Invalid plugin configuration field: tone"
    )
  })
})

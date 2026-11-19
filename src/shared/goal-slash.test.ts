import { describe, expect, it } from "vitest"
import { legacyGoalStartContent, normalizedGoalCommandContent } from "./goal-events"
import { splitGoalTransportPayload } from "./goal-slash"
import { findChatSearchLocations, projectChatSearchPlan } from "./chat-search-index"
import { createThreadSearchMessagePlan } from "./thread-search-projection"
import { projectUserAttachmentContent } from "./user-attachment-display"
import { stripThinkBlocksForDisplay } from "./think-block-display"
import { parseSkillUseBlock, stripSkillUseBlockForDisplay } from "./skill-use-block"
import { normalizeVisibleReasoningText } from "./transcript-reasoning"

describe("Goal transport recovery", () => {
  it("keeps literal markup while separating a complete attachment suffix", () => {
    const command = "/goal discuss <attachment without transport"
    const payload = '<ATTACHMENT filename="one">text</attachment>\n<attachment>two</attachment>'
    expect(splitGoalTransportPayload(`${command}\n\n${payload}`)).toEqual({
      commandText: command,
      payload
    })
  })

  it("handles long whitespace with malformed transport and truncated legacy XML", () => {
    const gap = "\n".repeat(4000)
    const start = performance.now()
    const literal = `/goal consider <attachment${gap}tail`
    expect(splitGoalTransportPayload(literal)).toEqual({ commandText: literal, payload: "" })
    expect(legacyGoalStartContent(
      "user", `[Starting active goal]\n<untrusted_objective>${gap}tail`
    )).toBe("/goal")
    expect(performance.now() - start).toBeLessThan(200)
  })

  it("drops Goal attachment and skill labels while preserving the objective", () => {
    expect(normalizedGoalCommandContent(
      "/goal review\n\n  启动附件：old.md\nkeep this line\n\n显式技能：sample\nfinish"
    )).toBe("/goal review\nkeep this line\nfinish")
  })

  it("matches only a Goal control label that the chat actually renders", () => {
    const search = (content: string, query: string) => findChatSearchLocations(
      projectChatSearchPlan(createThreadSearchMessagePlan("user", content, [], null)!), query
    )
    const goal = "/goal resume\nAudit the deployment receipts"
    expect(search(goal, "deployment receipts")).toHaveLength(1)
    expect(search(goal, "继续推进目标")).toEqual([])
    expect(search("/goal\nresume", "继续推进目标")).toHaveLength(1)
  })

  it("bounds repeated unclosed payload markers in searchable bodies", () => {
    const malformedAttachments = '<attachment filename="note" '.repeat(3000).trim()
    const incompleteThink = "Visible prefix " + "<think>".repeat(8000)
    const start = performance.now()
    expect(projectUserAttachmentContent(malformedAttachments)).toEqual({
      text: malformedAttachments, incomplete: false
    })
    expect(stripThinkBlocksForDisplay(incompleteThink)).toBe(incompleteThink)
    expect(performance.now() - start).toBeLessThan(180)
  })

  it("keeps bounded malformed skill and reasoning fields from stalling projection", () => {
    const malformed = "Read an old note\n<CMBDEVCLAW-SKILL-USE-V1><name>" +
      " ".repeat(4000) + "<path>/work/example/SKILL.md</path></CMBDEVCLAW-SKILL-USE-V1>"
    const start = performance.now()
    expect(parseSkillUseBlock(malformed)).toBeNull()
    expect(stripSkillUseBlockForDisplay(malformed)).toEqual({
      rest: "Read an old note", skillName: "example"
    })
    const projected = projectChatSearchPlan(createThreadSearchMessagePlan("user", malformed, [], null)!)
    expect(findChatSearchLocations(projected, "Read an old note")).toHaveLength(1)
    for (let index = 0; index < 32; index += 1) {
      expect(normalizeVisibleReasoningText(`<think>text${" ".repeat(4000)}continued`)).toContain("continued")
    }
    expect(performance.now() - start).toBeLessThan(180)
  })

  it("retains unknown tool names instead of looking them up on the object prototype", () => {
    const tools = JSON.stringify([{ name: "constructor", args: {} }])
    const plan = createThreadSearchMessagePlan("assistant", "", [], tools)!
    expect(findChatSearchLocations(projectChatSearchPlan(plan), "constructor")).toHaveLength(1)
  })
})

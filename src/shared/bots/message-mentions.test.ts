import { describe, expect, it } from "vitest"
import { canonicalBotMessageInput, parseBotMessageMentions } from "./message-mentions"
import { parseSendBotMessage } from "./validation"

describe("private Bot mention identity", () => {
  it("retains explicit private group identities without changing legacy Bot digest bytes", () => {
    const group = { start: 3, end: 5, kind: "group" as const, groupId: "group-a", label: "A" }
    expect(parseBotMessageMentions("😀 @A", [group])).toEqual([group])
    expect(
      parseSendBotMessage({
        botId: "owner",
        requestId: "r",
        message: "  😀 @A  ",
        mentions: [{ ...group, start: 5, end: 7 }]
      }).mentions
    ).toEqual([group])
    const bot = { start: 0, end: 2, botId: "peer", label: "A" }
    expect(canonicalBotMessageInput("@A", [bot])).toBe(
      '["@A",[{"start":0,"end":2,"botId":"peer","label":"A"}]]'
    )
    const selected = { ...group, start: 0, end: 2 }
    expect(canonicalBotMessageInput("@A", [selected])).not.toBe(
      canonicalBotMessageInput("@A", [bot])
    )
    expect(canonicalBotMessageInput("@A", [selected])).not.toBe(
      canonicalBotMessageInput("@A", [{ ...selected, groupId: "group-b" }])
    )
  })
  it("distinguishes same-name App and Zhaohu group references without altering legacy drafts", () => {
    const base = { start:0, end:2, label:"群", kind:"group" as const, groupId:"group" }
    const remote = { ...base, groupSource:"zhaohu" as const }
    expect(parseBotMessageMentions("@群",[remote])).toEqual([remote])
    expect(canonicalBotMessageInput("@群",[remote])).not.toBe(canonicalBotMessageInput("@群",[base]))
    expect(() => parseBotMessageMentions("@群",[{...base,groupSource:"unknown"}])).toThrow()
    expect(() => parseBotMessageMentions("@群",[{start:0,end:2,label:"群",botId:"b",groupSource:"zhaohu"}])).toThrow()
  })
  it.each([
    { kind: "group", groupId: "g", botId: "b" },
    { kind: "group", groupId: "" },
    { kind: "group", groupId: "../g" },
    { kind: "bot", botId: "b", groupId: "g" },
    { groupId: "g" },
    { kind: "other", botId: "b" }
  ])("rejects ambiguous private group entity identities: %#", (identity) => {
    expect(() =>
      parseBotMessageMentions("@A", [{ start: 0, end: 2, label: "A", ...identity }])
    ).toThrow()
  })
  it("validates exact UTF-16 ranges and projects the original send trim", () => {
    const mention = { start: 5, end: 9, botId: "peer", label: "同名A" }
    expect(
      parseSendBotMessage({
        botId: "owner",
        requestId: "r",
        message: "  😀 @同名A  ",
        mentions: [mention]
      })
    ).toMatchObject({
      message: "😀 @同名A",
      mentions: [{ ...mention, start: 3, end: 7 }]
    })
  })
  it.each([
    null,
    [{ start: 0, end: 2, botId: null, label: "A" }],
    [{ start: 0, end: 2, botId: "peer", label: "B" }],
    [{ start: -1, end: 2, botId: "peer", label: "A" }],
    [{ start: 0.5, end: 2, botId: "peer", label: "A" }],
    [
      { start: 0, end: 2, botId: "peer", label: "A" },
      { start: 0, end: 2, botId: "other", label: "A" }
    ]
  ])("rejects forged, overlapping or broadcast identities: %#", (input) => {
    expect(() => parseBotMessageMentions("@A", input)).toThrow()
  })
  it("keeps every legacy digest byte and binds selected IDs despite identical labels", () => {
    const text = "  @A\n"
    expect(canonicalBotMessageInput(text)).toBe(text)
    expect(canonicalBotMessageInput(text, [])).toBe(text)
    const a = [{ start: 2, end: 4, botId: "a", label: "A" }]
    expect(canonicalBotMessageInput(text, a)).not.toBe(text)
    expect(canonicalBotMessageInput(text, a)).not.toBe(
      canonicalBotMessageInput(text, [{ ...a[0], botId: "b" }])
    )
  })
})

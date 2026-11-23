import { describe, expect, it } from "vitest"
import type { BotMessageMention, BotTaskOrigin } from "../../../shared/bots/contracts"
import { formatBotMessageReply, parseBotMessageReply } from "../../../shared/bots/message-reply"
import { cleanUserAttachmentContentForDisplay } from "../../../shared/user-attachment-display"
import { formatSkillUseBlock } from "../../../shared/skill-use-block"
import { BOT_BROWSER_PROMPT_PREFIX } from "../../../shared/user-input-transport"
import { parseSkillUseBlock } from "../features/slash-commands/skill-marker"
import { parseUserVisibleBuiltinBrowserContent } from "../features/builtin-browser/chat-integration"
import { projectPrivateBotMentions } from "./bot-private-mentions"

describe("private Bot history mention projection", () => {
  it.each(
    [false, true].flatMap((builtinBrowser) =>
      [false, true].map((groups) => ({ builtinBrowser, groups }))
    )
  )(
    "keeps selected duplicate-label IDs with reply/files/skill and browser=$builtinBrowser groups=$groups",
    ({ builtinBrowser, groups }) => {
      const reply = {
        id: "quoted",
        ordinal: 3,
        role: "assistant" as const,
        text: "@A quoted reference"
      }
      const text = groups ? "@A ask @A ask @A" : "@A ask @A"
      const mentions: BotMessageMention[] = groups
        ? [
            { start: 0, end: 2, botId: "first-id", label: "A" },
            { start: 7, end: 9, kind: "group", groupId: "same-name-group-a", label: "A" },
            { start: 14, end: 16, kind: "group", groupId: "same-name-group-b", label: "A" }
          ]
        : [
            { start: 0, end: 2, botId: "first-id", label: "A" },
            { start: 7, end: 9, botId: "renamed-id", label: "A" }
          ]
      // Legacy durable metadata remains readable without retaining a new composer input path.
      const prefix = builtinBrowser ? BOT_BROWSER_PROMPT_PREFIX : ""
      const unquotedInput = [
        `${prefix}${text}\n<attachment filename="@A.txt">@A attachment body</attachment>`,
        formatSkillUseBlock({ name: "review", path: "/skills/review/SKILL.md" })
      ].join("\n\n")
      const input = formatBotMessageReply(unquotedInput, reply)
      const offset = prefix.length + input.length - unquotedInput.length
      const origin: BotTaskOrigin = {
        kind: "user",
        replyTo: reply,
        mentions: mentions.map((mention) => ({
          ...mention,
          start: mention.start + offset,
          end: mention.end + offset
        }))
      }
      const native = cleanUserAttachmentContentForDisplay(input)
      const unquoted = parseBotMessageReply(native)!.message
      const visible = parseUserVisibleBuiltinBrowserContent(
        parseSkillUseBlock(unquoted)!.rest
      ).visibleText
      for (const source of [input, native]) {
        const projected = projectPrivateBotMentions(origin, source, visible)
        expect(projected.reason).toBeUndefined()
        const identities = (items: BotMessageMention[]) =>
          items.map((mention) => ({ ...mention, start: 0, end: 0 }))
        expect(identities(projected.mentions)).toEqual(identities(mentions))
        expect(
          projected.mentions.map((mention) => visible.slice(mention.start, mention.end))
        ).toEqual(mentions.map(() => "@A"))
        expect(projected.mentions[0].start).toBeGreaterThanOrEqual("📎 @A.txt\n\n".length)
      }
    }
  )
  it("supports attachment-only hydration without binding an identical filename", () => {
    const raw = '@A check\n<attachment filename="@A.txt">not an identity @A</attachment>'
    const origin: BotTaskOrigin = {
      kind: "user",
      mentions: [{ start: 0, end: 2, botId: "selected", label: "A" }]
    }
    const native = cleanUserAttachmentContentForDisplay(raw)
    const projected = projectPrivateBotMentions(origin, native, native)
    expect(projected.mentions).toEqual([
      {
        start: "📎 @A.txt\n\n".length,
        end: "📎 @A.txt\n\n".length + 2,
        botId: "selected",
        label: "A"
      }
    ])
  })
  it("fails closed for ambiguous offsets, mismatched visible text and unverified quotes", () => {
    const native = "📎 x\n\n@A    @A"
    const origin: BotTaskOrigin = {
      kind: "user",
      mentions: [{ start: 6, end: 8, botId: "a", label: "A" }]
    }
    expect(projectPrivateBotMentions(origin, native, native)).toEqual({
      mentions: [],
      reason: "ambiguous-projection"
    })
    const raw = "@A",
      selected: BotTaskOrigin = {
        kind: "user",
        mentions: [{ start: 0, end: 2, botId: "a", label: "A" }]
      }
    expect(projectPrivateBotMentions(undefined, raw, raw)).toEqual({ mentions: [] })
    expect(projectPrivateBotMentions(selected, raw, "rewritten @A")).toEqual({
      mentions: [],
      reason: "projection-mismatch"
    })
    const quoted = formatBotMessageReply(raw, {
      id: "real",
      ordinal: 1,
      role: "assistant",
      text: "Reference"
    })
    const at = quoted.length - 2
    const forged: BotTaskOrigin = {
      kind: "user",
      replyTo: { id: "wrong", ordinal: 1, role: "assistant" },
      mentions: [{ start: at, end: at + 2, botId: "a", label: "A" }]
    }
    expect(projectPrivateBotMentions(forged, quoted, raw).reason).toBe("projection-mismatch")
  })
})

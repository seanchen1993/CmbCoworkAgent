import { expect, it } from "vitest"
import {
  groupMentionQuery,
  insertGroupMention,
  insertMention,
  rebaseGroupMentions,
  groupMentionRecipients,
  groupMessageRecipients,
  validGroupMentions
} from "./bot-group-mentions"
import { displayedGroupMentions } from "./bot-group-mentions"
import { cleanUserAttachmentContentForDisplay } from "../../../shared/user-attachment-display"

it("projects mention offsets past attachment labels without binding mentions inside attachment contents", () => {
  const raw = '@甲 请核对\n\n<attachment filename="原件.csv">@甲,42</attachment>'
  const display = cleanUserAttachmentContentForDisplay(raw)
  const mentions = displayedGroupMentions(raw, display, [
    { start: 0, end: 2, botId: "a", label: "甲" }
  ])
  expect(mentions).toHaveLength(1)
  expect(display.slice(mentions[0].start, mentions[0].end)).toBe("@甲")
  expect(mentions[0].start).toBe(display.indexOf("@甲"))
})

it("binds same-name members by ID and supports labels with spaces", () => {
  const a = insertGroupMention("@核", { start: 0, end: 2 }, [], "a", "核算 Bot")
  const b = insertGroupMention(
    a.text + "@核",
    { start: a.text.length, end: a.text.length + 2 },
    a.mentions,
    "b",
    "核算 Bot"
  )
  expect(groupMentionRecipients(b.mentions, ["a", "b"]).ids).toEqual(["a", "b"])
  expect(validGroupMentions(b.text, b.mentions)).toEqual(b.mentions)
  expect(groupMentionQuery(a.text + "请核对", a.text.length + 3, a.mentions)).toBeNull()
})
it("preserves untouched ID ranges through edits and removes edited tokens", () => {
  const { text, mentions } = insertGroupMention("@", { start: 0, end: 1 }, [], "a", "甲")
  const shifted = rebaseGroupMentions(text, "你好 " + text, mentions)
  expect(shifted[0].start).toBe(3)
  expect(shifted[0].botId).toBe("a")
  expect(rebaseGroupMentions(text, text.replace("甲", "乙"), mentions)).toEqual([])
  expect(rebaseGroupMentions(text, "", mentions)).toEqual([])
})
it("does not treat email addresses or arbitrary pasted names as selected members", () => {
  expect(groupMentionQuery("a@example.com", 13, [])).toBeNull()
  expect(groupMentionRecipients([], ["a", "b"]).ids).toEqual([])
  expect(groupMentionQuery("请 @核", 4, [])).toMatchObject({ start: 2, query: "核" })
})
it.each(["", "请 ", "\n", "(", "请("])(
  "opens mention candidates after the supported prefix %j",
  (prefix) => {
    const text = `${prefix}@验收`
    expect(groupMentionQuery(text, text.length, [])).toEqual({
      start: prefix.length,
      end: text.length,
      query: "验收"
    })
  }
)
it.each(["请", "（", ")", "a"])(
  "keeps unsupported adjacent prefix %j as ordinary text",
  (prefix) => {
    const text = `${prefix}@验收`
    expect(groupMentionQuery(text, text.length, [])).toBeNull()
  }
)
it("does not reopen candidates inside an already selected parenthesized mention", () => {
  const selected = insertGroupMention("(@", { start: 1, end: 2 }, [], "a", "甲")
  expect(groupMentionQuery(selected.text, 2, selected.mentions)).toBeNull()
  expect(groupMentionQuery(selected.text, selected.text.length, selected.mentions)).toBeNull()
})
it("rejects removed members instead of silently dispatching to everyone else", () => {
  const { mentions } = insertGroupMention("@", { start: 0, end: 1 }, [], "gone", "甲")
  expect(groupMentionRecipients(mentions, ["a", "b"]).error).toContain("不在本群")
  const all = insertGroupMention("@", { start: 0, end: 1 }, [], null, "所有人")
  expect(groupMentionRecipients(all.mentions, ["a", "b"]).ids).toEqual(["a", "b"])
  expect(groupMentionRecipients([...all.mentions, ...mentions], ["a", "b"]).ids).toEqual([])
})
it("keeps quotes as context without expanding explicit or default recipients", () => {
  expect(groupMessageRecipients([], ["a", "b"], { replyAuthorId: "a" }).ids).toEqual(["a", "b"])
  expect(groupMessageRecipients([], ["a", "b"], { replyAuthorId: null }).ids).toEqual(["a", "b"])
  expect(groupMessageRecipients([], ["a", "b"], { replyAuthorId: "gone" }).error).toContain(
    "不在本群"
  )
  const other = insertGroupMention("@", { start: 0, end: 1 }, [], "b", "乙")
  expect(groupMessageRecipients(other.mentions, ["a", "b"], { replyAuthorId: "a" }).ids).toEqual([
    "b"
  ])
  const first = insertGroupMention("@", { start: 0, end: 1 }, [], "a", "甲")
  expect(groupMessageRecipients(first.mentions, ["a", "b"], { replyAuthorId: "b" }).ids).toEqual([
    "a"
  ])
  expect(
    groupMessageRecipients([], ["a", "b"], { targets: ["b"], replyAuthorId: "a" }).ids
  ).toEqual(["b"])
  expect(
    groupMessageRecipients([...first.mentions, ...other.mentions], ["a", "b", "c"], {
      replyAuthorId: "b"
    }).ids
  ).toEqual(["a", "b"])
  expect(groupMessageRecipients(other.mentions, ["a", "b"], { replyAuthorId: "b" }).ids).toEqual([
    "b"
  ])
  expect(
    groupMessageRecipients(other.mentions, ["a", "b"], { replyAuthorId: "gone" }).error
  ).toContain("不在本群")
  const all = insertGroupMention("@", { start: 0, end: 1 }, [], null, "所有人")
  expect(groupMessageRecipients(all.mentions, ["a", "b"], { replyAuthorId: "a" }).ids).toEqual([
    "a",
    "b"
  ])
})
it("ignores malformed or stale ranges on restore", () => {
  expect(validGroupMentions("@甲", [{ start: 0, end: 3, botId: "a", label: "甲" }])).toEqual([])
  const mention = { start: 0, end: 2, botId: "a", label: "甲" }
  expect(validGroupMentions("@甲", [mention, mention])).toEqual([mention])
})

it("preserves explicit private group identity through the shared range editor", () => {
  const selected = insertMention<import("../../../shared/bots/contracts").BotMessageMention>(
    "(@核",
    { start: 1, end: 3 },
    [],
    { kind: "group", groupId: "group-a", label: "核算 Bot" }
  )
  expect(selected.text).toBe("(@核算 Bot ")
  expect(selected.mentions).toEqual([
    { kind: "group", groupId: "group-a", label: "核算 Bot", start: 1, end: 8 }
  ])
  expect(groupMentionQuery(selected.text, 3, selected.mentions)).toBeNull()
  const shifted = rebaseGroupMentions(selected.text, "前缀 " + selected.text, selected.mentions)
  expect(shifted).toEqual([{ ...selected.mentions[0], start: 4, end: 11 }])
  expect(validGroupMentions("前缀 " + selected.text, shifted)).toEqual(shifted)
  expect(
    rebaseGroupMentions(selected.text, selected.text.replace("核算", "核对"), selected.mentions)
  ).toEqual([])
})

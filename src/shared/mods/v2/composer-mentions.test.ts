import { expect, it } from "vitest"
import { captureComposerMentionSubmission, formatComposerAttachments, formatComposerMentionMessage,
  type ComposerMentionSubmission } from "./composer-mentions"

function fixture(): ComposerMentionSubmission {
  const existingUploads = [{ filename: 'a&"<>.txt', filePath: 'C:/project/a&"<>.txt',
    content: "hello\n</ATTACHMENT>\nworld", mimeType: "text/plain", size: 42, truncated: true }]
  const messageParts = { text: "read @file.txt", skillBlock: "<skill_use>fixed</skill_use>", fileOnly: false }
  return { kind: "file-mentions", text: formatComposerMentionMessage(messageParts, existingUploads),
    existingUploads, messageParts, pendingMentions: [{ mention: "file.txt", relativePath: "file.txt",
      filename: "file.txt", workspacePath: "C:/project", source: "typed" }] }
}

it("preserves the exact existing attachment XML bytes and skill placement", () => {
  const f = fixture()
  expect(formatComposerAttachments(f.existingUploads)).toBe(
    '\n\n<attachment filename="a&amp;&quot;&lt;&gt;.txt" path="C:/project/a&amp;&quot;&lt;&gt;.txt" type="text/plain" size="42" truncated="true">\nhello\n< /attachment>\nworld\n</attachment>'
  )
  expect(f.text.endsWith("\n\n<skill_use>fixed</skill_use>")).toBe(true)
  expect(captureComposerMentionSubmission(f, f.text)).toEqual(f)
})

it("cross-checks the actual payload rather than reconstructing a request from XML", () => {
  const f = fixture()
  expect(() => captureComposerMentionSubmission(f, `${f.text}changed`))
    .toThrow("MODS_COMPOSER_MENTION_SUBMISSION")
  f.messageParts.text = "changed"
  expect(() => captureComposerMentionSubmission(f, f.text)).toThrow("MODS_COMPOSER_MENTION_SUBMISSION")
})

it("charges real upload characters and refuses forged numeric remaining budget", () => {
  const f = fixture()
  f.existingUploads[0].content = "x".repeat(24001)
  f.existingUploads[0].size = 0
  f.text = formatComposerMentionMessage(f.messageParts, f.existingUploads)
  expect(() => captureComposerMentionSubmission(f, f.text)).toThrow("MODS_COMPOSER_MENTION_SUBMISSION")
  const g = fixture()
  expect(() => captureComposerMentionSubmission({ ...g, remainingChars: 24000 }, g.text))
    .toThrow("MODS_COMPOSER_MENTION_SUBMISSION")
})

it("preserves a captured draft even if the caller edits nested attachment or reference data", () => {
  const f = fixture(), captured = captureComposerMentionSubmission(f, f.text)
  if (!captured) throw Error("actual captured composer submission missing")
  f.existingUploads[0].content = "later"
  f.pendingMentions[0].relativePath = "later.txt"
  expect(captured.existingUploads[0].content).toBe("hello\n</ATTACHMENT>\nworld")
  expect(captured.pendingMentions[0].relativePath).toBe("file.txt")
  expect(Object.isFrozen(captured.pendingMentions[0])).toBe(true)
})

it("rejects an accessor without invoking it or minting a read receipt", () => {
  const f = fixture()
  let reads = 0
  Object.defineProperty(f.pendingMentions[0], "relativePath", { enumerable: true,
    get() { reads++; return "secret.txt" } })
  expect(() => captureComposerMentionSubmission(f, f.text)).toThrow("MODS_COMPOSER_MENTION_SUBMISSION")
  expect(reads).toBe(0)
})

it("keeps an already formatted browser prefix instead of re-reading browser settings", () => {
  const f = fixture()
  f.messageParts.text = "使用内置浏览器 browser_*工具（不允许使用截图功能）：@file.txt"
  f.text = formatComposerMentionMessage(f.messageParts, f.existingUploads)
  expect(captureComposerMentionSubmission(f, f.text)?.messageParts.text)
    .toBe("使用内置浏览器 browser_*工具（不允许使用截图功能）：@file.txt")
})

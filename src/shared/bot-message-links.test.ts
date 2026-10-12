import { expect, it } from "vitest"
import { botMessageLink } from "./bot-deep-link"
import { BOT_MESSAGE_MAX_LINKS, botMessageLinkHref, botMessageLinkParts } from "./bot-message-links"

const internal = botMessageLink({
  conversationId: "12345678-abcd-4567-abcd-123456789abc",
  messageId: "87654321-abcd-4567-abcd-cba987654321"
})

it("does not make a help instruction after a fullwidth closing bracket part of the destination", () => {
  const text =
    "🙂 请在当前页面（http://127.0.0.1:57685/manual）上找到表单，再看“https://example.org/路径”后的说明。"
  const parts = botMessageLinkParts(text)
  expect(parts.map((part) => part.text).join("")).toBe(text)
  expect(parts.filter((part) => part.kind === "link").map((part) => part.href)).toEqual([
    "http://127.0.0.1:57685/manual",
    new URL("https://example.org/路径").href
  ])
  for (const part of parts) expect(text.slice(part.from, part.to)).toBe(part.text)
})

it("retains exact literal text and UTF-16 ranges around Chinese punctuation and balanced URL parentheses", () => {
  const text = `🙂 链接 https://example.org/a_(b))，中文。第二个 https://example.net/?q=1&x=2。 /review ${internal}`
  const parts = botMessageLinkParts(text)
  expect(parts.map((part) => part.text).join("")).toBe(text)
  for (const part of parts) expect(text.slice(part.from, part.to)).toBe(part.text)
  expect(parts.filter((part) => part.kind === "link").map((part) => part.text)).toEqual([
    "https://example.org/a_(b)",
    "https://example.net/?q=1&x=2",
    internal
  ])
})

it("canonicalizes only exact internal message routes and ordinary HTTP URLs", () => {
  expect(botMessageLinkHref(internal.replace("abcd", "ABCD"))).toBe(internal)
  expect(botMessageLinkHref("https://example.org")).toBe("https://example.org/")
  expect(botMessageLinkHref("http://127.0.0.1:8000/page")).toBe("http://127.0.0.1:8000/page")
  for (const invalid of [
    internal.replace("://app/", "://evil/"),
    internal.toUpperCase(),
    `${internal}?extra=1`,
    `${internal}#x`,
    internal.replace("/v1/", "/v2/"),
    "cmbcowork://app/anything",
    "https://user:password@example.org/",
    "https://example.org/\0suffix",
    "https://example.org/space here",
    "https://example.org/<html>",
    "https://",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,hello",
    "mailto:user@example.org"
  ])
    expect(botMessageLinkHref(invalid), invalid).toBeNull()
})

it("keeps unsupported or oversized links as readable original text", () => {
  const text = `javascript:alert(1) ${internal}?extra=1 https://user:password@example.org/ https://example.org/${"x".repeat(2048)}`
  expect(botMessageLinkParts(text)).toEqual([{ kind: "text", from: 0, to: text.length, text }])
})

it("bounds interactive spans without truncating messages or accumulating persistent cache", () => {
  const text = Array.from({ length: 2000 }, (_, index) => `https://example.org/${index}`).join(" ")
  const parts = botMessageLinkParts(text)
  expect(parts.filter((part) => part.kind === "link")).toHaveLength(BOT_MESSAGE_MAX_LINKS)
  expect(parts.length).toBeLessThanOrEqual(BOT_MESSAGE_MAX_LINKS * 2 + 1)
  expect(parts.map((part) => part.text).join("")).toBe(text)
})

it("preserves arbitrarily repeated closing punctuation without quadratic slicing", () => {
  const text = `https://example.org/a_(b)${")".repeat(20_000)}. end`
  const parts = botMessageLinkParts(text)
  expect(parts[0]).toMatchObject({ kind: "link", text: "https://example.org/a_(b)" })
  expect(parts.map((part) => part.text).join("")).toBe(text)
})

it("uses no HTML parsing and handles empty/non-link text", () => {
  expect(botMessageLinkParts("")).toEqual([])
  const text = "<img src=x> literal [text](not-a-url) /review"
  expect(botMessageLinkParts(text)).toEqual([{ kind: "text", from: 0, to: text.length, text }])
})

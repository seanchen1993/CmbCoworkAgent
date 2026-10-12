import { expect, it } from "vitest"
import { appendBotMcpHookFeedback } from "./mcp-result"

it("retains provider media, structured fields and error identity beside Hook feedback", () => {
  const content = [
    { type: "image", data: "fixture", mimeType: "image/png" },
    { type: "resource_link", uri: "notes://receipt/one", name: "Receipt" }
  ]
  const result = {
    capabilityId: "connector:notes:read",
    isError: true,
    text: "",
    contentBlocks: content,
    structuredContent: { details: [1, 2] },
    raw: { content, structuredContent: { details: [1, 2] }, isError: true, _meta: { id: "one" } }
  }
  const combined = JSON.parse(appendBotMcpHookFeedback(JSON.stringify(result), "reviewed"))
  expect(combined).toMatchObject({
    capabilityId: result.capabilityId,
    isError: true,
    structuredContent: result.structuredContent,
    raw: { structuredContent: result.raw.structuredContent, isError: true, _meta: { id: "one" } }
  })
  expect(combined.raw.content).toEqual([...content, { type: "text", text: "reviewed" }])
  expect(combined.contentBlocks).toEqual(combined.raw.content)
  expect(combined.text).toBe("reviewed")
})

it.each([
  "[Hook blocked] Needs review",
  '{"capabilityId":"notes","isError":false}\nReplacement text',
  JSON.stringify({ capabilityId: "notes", isError: "false", text: "", raw: {} }),
  JSON.stringify({ capabilityId: "notes", isError: false, text: "", raw: { content: "invalid" } })
])("does not turn a rejected or malformed SDK response into success: %s", (serialized) => {
  expect(() => JSON.parse(appendBotMcpHookFeedback(serialized, "reviewed"))).toThrow()
})

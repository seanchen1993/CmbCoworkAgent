import { describe, expect, it } from "vitest"
import {
  functionHostMessageProps,
  functionHostMessagePublication,
  functionMessageTextMode
} from "./host-message"
import { functionSiteProps } from "./sites"

describe("host-only complete message publication", () => {
  const long = "# Report\n\n" + "paragraph\n\n".repeat(1200)
  it("routes only the original oversized and blank boundaries without changing guest limits", () => {
    expect(functionMessageTextMode("x".repeat(10000))).toBe("ordinary")
    expect(functionMessageTextMode("x".repeat(10001))).toBe("host-message")
    expect(functionMessageTextMode("\n \t\u00a0")).toBe("host-message")
    expect(functionMessageTextMode("\u200b")).toBe("ordinary")
    const input = { text: long, isFirstOfReply: true }
    expect(functionHostMessageProps("AssistantMessage", input)).toEqual(input)
    expect(() => functionSiteProps("AssistantMessage", input)).toThrow("MODS_UI_SITE_PROPS")
  })
  it("preserves the whole Markdown and blank body, with independently copied origin", () => {
    const origin = { kind: "plugin", name: "report", asUser: true }
    const input = { text: long + "[ref]: https://example.test", origin, isExpanded: false }
    const output = functionHostMessageProps("UserMessage", input)
    expect(output).toEqual(input)
    expect(output.origin).not.toBe(origin)
    expect(
      functionHostMessageProps("AssistantMessage", { text: "", isFirstOfReply: false })
    ).toEqual({ text: "", isFirstOfReply: false })
  })
  it.each([
    ["CommandOutput", { text: long, command: "x", args: "", isErrored: false }],
    ["AssistantMessage", { text: long, isFirstOfReply: true, owner: "forged" }],
    ["AssistantMessage", { text: long, isFirstOfReply: 1 }],
    ["AssistantMessage", { text: long }],
    [
      "UserMessage",
      { text: long, isExpanded: true, origin: { kind: "unclassified", name: "extra" } }
    ],
    [
      "UserMessage",
      { text: long, isExpanded: true, origin: { kind: "plugin", name: "x", asUser: false } }
    ],
    [
      "UserMessage",
      { text: long, isExpanded: true, origin: { kind: "unclassified" }, generation: "forged" }
    ]
  ])("rejects unsupported site or identity: %s", (component, value) => {
    expect(() => functionHostMessageProps(component, value)).toThrow("MODS_UI_SITE_PROPS")
  })
  it("retains the existing UTF8 JSON quota and rejects getters without invoking them", () => {
    let reads = 0
    const value = {
      get text() {
        reads++
        return long
      },
      isFirstOfReply: true
    }
    expect(() => functionHostMessageProps("AssistantMessage", value)).toThrow("MODS_JSON_ACCESSOR")
    expect(reads).toBe(0)
    expect(() =>
      functionHostMessageProps("AssistantMessage", {
        text: "中".repeat(350000),
        isFirstOfReply: true
      })
    ).toThrow("MODS_JSON_SIZE")
  })
  it("permits complete body redaction while pinning every identity field", () => {
    const before = {
      text: long,
      origin: { kind: "plugin", name: "author", asUser: true },
      isExpanded: false
    }
    expect(
      functionHostMessagePublication("UserMessage", { ...before, text: "[REDACTED]" }, before)
    ).toEqual({ ...before, text: "[REDACTED]" })
    expect(
      functionHostMessagePublication(
        "UserMessage",
        {
          ...before,
          origin: { asUser: true, name: "author", kind: "plugin" }
        },
        before
      )
    ).toEqual(before)
    for (const changed of [
      { ...before, isExpanded: true },
      { ...before, origin: { kind: "unclassified" } },
      { ...before, origin: { kind: "plugin", name: "other", asUser: true } },
      { ...before, origin: { kind: "plugin", name: "author" } }
    ])
      expect(() => functionHostMessagePublication("UserMessage", changed, before)).toThrow(
        "MODS_UI_NATIVE_PUBLICATION"
      )
    const assistant = { text: long, isFirstOfReply: true }
    expect(() =>
      functionHostMessagePublication(
        "AssistantMessage",
        { ...assistant, isFirstOfReply: false },
        assistant
      )
    ).toThrow("MODS_UI_NATIVE_PUBLICATION")
  })
})

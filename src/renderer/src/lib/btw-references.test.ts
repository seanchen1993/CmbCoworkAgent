import { describe, expect, it } from "vitest"
import { appendBtwReferences, readBtwReferences } from "../../../shared/btw-references"
import type { QueuedMessage } from "@/types"
import { addBtwReference, clearBtwReferences, formatBtwMessageForCopy, type BtwReference } from "./btw-references"
import { getQueuedPreview } from "./queued-message-content"

const ref = (text: string, rowId = "r1"): BtwReference => ({ parentId: "p", rowId, role: "assistant", text })

describe("辅助对话选区", () => {
  it("round trips only selected text without exposing internal IDs or parsing ordinary Markdown", () => {
    const text = '代码：\n```\n"路径"\n```'
    const encoded = appendBtwReferences("解释这句", [ref(text)])
    expect(readBtwReferences(encoded)).toEqual({ body: "解释这句", quotes: [text] })
    expect(readBtwReferences(encoded + '\n<attachment filename="a.txt" mime="text/plain">正文</attachment>'))
      .toEqual({ body: "📎 a.txt\n\n解释这句", quotes: [text] })
    expect(encoded).not.toContain("parentId")
    expect(readBtwReferences("正文 # userselect:\n```userselect\n[]\n```").quotes).toEqual([])
    expect(readBtwReferences(appendBtwReferences("", [ref(text)])).body).toBe("")
  })
  it("keeps an empty selection example in the message body", () => {
    const example = "示例\n\n# userselect:\n```userselect\n[]\n```"
    expect(readBtwReferences(example)).toEqual({ body: example, quotes: [] })
  })
  it("retains a literal attachment example in the body of a reference-bearing draft", () => {
    const body = '示例 <attachment filename="a.txt">文本</attachment>'
    expect(readBtwReferences(appendBtwReferences(body, [ref("原文")]))).toEqual({ body, quotes: ["原文"] })
  })
  it("uses readable quote text for copy and a count for a reference-only queue preview", () => {
    const message: QueuedMessage = { id: "queued", text: "", created_at: new Date(), updated_at: new Date() }
    const quotes = ["第一行\n第二行"]
    const refs = quotes.map(text => ({ text }))
    expect(formatBtwMessageForCopy("解释这句", quotes)).toBe("解释这句\n\n> 第一行\n> 第二行")
    expect(formatBtwMessageForCopy("", quotes)).toBe("> 第一行\n> 第二行")
    expect(formatBtwMessageForCopy("", ["第一行\r\n第二行"])).toBe("> 第一行\r\n> 第二行")
    expect(getQueuedPreview({ ...message, text: appendBtwReferences("解释这句", refs) }, true)).toBe("解释这句")
    const onlyRefs = { ...message, text: appendBtwReferences("", refs), builtinBrowser: true }
    expect(getQueuedPreview(onlyRefs, true)).toBe("1 条注释")
    expect(getQueuedPreview(onlyRefs)).toContain("# userselect:")
  })
  it("deduplicates by source, enforces per-draft limits and consumes only submitted references", () => {
    const first = ref("x".repeat(8000))
    const second = ref(first.text, "r2")
    addBtwReference("side-a", first)
    addBtwReference("side-a", { ...first })
    addBtwReference("side-a", second)
    expect(() => addBtwReference("side-a", ref("y", "r3"))).toThrow()
    clearBtwReferences("side-a", [first])
    expect(() => addBtwReference("side-a", ref("x".repeat(8001)))).toThrow()
    addBtwReference("side-a", ref("y", "r3"))
    addBtwReference("side-b", first)
    clearBtwReferences("side-a")
    clearBtwReferences("side-b")
  })
})

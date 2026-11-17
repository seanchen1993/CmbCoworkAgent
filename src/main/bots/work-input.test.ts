import { describe, expect, it } from "vitest"
import { pageBotWorkInputs } from "./work-input"

describe("host-linked work input paging", () => {
  it("recovers long inputs exactly with bounded pages and explicit continuation", () => {
    const inputs = Array.from({ length: 15 }, (_, i) => ({
      id: String(i),
      role: "user" as const,
      text: `${i}:` + "原始约束".repeat(3200)
    }))
    const recovered: string[] = []
    let index = 0
    while (index < inputs.length) {
      const page = pageBotWorkInputs(inputs, index)
      expect(page.messages.length).toBeLessThanOrEqual(8)
      expect(page.messages.reduce((n, m) => n + m.text.length, 0)).toBeLessThanOrEqual(12000)
      for (const message of page.messages) {
        let text = message.text,
          offset = message.nextOffset
        while (offset !== undefined) {
          const part = pageBotWorkInputs(inputs, message.index, offset).messages[0]
          text += part.text
          offset = part.nextOffset
        }
        recovered.push(text)
      }
      index = page.nextMessageIndex ?? inputs.length
    }
    expect(recovered).toEqual(inputs.map((m) => m.text))
  })

  it("rejects invalid cursors and bounds many short inputs", () => {
    const inputs = Array.from({ length: 20 }, (_, i) => ({
      id: String(i),
      role: "assistant" as const,
      text: "reference"
    }))
    expect(pageBotWorkInputs(inputs)).toMatchObject({ totalMessages: 20, nextMessageIndex: 8 })
    for (const [index, offset] of [
      [-1, 0],
      [20, 0],
      [0, -1],
      [0, 100],
      [NaN, 0],
      [0.5, 0]
    ])
      expect(() => pageBotWorkInputs(inputs, index, offset)).toThrow("位置无效")
  })
})

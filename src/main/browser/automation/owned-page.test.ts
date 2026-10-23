import { EventEmitter } from "node:events"
import type { Page } from "playwright"
import { expect, it, vi } from "vitest"
import { OwnedPageAutomation } from "./owned-page"

it.each(["takeover", "navigation"])(
  "stops the MCP handler's second input when %s happens during the first input",
  async (transition) => {
    let entered!: () => void
    let resume!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const pending = new Promise<void>((resolve) => {
      resume = resolve
    })
    const target = {
      fill: vi.fn(async () => {
        entered()
        await pending
      }),
      press: vi.fn()
    }
    const page = Object.assign(new EventEmitter(), {
      _snapshotForAI: async () => ({ full: '- textbox "姓名" [ref=e1]' }),
      locator: vi.fn(() => target)
    })
    const automation = new OwnedPageAutomation(page as unknown as Page)
    const snapshot = await automation.observe()
    const ref = snapshot.content.match(/\[ref=([^\]]+)\]/)![1]
    let owned = true
    const result = automation.run("browser_type", { ref, text: "张三", submit: true }, () => {
      if (!owned) throw new Error("control changed")
    })
    const rejected = expect(result).rejects.toThrow(
      transition === "takeover" ? "control changed" : "元素引用已失效"
    )
    await started
    if (transition === "takeover") owned = false
    else page.emit("framenavigated")
    resume()
    await rejected
    expect(target.fill).toHaveBeenCalledOnce()
    expect(target.press).not.toHaveBeenCalled()
  }
)

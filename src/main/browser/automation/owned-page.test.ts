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
      ariaSnapshot: async () => '- textbox "姓名" [ref=e1]',
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

function pageFixture() {
  const first = {
    click: vi.fn(),
    dblclick: vi.fn(),
    fill: vi.fn(),
    press: vi.fn(),
    pressSequentially: vi.fn(),
    hover: vi.fn(),
    dragTo: vi.fn(),
    selectOption: vi.fn(),
    setChecked: vi.fn(),
    waitFor: vi.fn(),
    evaluate: vi.fn(async (fn, expr) => fn({ value: 9 }, expr))
  }
  const second = { ...first, fill: vi.fn() }
  const page = Object.assign(new EventEmitter(), {
    ariaSnapshot: vi.fn(async () => '- textbox "one" [ref=e1]\n- button "two" [ref=e2]'),
    locator: vi.fn((selector) => (selector === "aria-ref=e1" ? first : second)),
    getByText: vi.fn(() => ({ first: () => first })),
    keyboard: { press: vi.fn() },
    evaluate: vi.fn(async (fn, expr) => fn(expr))
  })
  const automation = new OwnedPageAutomation(page as unknown as Page)
  return { page, automation, first, second }
}

it("keeps the nine real upstream handlers behind owned refs and preserves evaluation results", async () => {
  const { page, automation, first } = pageFixture()
  const snapshot = await automation.observe()
  const refs = [...snapshot.content.matchAll(/\[ref=([^\]]+)\]/g)].map((m) => m[1])
  const run = (name: string, input: Record<string, unknown>) =>
    automation.run(name, input, () => {})
  await run("browser_click", { ref: refs[0] })
  await run("browser_type", { ref: refs[0], text: "hello", submit: true })
  await run("browser_hover", { ref: refs[0] })
  await run("browser_drag", { startRef: refs[0], endRef: refs[1] })
  await run("browser_select_option", { ref: refs[0], values: ["a"] })
  await run("browser_fill_form", {
    fields: [{ ref: refs[0], name: "Name", type: "textbox", value: "new" }]
  })
  await run("browser_press_key", { key: "Enter" })
  await run("browser_wait_for", { text: "done" })
  expect(await run("browser_evaluate", { function: "() => 7" })).toEqual(["7"])
  expect(
    await run("browser_evaluate", {
      ref: refs[0],
      function: "(element) => element.value"
    })
  ).toEqual(["9"])
  expect(first.click).toHaveBeenCalledOnce()
  expect(first.fill).toHaveBeenCalledTimes(2)
  expect(first.press).toHaveBeenCalledWith("Enter", {})
  expect(first.hover).toHaveBeenCalledOnce()
  expect(first.dragTo).toHaveBeenCalledOnce()
  expect(first.selectOption).toHaveBeenCalledWith(["a"], {})
  expect(first.waitFor).toHaveBeenCalledWith({ state: "visible" })
  expect(page.keyboard.press).toHaveBeenCalledWith("Enter")
  expect(page.ariaSnapshot).toHaveBeenCalledWith({ mode: "ai" })
})

it("rejects new upstream selector targets, other-page refs and non-allowlisted tools", async () => {
  const a = pageFixture(),
    b = pageFixture()
  const own = (await a.automation.observe()).content.match(/\[ref=([^\]]+)\]/)![1]
  const other = (await b.automation.observe()).content.match(/\[ref=([^\]]+)\]/)![1]
  await expect(a.automation.run("browser_click", { target: "button" }, () => {})).rejects.toThrow()
  await expect(a.automation.run("browser_click", { ref: other }, () => {})).rejects.toThrow(
    "属于其他页面"
  )
  await expect(
    a.automation.run("browser_click", { ref: "button", target: own }, () => {})
  ).rejects.toThrow("元素引用已失效")
  await expect(
    a.automation.run("browser_cookie_set", { name: "x", value: "y" }, () => {})
  ).rejects.toThrow("不支持")
  expect(a.first.click).not.toHaveBeenCalled()
})

it("keeps snapshot pagination and invalidates it after navigation", async () => {
  const { page, automation } = pageFixture()
  const text = Array.from(
    { length: 1200 },
    (_, i) => `- button "long label ${i}" [ref=e${i}]`
  ).join("\n")
  page.ariaSnapshot.mockResolvedValue(text)
  let chunk = await automation.observe()
  const chunks = [chunk.content]
  const cursor = chunk.nextCursor
  expect(chunk.truncated).toBe(true)
  while (chunk.nextCursor) {
    chunk = await automation.observe(chunk.nextCursor)
    chunks.push(chunk.content)
  }
  expect(chunks.join("").match(/\[ref=/g)).toHaveLength(1200)
  expect(page.ariaSnapshot).toHaveBeenCalledOnce()
  page.emit("framenavigated")
  await expect(automation.observe(cursor)).rejects.toThrow("游标已失效")
})

it("retains evaluation errors and does not allow an output file through the browser handler", async () => {
  const { automation } = pageFixture()
  await expect(
    automation.run(
      "browser_evaluate",
      { function: '() => { throw new Error("bad page") }' },
      () => {}
    )
  ).rejects.toThrow("bad page")
  await expect(
    automation.run(
      "browser_evaluate",
      { function: "() => 1", filename: "/tmp/blocked.json" },
      () => {}
    )
  ).rejects.toThrow("文件工具")
})

it("waits for loading to disappear before checking the result, even when the result already exists", async () => {
  const { page, automation } = pageFixture()
  let hide!: () => void
  const hidden = new Promise<void>((resolve) => {
    hide = resolve
  })
  const loading = { waitFor: vi.fn(() => hidden) }
  const result = { waitFor: vi.fn(async () => {}) }
  Object.assign(page, {
    getByText: vi.fn((text: string) => ({ first: () => (text === "Loading" ? loading : result) }))
  })
  let completed = false
  const pending = automation
    .run("browser_wait_for", { text: "Done", textGone: "Loading" }, () => {})
    .then(() => {
      completed = true
    })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(completed).toBe(false)
  expect(loading.waitFor).toHaveBeenCalledWith({ state: "hidden" })
  expect(result.waitFor).not.toHaveBeenCalled()
  hide()
  await pending
  expect(result.waitFor).toHaveBeenCalledWith({ state: "visible" })
})

it.each(["control changed", "loading wait failed"])(
  "does not start the second wait after %s",
  async (reason) => {
    const { page, automation } = pageFixture()
    let owned = true
    const loading = {
      waitFor: vi.fn(async () => {
        if (reason === "loading wait failed") throw new Error(reason)
        owned = false
      })
    }
    const result = { waitFor: vi.fn(async () => {}) }
    Object.assign(page, {
      getByText: vi.fn((text: string) => ({ first: () => (text === "Loading" ? loading : result) }))
    })
    await expect(
      automation.run("browser_wait_for", { text: "Done", textGone: "Loading" }, () => {
        if (!owned) throw new Error("control changed")
      })
    ).rejects.toThrow(reason)
    expect(result.waitFor).not.toHaveBeenCalled()
  }
)

import assert from "node:assert/strict"
import type { Page } from "playwright"

const viewportSelector = "[data-chat-scroll] [data-radix-scroll-area-viewport]"
const rowSelector = "[data-testid='virtuoso-item-list'] > [data-item-index]"

export async function verifyStreamingTableScroll(
  page: Page,
  appendTable: (content: string) => Promise<void>
) {
  const viewport = page.locator(viewportSelector)
  const table = viewport.locator("table").filter({ hasText: "表格首行" })
  await appendTable("| 名称 | 状态 |\n| --- | --- |\n| 表格首行 | 正在生成 |\n")
  await table.waitFor()
  await page.waitForFunction((selector) => {
    const node = document.querySelector<HTMLElement>(selector)
    return node && node.scrollHeight - node.clientHeight - node.scrollTop <= 2
  }, viewportSelector)

  await viewport.hover()
  await page.mouse.wheel(0, -520)
  await page.waitForFunction((selector) => {
    const node = document.querySelector<HTMLElement>(selector)
    const table = node?.querySelector("table")
    return node && table && table.getBoundingClientRect().top > node.getBoundingClientRect().bottom
  }, viewportSelector)

  const initial = await table.evaluate((node, selector) => {
    const viewport = node.closest<HTMLElement>(selector)!
    const scrollBy = viewport.scrollBy.bind(viewport)
    const corrections: number[] = []
    const originalTop = viewport.scrollTop
    // Observe native writes without changing the result or replacing the prototype.
    viewport.scrollBy = ((options: ScrollToOptions) => {
      if (options.top) corrections.push(options.top)
      scrollBy(options)
    }) as typeof viewport.scrollBy
    Object.assign(viewport, { tableScrollCorrections: corrections })
    return { top: originalTop, height: node.getBoundingClientRect().height }
  }, viewportSelector)

  // Keep real compositor wheel input active during both the batched IPC chunk
  // and Virtuoso's subsequent ResizeObserver frame.
  const addedRows = Array.from({ length: 12 }, (_, i) => `| 表格增量 ${i} | 完成 |\n`).join("")
  const ticks = 8
  const wheelDelta = -15
  await Promise.all([
    (async () => {
      for (let i = 0; i < ticks; i += 1) {
        await page.mouse.wheel(0, wheelDelta)
        await page.waitForTimeout(15)
      }
    })(),
    (async () => {
      await page.waitForTimeout(32)
      await appendTable(addedRows)
    })()
  ])
  // Keep the growth assertion separate from the scroll assertion, so a fixture
  // that never mounted or measured the off-screen table cannot pass.
  await table.getByText("表格增量 11", { exact: true }).waitFor()
  await viewport.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
  )
  const after = await table.evaluate((node, selector) => {
    const viewport = node.closest<HTMLElement>(selector)! as HTMLElement & {
      tableScrollCorrections: number[]
    }
    const measured = {
      top: viewport.scrollTop,
      height: node.getBoundingClientRect().height,
      corrections: viewport.tableScrollCorrections
    }
    Reflect.deleteProperty(viewport, "scrollBy")
    Reflect.deleteProperty(viewport, "tableScrollCorrections")
    return measured
  }, viewportSelector)
  assert(after.height > initial.height + 150, JSON.stringify({ initial, after }))
  assert(
    Math.abs(after.top - initial.top - ticks * wheelDelta) <= 2,
    JSON.stringify({ initial, after })
  )
  assert(!after.corrections.some((pixels) => pixels > 1), JSON.stringify(after))

  // Reproduce one ResizeObserver batch with both preceding-row growth and
  // additional height below. Only the 56 px before the reading row should count.
  const mixed = await viewport.evaluate(async (viewport, selector) => {
    viewport.scrollTop -= 60
    viewport.dispatchEvent(new Event("scroll"))
    const wheelTop = viewport.scrollTop
    const top = viewport.getBoundingClientRect().top
    const rows = [...viewport.querySelectorAll<HTMLElement>(selector)]
    const before = rows.findLast((row) => row.getBoundingClientRect().bottom < top - 2)
    const anchor = rows.find((row) => row.getBoundingClientRect().bottom > top)
    const below = viewport.querySelector("table")?.closest<HTMLElement>(selector)
    if (
      !before ||
      !anchor ||
      !below ||
      below.getBoundingClientRect().top <= viewport.getBoundingClientRect().bottom
    ) {
      throw new Error("The mixed resize fixture needs mounted rows above and below the viewport")
    }
    const oldAnchorTop = anchor.getBoundingClientRect().top
    const oldBefore = before.style.paddingBottom
    const oldBelow = below.style.paddingBottom
    before.style.paddingBottom = `${parseFloat(getComputedStyle(before).paddingBottom) + 56}px`
    below.style.paddingBottom = `${parseFloat(getComputedStyle(below).paddingBottom) + 175}px`
    await new Promise<void>((done) => {
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => done())))
    })
    const result = {
      compensation: viewport.scrollTop - wheelTop,
      anchorMovement: anchor.getBoundingClientRect().top - oldAnchorTop
    }
    before.style.paddingBottom = oldBefore
    below.style.paddingBottom = oldBelow
    return result
  }, rowSelector)
  assert(Math.abs(mixed.compensation - 56) <= 2, JSON.stringify(mixed))
  assert(Math.abs(mixed.anchorMovement) <= 2, JSON.stringify(mixed))

  // A deliberate downward gesture can still reattach, and more streamed rows
  // must stay followed after it returns to the bottom.
  await page.mouse.wheel(0, 4000)
  await page.waitForFunction((selector) => {
    const node = document.querySelector<HTMLElement>(selector)
    return node && node.scrollHeight - node.clientHeight - node.scrollTop <= 2
  }, viewportSelector)
  await appendTable("| 重新跟随 | 保持底部 |\n")
  await table.getByText("重新跟随", { exact: true }).waitFor()
  await page.waitForFunction((selector) => {
    const node = document.querySelector<HTMLElement>(selector)
    return node && node.scrollHeight - node.clientHeight - node.scrollTop <= 2
  }, viewportSelector)
  return {
    wheel: {
      expectedDisplacement: ticks * wheelDelta,
      displacement: after.top - initial.top,
      tableGrowth: after.height - initial.height,
      corrections: after.corrections
    },
    mixed
  }
}

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * 项目列表用 table-fixed + <colgroup> 钉死列宽，所以 <col> 个数必须和表头单元格个数
 * 一一对应。少一个 col 不会报任何错，页面照常渲染，但从缺口那一列起后面全部左移一格：
 * 每列拿到的是左邻居的宽度，最后一列只能分到 min-w 减去 col 宽度之和的零头。
 *
 * 实际发生过一次：新增「Harness / VibeCoding 采纳行数」列时改了 th、td 和
 * tableColumnCount，唯独没往 colgroup 里补 col。结果「系统约束 / 运行时 Hook」只拿到
 * 110px（本该是 190px），nowrap 的表头溢出 42px 盖到「创建人」上，正文那两行右对齐内容
 * 反向溢出压在「采纳行数」上，「操作」列被挤到 14px。
 *
 * 这类问题类型检查和渲染测试都发现不了，只能盯住源码里这三个数字的一致性。
 */

const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "./ProjectModePanel.tsx"),
  "utf8"
)

/** 可选列由 showSuspectedTechnicalDetailMetric 控制，表头和 colgroup 里各有一处。 */
const OPTIONAL_FLAG = "showSuspectedTechnicalDetailMetric"

function sliceBetween(text: string, open: string, close: string): string {
  const start = text.indexOf(open)
  if (start < 0) throw new Error(`源码里找不到 ${open}`)
  const end = text.indexOf(close, start)
  if (end < 0) throw new Error(`源码里找不到 ${close}`)
  return text.slice(start + open.length, end)
}

/** 文件里不止一张表，先切到项目列表那张：它是唯一带 colgroup 的。 */
const table = (() => {
  const at = source.indexOf("<colgroup>")
  if (at < 0) throw new Error("项目列表表格应当有 colgroup")
  if (source.indexOf("<colgroup>", at + 1) >= 0) {
    throw new Error("出现了第二个 colgroup，这里的切法需要跟着改")
  }
  return source.slice(at)
})()

/** colgroup 里每个 <col> 的宽度，以及它是不是那个可选列。 */
function readColumnWidths(): Array<{ width: number; optional: boolean }> {
  const block = sliceBetween(table, "<colgroup>", "</colgroup>")
  return block
    .split("\n")
    .filter((line) => line.includes("<col "))
    .map((line) => {
      const match = /w-\[(\d+)px\]/.exec(line)
      expect(match, `<col> 没写死宽度：${line.trim()}`).not.toBeNull()
      return { width: Number(match![1]), optional: line.includes(OPTIONAL_FLAG) }
    })
}

/** thead 第一行里每个表头单元格的起始下标；SortableTh 是包了排序箭头的 th。 */
function headerCellOffsets(): number[] {
  const block = sliceBetween(table, "<thead>", "</thead>")
  const offsets: number[] = []
  for (const match of block.matchAll(/<(?:th|SortableTh)[\s>]/g)) {
    offsets.push(match.index)
  }
  return offsets
}

function countHeaderCells(): number {
  return headerCellOffsets().length
}

/** 按表头文字定位它是第几列，免得列宽断言写死下标，插一列就悄悄错位。 */
function headerIndexOf(label: string): number {
  const block = sliceBetween(table, "<thead>", "</thead>")
  const at = block.indexOf(label)
  expect(at, `表头里找不到「${label}」`).toBeGreaterThan(-1)
  const index = headerCellOffsets().filter((offset) => offset <= at).length - 1
  expect(index, `「${label}」不在任何表头单元格里`).toBeGreaterThanOrEqual(0)
  return index
}

function readDeclaredCounts(): { withOptional: number; withoutOptional: number } {
  const match = new RegExp(`const tableColumnCount = ${OPTIONAL_FLAG} \\? (\\d+) : (\\d+)`).exec(
    source
  )
  expect(match, "找不到 tableColumnCount 的声明").not.toBeNull()
  return { withOptional: Number(match![1]), withoutOptional: Number(match![2]) }
}

function readMinWidths(): { withOptional: number; withoutOptional: number } {
  const match = new RegExp(
    `${OPTIONAL_FLAG} \\? "min-w-\\[(\\d+)px\\]" : "min-w-\\[(\\d+)px\\]"`
  ).exec(source)
  expect(match, "找不到表格的 min-w 声明").not.toBeNull()
  return { withOptional: Number(match![1]), withoutOptional: Number(match![2]) }
}

describe("项目列表的列宽网格", () => {
  it("colgroup 的 col 个数和表头单元格个数一致", () => {
    // 对不上就是漏了 col，列宽会整体左移；这是本文件存在的理由。
    expect(readColumnWidths()).toHaveLength(countHeaderCells())
  })

  it("col 个数和 colSpan 用的 tableColumnCount 对得上", () => {
    // tableColumnCount 是空状态/错误行的 colSpan，和列数同源但分开写的，容易只改一头。
    const widths = readColumnWidths()
    const declared = readDeclaredCounts()
    const optionalCount = widths.filter((col) => col.optional).length

    expect(optionalCount, "可选列在 colgroup 里应当只有一个").toBe(1)
    expect(widths).toHaveLength(declared.withOptional)
    expect(widths.length - optionalCount).toBe(declared.withoutOptional)
  })

  it("min-w 等于各列宽度之和", () => {
    // min-w 小于列宽之和时，table-fixed 会把差额按比例从各列扣掉，nowrap 的表头随即溢出；
    // 大于则多出来的宽度被摊到各列上，不至于坏，但说明这两个数字已经不同源了。
    const widths = readColumnWidths()
    const minWidth = readMinWidths()
    const total = widths.reduce((sum, col) => sum + col.width, 0)
    const optional = widths.filter((col) => col.optional).reduce((sum, col) => sum + col.width, 0)

    expect(total).toBe(minWidth.withOptional)
    expect(total - optional).toBe(minWidth.withoutOptional)
  })

  it("表头 nowrap 的列宽不小于实测所需宽度", () => {
    // 这几列表头是 whitespace-nowrap 的长字符串，列宽不够就直接盖到右边列上。
    // 数字是在应用真实字体（Inter / text-xs / px-3）下量出来的 max-content 宽度，
    // 量的是表头和正文两者中较宽的那个，留作改列宽时的下限参考。
    const required: Array<{ label: string; min: number }> = [
      { label: "Harness / VibeCoding 采纳率", min: 189 },
      { label: "Harness / VibeCoding 采纳行数", min: 201 },
      { label: "系统约束 / 运行时 Hook", min: 180 }
    ]
    const widths = readColumnWidths()

    for (const { label, min } of required) {
      const width = widths[headerIndexOf(label)]?.width
      expect(width, `「${label}」这一列宽度不足`).toBeGreaterThanOrEqual(min)
    }
  })
})

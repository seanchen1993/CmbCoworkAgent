import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BotOfficeFilePreview } from "../components/bots/BotOfficeFilePreview"
import {
  OFFICE_PREVIEW_MAX_COLUMNS,
  OFFICE_PREVIEW_MAX_NODES,
  OFFICE_PREVIEW_MAX_ROWS,
  OFFICE_PREVIEW_MAX_SHEETS,
  type WorkspaceOfficePreviewData
} from "../../../shared/workspace-file-preview"

const text = (value: string) => ({ nodeType: 3, textContent: value }) as ChildNode
function element(
  tagName: string,
  childNodes: ChildNode[] = [],
  attributes: Record<string, string> = {}
) {
  return {
    nodeType: 1,
    tagName,
    childNodes,
    getAttribute: (name: string) => attributes[name] ?? null
  } as unknown as ChildNode
}
function renderNodes(nodes: ChildNode[]) {
  vi.stubGlobal(
    "DOMParser",
    class {
      parseFromString() {
        return { querySelector: () => ({ content: { childNodes: nodes } }) }
      }
    }
  )
  const html = renderToStaticMarkup(
    createElement(BotOfficeFilePreview, {
      filePath: "核对报告.docx",
      preview: { kind: "docx", html: "<p>fixture</p>" }
    })
  )
  return { html, truncated: html.includes("仅展示部分内容") }
}
function renderWorkbook(
  sheets: Extract<WorkspaceOfficePreviewData, { kind: "spreadsheet" }>["sheets"],
  truncated = false
) {
  return renderToStaticMarkup(
    createElement(BotOfficeFilePreview, {
      filePath: "核对报告.xlsx",
      preview: { kind: "spreadsheet", sheets, truncated }
    })
  )
}

afterEach(() => vi.unstubAllGlobals())

describe("Bot Office safe content projection", () => {
  it("retains Chinese headings, lists, table cells and safe spans while discarding source attributes", () => {
    const { html, truncated } = renderNodes([
      element("h1", [text("核对报告")], { style: "position:fixed", onclick: "alert(1)" }),
      element("ol", [element("li", [text("退款 -7.20，合计 74.13")])]),
      element("table", [
        element("tbody", [
          element("tr", [
            element("td", [text("金额")], { colspan: "2", rowspan: "3", onmouseover: "alert(1)" })
          ])
        ])
      ])
    ])
    expect(html).toContain("核对报告</h1>")
    expect(html).toContain("<ol")
    expect(html).toContain("<li>退款 -7.20，合计 74.13</li>")
    expect(html).toContain('colSpan="2" rowSpan="3"')
    expect(html).not.toMatch(/onclick|onmouseover|position:fixed|style=/i)
    expect(truncated).toBe(false)
  })

  it("removes executable/resource subtrees and turns links into escaped plain content", () => {
    const blocked = [
      "script",
      "style",
      "link",
      "meta",
      "iframe",
      "object",
      "embed",
      "img",
      "picture",
      "video",
      "audio",
      "svg",
      "math",
      "form",
      "input",
      "template"
    ]
    const { html } = renderNodes([
      ...blocked.map((tag) =>
        element(tag, [text(`blocked-${tag}`)], {
          src: "file:///secret",
          href: "https://example.invalid"
        })
      ),
      element("a", [text('<img src="file:///secret">来源')], {
        href: "javascript:alert(1)",
        target: "_blank"
      }),
      element("div", [element("span", [text("中文正文")])])
    ])
    expect(html).toContain("&lt;img src=&quot;file:///secret&quot;&gt;来源中文正文</div>")
    expect(html).not.toMatch(/blocked-|<a\b|<img\b|href=|javascript:/)
  })

  it.each(["0", "-1", "101", "999999", "2e1", "2.5", "01", " 2", '2" onclick="x'])(
    "rejects unsafe table span %s",
    (span) => {
      const { html } = renderNodes([
        element("table", [
          element("tbody", [
            element("tr", [element("td", [text("单元格")], { colspan: span, rowspan: span })])
          ])
        ])
      ])
      expect(html).not.toMatch(/colSpan|rowSpan/)
      expect(html).toContain("单元格</td>")
    }
  )

  it("keeps DOMParser input inside an inert template even when input contains closing template tags", () => {
    const parseFromString = vi.fn(() => ({
      querySelector: () => ({ content: { childNodes: [element("p", [text("来源")])] } })
    }))
    vi.stubGlobal(
      "DOMParser",
      class {
        parseFromString = parseFromString
      }
    )
    const html = renderToStaticMarkup(
      createElement(BotOfficeFilePreview, {
        filePath: "来源.docx",
        preview: {
          kind: "docx",
          html: '<p>来源</p></TeMpLaTe ><img src="https://example.invalid/x"><iframe src="file:///x">'
        }
      })
    )
    const [source, mime] = parseFromString.mock.calls[0] as unknown as [string, string]
    expect(mime).toBe("text/html")
    expect(source.startsWith("<template>")).toBe(true)
    expect(source.match(/<\/template/gi)).toHaveLength(1)
    expect(source).toContain("&lt;/template >")
    expect(html).toContain("来源</p>")
  })

  it("caps projected nodes and deeply nested content with an explicit truncation result", () => {
    const bounded = renderNodes(
      Array.from({ length: OFFICE_PREVIEW_MAX_NODES + 1 }, (_, index) => text(`#${index}#`))
    )
    expect(bounded.truncated).toBe(true)
    expect(bounded.html).toContain(`#${OFFICE_PREVIEW_MAX_NODES - 1}#`)
    expect(bounded.html).not.toContain(`#${OFFICE_PREVIEW_MAX_NODES}#`)
    let nested = text("too deep")
    for (let index = 0; index < 100; index++) nested = element("span", [nested])
    const deep = renderNodes([nested])
    expect(deep.truncated).toBe(true)
    expect(deep.html).not.toContain("too deep")
  })
})

describe("Bot spreadsheet content preview", () => {
  it("uses workbook tabs and escapes cell content without calculating formulas", () => {
    const html = renderWorkbook([
      {
        name: "明细",
        rows: [['<img src=x onerror="alert(1)">', "=SUM(B2:B4)（未计算）", "74.13"]],
        truncated: false
      },
      { name: "汇总", rows: [["second sheet"]], truncated: false }
    ])
    expect(html).toContain('role="tablist"')
    expect(html).toContain('role="tabpanel"')
    expect(html).toContain("明细</button>")
    expect(html).toContain("汇总</button>")
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;")
    expect(html).not.toContain("<img")
    expect(html).toContain("=SUM(B2:B4)（未计算）")
    expect(html).not.toContain("second sheet")
  })

  it("bounds rows, columns and sheet tabs and makes truncation visible", () => {
    const row = Array.from(
      { length: OFFICE_PREVIEW_MAX_COLUMNS + 1 },
      (_, index) => `column-${index}`
    )
    const sheets = Array.from({ length: OFFICE_PREVIEW_MAX_SHEETS + 1 }, (_, index) => ({
      name: `sheet-${index}`,
      rows: Array.from({ length: OFFICE_PREVIEW_MAX_ROWS + 1 }, () => row),
      truncated: false
    }))
    const html = renderWorkbook(sheets)
    expect(html.match(/<tr>/g)).toHaveLength(OFFICE_PREVIEW_MAX_ROWS)
    expect(html.match(/<td\b/g)).toHaveLength(OFFICE_PREVIEW_MAX_ROWS * OFFICE_PREVIEW_MAX_COLUMNS)
    expect(html.match(/role="tab"/g)).toHaveLength(OFFICE_PREVIEW_MAX_SHEETS)
    expect(html).not.toContain(`column-${OFFICE_PREVIEW_MAX_COLUMNS}`)
    expect(html).toContain("仅展示部分行、列或工作表")
  })

  it("shows empty sheets and upstream truncation without inventing data", () => {
    expect(renderWorkbook([])).toContain("工作表为空")
    expect(renderWorkbook([{ name: "空表", rows: [], truncated: true }])).toContain(
      "请下载查看完整工作簿"
    )
    expect(renderWorkbook([{ name: "空表", rows: [], truncated: false }], true)).toContain(
      "请下载查看完整工作簿"
    )
  })
})

import { runInNewContext } from "node:vm"
import { describe, expect, it } from "vitest"
import { tweakSourceDiagnostics } from "../../../shared/design-tweaks"
import {
  buildDesignValidationRepairPrompt,
  formatDesignBrowserValidation,
  injectDesignBrowserValidationProbe,
  parseDesignBrowserRuntimeIssue
} from "./browser-validation-feedback"

describe("actionable Design validation feedback", () => {
  const html = `<!doctype html>
<html><head><style>
:root { --accent-b: #b45309; }
.b-button { background: #b45309; }
</style></head><body><button class="b-button">撤销</button>
<script type="application/design-tweaks+json">{"defaults":{"accent":"#b45309"},"schema":{"accent":{"type":"color","label":"强调色"}},"bindings":{"accent":[{"type":"css-var","name":"--accent-b"}]}}</script>
</body></html>`

  it("locates the observed unused accent binding and supplies the existing CSS plus a concrete fix", () => {
    const report = formatDesignBrowserValidation(
      { ok: false, issues: [{ type: "structure", message: "accent 未引用 CSS 变量 --accent-b" }] },
      { html, filePath: "/source.html" }
    )
    expect(report).toContain("3: :root { --accent-b: #b45309; }")
    expect(report).toContain("4: .b-button { background: #b45309; }")
    expect(report).toContain("var(--accent-b)")
    expect(report).toContain("定位：/source.html")
    const prompt = buildDesignValidationRepairPrompt(report, "/repair.html")
    expect(prompt).toContain(report)
    expect(prompt).toContain("唯一修复目标（文件已存在）")
    expect(prompt).toContain("只对上述唯一目标使用 edit_file")
    expect(prompt).not.toContain("先读取失败的 HTML")
  })

  it("keeps the invalid raw parameter and tells the model exactly which field to fix", () => {
    const source = html.replace('"type":"color"', '"type":"integer"')
    const report = formatDesignBrowserValidation(
      {
        ok: false,
        issues: tweakSourceDiagnostics(source).map((issue) => ({ type: "structure", ...issue }))
      },
      { html: source, filePath: "/old.html", repairTargetPath: "/repair.html" }
    )
    expect(report).toContain('schema["accent"].type')
    expect(report).toContain('"default":"#b45309"')
    expect(report).toContain('"type":"integer"')
    expect(report).toContain("整数也使用 number")
    expect(report).toContain("新增 DOM 节点不能修复")
    expect(report).not.toContain("/old.html")
  })

  it("shows business JS reads without pretending they implement live visual bindings", () => {
    const source = html
      .replaceAll("accent-b", "max-quick")
      .replaceAll("#b45309", "10")
      .replaceAll('"accent"', '"maxQuick"')
      .replace('"type":"color"', '"type":"number"')
      .replace(
        "</body>",
        "<script>const max = Number(getComputedStyle(document.documentElement).getPropertyValue('--max-quick'));</script></body>"
      )
    const report = formatDesignBrowserValidation(
      {
        ok: false,
        issues: [{ type: "structure", message: "maxQuick 未引用 CSS 变量 --max-quick" }]
      },
      { html: source, filePath: "/repair.html" }
    )
    expect(report).toContain("getPropertyValue('--max-quick')")
    expect(report).toContain("defaults、schema、bindings 三处同时移除")
    expect(report).toContain("保留原 CSS 变量值与业务 JS")
    expect(report).toContain("无关样式")
  })

  it("maps Windows validation URLs to the single repair target, retaining external errors", () => {
    const original = "<html>\n<script>missing();</script>\n</html>"
    const checked = "<html>\n<script>injected();</script>\n<script>missing();</script>\n</html>"
    const report = formatDesignBrowserValidation(
      {
        ok: false,
        issues: [
          {
            type: "console",
            message: "missing",
            source: "file:///d:/design/checked%20draft.html",
            line: 3,
            stack:
              "Error: missing\n at file:///d:/design/checked%20draft.html:3:1\n at https://cdn.example/lib.js:8:4"
          },
          {
            type: "console",
            message: "injected",
            source: "file:///D:/design/checked%20draft.html",
            line: 2
          },
          { type: "console", message: "external", source: "https://cdn.example/lib.js", line: 8 }
        ]
      },
      {
        html: original,
        filePath: "D:\\design\\old.html",
        validationHtml: checked,
        validationPath: "D:\\design\\checked draft.html",
        repairTargetPath: "D:\\design\\repair.html"
      }
    )
    expect(report).toContain("原始源码定位：D:\\design\\repair.html:2")
    expect(report).toContain("校验时源码片段:2")
    expect(report).toContain("不能直接用作修复草稿行号")
    expect(report).toContain("https://cdn.example/lib.js:8")
    expect(report).not.toMatch(/old\.html|checked(?:%20| )draft\.html/)
  })

  it("captures runtime line, column and stack from the error event, rather than the logging probe", () => {
    const handlers: Record<string, (event: object) => void> = {}
    const logged: string[] = []
    const injected = injectDesignBrowserValidationProbe(html)
    const probe = injected.match(/<script>([\s\S]*?)<\/script>/)![1]
    runInNewContext(probe, {
      window: {
        addEventListener: (name: string, fn: (event: object) => void) => {
          handlers[name] = fn
        }
      },
      console: { error: (message: string) => logged.push(message) }
    })
    handlers.error({
      message: "missing is not defined",
      filename: "file:///checked.html",
      lineno: 42,
      colno: 9,
      error: { stack: "ReferenceError: missing\n at checked.html:42:9" }
    })
    const issue = parseDesignBrowserRuntimeIssue(logged[0], { source: "probe.html", line: 1 })!
    expect(issue).toMatchObject({
      type: "console",
      source: "file:///checked.html",
      line: 42,
      column: 9
    })
    expect(issue.stack).toContain("checked.html:42:9")
    handlers.unhandledrejection({ reason: new Error("request failed") })
    expect(parseDesignBrowserRuntimeIssue(logged[1])?.message).toBe("request failed")
    expect(parseDesignBrowserRuntimeIssue("normal console output")).toBeUndefined()
    expect(
      parseDesignBrowserRuntimeIssue("[DesignValidationError] legacy error", { line: 7 })?.line
    ).toBe(7)
  })

  it("maps a browser error back to an unambiguous original source line", () => {
    const source = "<html><head></head><body>\n<script>missing();</script>\n</body></html>"
    const checked = injectDesignBrowserValidationProbe(source)
    const line = checked.split("\n").findIndex((text) => text.includes("missing();")) + 1
    const report = formatDesignBrowserValidation(
      {
        ok: false,
        issues: [
          {
            type: "console",
            message: "missing is not defined",
            source: "file:///checked.html",
            line,
            column: 9
          }
        ]
      },
      {
        html: source,
        filePath: "/source.html",
        validationHtml: checked,
        validationPath: "/checked.html"
      }
    )
    expect(report).toContain("原始源码定位：/source.html:2")
    expect(report).toContain("2: <script>missing();</script>")
  })

  it("keeps every failure and never attributes external dependency lines to the generated page", () => {
    const report = formatDesignBrowserValidation(
      {
        ok: false,
        issues: [
          ...Array.from({ length: 9 }, (_, i) => ({
            type: "structure" as const,
            message: `issue ${i}`
          })),
          { type: "console", message: "CDN error", source: "https://example.com/lib.js", line: 3 }
        ]
      },
      { html, filePath: "/source.html" }
    )
    expect(report).toContain("9. [structure] issue 8")
    expect(report).toContain("https://example.com/lib.js:3")
    expect(report).not.toContain("原始源码定位：/source.html:3")
  })
})

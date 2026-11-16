import { describe, expect, it } from "vitest"
import { parse } from "parse5"
import { insertDesignBodyScript, htmlElements } from "./design-html-mutations"
import { ensureEditMode } from "./design-legacy-edit-mode"
import { decorateDesignNodes, designSourceNodes } from "./design-node-ids"
import { materializeTweaks } from "./design-tweaks"

const business =
  'const printHtml="<html><head><style>:root{--fake:#ffffff}</style></head><body>打印</body></html>";function contact(c){return `<p>${c.task}</p>`;}window.ready=true;'
const scriptTexts = (html: string) =>
  htmlElements(parse(html))
    .filter((node) => node.tagName === "script")
    .map((node) => node.childNodes.map((child) => ("value" in child ? child.value : "")).join(""))
describe("structural design HTML edits", () => {
  it.each(["", ":root{--brand:#123456}", "p{color:#123456;font-size:14px}"])(
    "preserves business scripts containing tag-shaped strings: %s",
    (css) => {
      const html = `<!doctype html><html><head><style>${css}</style></head><body><h1>中文</h1><!-- </body> --><script>${business}</script></body></html>`
      const prepared = ensureEditMode(html)
      expect(scriptTexts(prepared)).toContain(business)
      expect(prepared).not.toContain('"fake":')
      expect(ensureEditMode(prepared)).toBe(prepared)
      expect(htmlElements(parse(prepared)).filter((node) => node.tagName === "p")).toHaveLength(0)
    }
  )
  it.each(["<p>隐式标签", "<html><body><p>省略结束标签</html>"])(
    "supports omitted closing tags and replaces its own script: %s",
    (html) => {
      const once = insertDesignBodyScript(html, 'window.x="</script>"', "data-design-test")
      const twice = insertDesignBodyScript(once, "window.x=2", "data-design-test")
      expect(scriptTexts(once)).toEqual(['window.x="<\\/script>"'])
      expect(scriptTexts(twice)).toEqual(["window.x=2"])
    }
  )
  it("preserves node identities at large sizes and is idempotent", () => {
    const html =
      "<html><body>" +
      Array.from({ length: 20000 }, (_, i) => `<div id="item-${i}">内容</div>`).join("") +
      "</body></html>"
    const ids = designSourceNodes(html).map((node) => node.id)
    const decorated = decorateDesignNodes(html)
    expect(designSourceNodes(decorated).map((node) => node.id)).toEqual(ids)
    expect(decorateDesignNodes(decorated)).toBe(decorated)
    expect(materializeTweaks(decorated)).toBe(decorated)
  })
})

it("reports malformed source JS instead of presenting it as a repaired import", () => {
  expect(() =>
    ensureEditMode('<html><body><script>const printHtml="broken</script>code</body></html>')
  ).toThrow("页面脚本无法解析")
})

it("recognizes legacy defaults inside an IIFE while ignoring declarations quoted in strings", () => {
  const js =
    '(function(){const example="const TWEAK_DEFAULTS={fake:1}"; const TWEAK_DEFAULTS={brand:"#123456"}; window.defaults=TWEAK_DEFAULTS;})()'
  const result = ensureEditMode(`<html><body><script>${js}</script></body></html>`)
  expect(scriptTexts(result)).toEqual([
    js.replace('{brand:"#123456"}', '/*EDITMODE-BEGIN*/{brand:"#123456"}/*EDITMODE-END*/')
  ])
})

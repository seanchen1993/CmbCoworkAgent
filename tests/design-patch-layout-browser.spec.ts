/** Real layout regressions for Comment/Draw's local patch validation. */
import assert from "node:assert/strict"
import { chromium } from "playwright"
import {
  compareDesignPatchLayouts,
  designPatchLayoutProbe
} from "../src/main/services/design/artifact-validator"
import { executeDesignPatch } from "../src/main/services/design/patch-executor"
import { designSourceNodes, designAttr, decorateDesignNodes } from "../src/shared/design-node-ids"
import { sourceHash } from "../src/main/services/design/document-index"

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined
})
try {
  const page = await browser.newPage()
  const inspect = async (styles: string) => {
    await page.setContent(`<!doctype html><html><head><style>
      body { margin: 0; } #parent { width: 200px; height: 40px; }
      #child { width: 100px; height: 20px; } ${styles}
      </style></head><body><div id="parent" data-design-node="parent">
      <div id="child" data-design-node="child">内容</div></div></body></html>`)
    return page.evaluate(designPatchLayoutProbe)
  }
  for (const width of [1200, 390]) {
    await page.setViewportSize({ width, height: 900 })
    const before = await inspect("")
    for (const [name, css] of [
      ["vertical movement", "#child { margin-top: 50px; }"],
      ["vertical growth", "#child { height: 100px; }"],
      ["horizontal scrolling", "#parent { overflow-x: auto; } #child { width: 280px; }"],
      ["hidden content", "#parent { overflow: hidden; } #child { width: 280px; }"],
      ["clipped content", "#parent { overflow: clip; } #child { width: 280px; }"]
    ]) {
      const after = await inspect(css)
      assert.deepEqual(
        compareDesignPatchLayouts(before, after, new Set(["parent", "child"])),
        [],
        `${name} must not be reported as horizontal overflow at ${width}px`
      )
    }
    for (const css of ["#child { width: 280px; }", "#child { margin-left: -20px; }"]) {
      const after = await inspect(css)
      assert.ok(compareDesignPatchLayouts(before, after, new Set(["child"])).length > 0)
      assert.ok(after.horizontalOverflow.includes("parent:child"))
    }
    const documentOverflow = await inspect(`#child { width: ${width + 50}px; }`)
    assert.ok(documentOverflow.horizontalOverflow.includes("document"))
    assert.deepEqual(
      compareDesignPatchLayouts(documentOverflow, documentOverflow, new Set()),
      [],
      "existing overflow must not be attributed to the patch"
    )
    const mobile = await inspect("@media(max-width: 500px) { #child { width: 450px; } }")
    assert.equal(mobile.horizontalOverflow.includes("document"), width === 390)
  }

  // Exercise detection → model repair → parent context → combined patch → real browser recheck.
  const html = `<!doctype html><html><head><style>
    body{margin:0}section{display:flex;width:200px;gap:20px}button{white-space:nowrap}
    </style></head><body><section id="controls" data-design-section="controls">
    <button id="action">保存</button><span>状态</span></section></body></html>`
  const nodes = designSourceNodes(html)
  const button = nodes.find((node) => designAttr(node.element, "id") === "action")!
  const parent = nodes.find((node) => designAttr(node.element, "id") === "controls")!
  const longLabel = "保存这次调整后的完整设计，并保留所有页面内容。".repeat(4)
  const nodeOp = (node: typeof button, rest: object) => ({
    targetId: node.id, expectedHash: sourceHash(html.slice(node.start, node.end)), ...rest
  })
  const measure = async (content: string, width: number) => {
    await page.setViewportSize({ width, height: 900 })
    await page.setContent(decorateDesignNodes(content))
    return page.evaluate(designPatchLayoutProbe)
  }
  let modelCalls = 0
  let validations = 0
  const result = await executeDesignPatch({
    html, artifactRevision: 0, tweaks: null, signal: new AbortController().signal,
    instruction: "修改按钮文案，并将字号增大到32px；自动调整布局避免溢出",
    request: { targets: [{ nodeId: button.id }], artifactRevision: 0, variationId: null },
    status: () => {},
    complete: async (messages) => {
      modelCalls++
      const context = JSON.parse(messages[1].content.split("\nHost validation feedback:")[0])
      if (modelCalls > 1) {
        assert.match(messages[1].content, /视口 390px/)
        assert.match(messages[1].content, /可用宽/)
        assert.match(messages[1].content, /overflow-wrap:anywhere/)
        assert.ok(messages[1].content.includes(longLabel))
      }
      if (modelCalls === 2)
        return { content: JSON.stringify({ action: "target", targetIds: [parent.id] }) }
      return { content: JSON.stringify({
        protocol: "design-patch/1", contextId: context.contextId, baseArtifactRevision: 0,
        summary: modelCalls === 1 ? "增大字号并更新文案" : "保留字号和文案，调整容器并自动换行",
        operations: [
          nodeOp(button, { op: "set_text", text: longLabel }),
          nodeOp(button, { op: "set_style", declarations: modelCalls === 1 ? { "font-size": "32px" } : {
            "font-size": "32px", "white-space": "normal", "overflow-wrap": "anywhere",
            "min-width": "0", "max-width": "100%", "box-sizing": "border-box"
          } }),
          ...(modelCalls === 1 ? [] : [nodeOp(parent, { op: "set_style", declarations: { "flex-wrap": "wrap" } })])
        ]
      }) }
    },
    validate: async (candidate) => {
      validations++
      const issues: string[] = []
      for (const width of [1200, 390]) {
        const before = await measure(html, width)
        const after = await measure(candidate.html, width)
        issues.push(...compareDesignPatchLayouts(before, after, new Set(candidate.allowedIds)))
      }
      return issues
    }
  })
  assert.equal(modelCalls, 3)
  assert.equal(validations, 2)
  assert.equal(result.metrics.repairs, 1)
  assert.equal(result.metrics.expansions, 1)
  for (const width of [1200, 390]) {
    assert.deepEqual((await measure(result.candidate.html, width)).horizontalOverflow, [])
    assert.equal(await page.locator("#action").textContent(), longLabel)
    assert.equal(await page.locator("#action").evaluate((el) => getComputedStyle(el).fontSize), "32px")
    assert.equal(await page.locator("#controls span").textContent(), "状态")
  }
  console.log("PASS: local patches automatically repair real overflow by resizing/wrapping, preserve the requested text and font size, and revalidate desktop/mobile layouts")
} finally {
  await browser.close()
}

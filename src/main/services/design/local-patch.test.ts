import { describe, it, expect, vi } from "vitest"
import { AIMessageChunk } from "@langchain/core/messages"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { decorateDesignNodes, designSourceNodes, designAttr } from "../../../shared/design-node-ids"
import { parseDesignPatch, shouldUseDesignPatch } from "../../../shared/design-patch"
import {
  readTweakDeclaration,
  reconcileTweaks,
  effectiveTweaks
} from "../../../shared/design-tweaks"
import { indexDesignDocument, sourceHash, verifyDesignPatchDependencies } from "./document-index"
import { preparePatchContext, DesignPatchScopeError } from "./patch-context"
import { applyDesignPatch } from "./patch-applier"
import {
  executeDesignPatch,
  normalizeDesignPatchReply,
  DESIGN_PATCH_TOOLS,
  readDesignPatchStream
} from "./patch-executor"
import { compareDesignPatchLayouts, withDesignValidationDeadline } from "./artifact-validator"

const page = `<!doctype html><html><head><style>
:root{--brand:#123456;--space:var(--gap);--gap:12px}
.btn{background:var(--brand);padding:var(--space)}
@media(max-width:600px){.btn:hover{padding:8px}}
.unrelated{color:pink}
</style></head><body><section data-design-section="hero"><button id="cta" class="btn"><span id="label">开始</span></button><p id="copy">介绍</p></section><section data-design-section="footer"><button id="other" class="btn">其他</button></section><script>window.businessRuns=(window.businessRuns||0)+1</script></body></html>`
const index = () => indexDesignDocument(page)
const byBusinessId = (id: string) =>
  [...index().nodes.values()].find((n) => designAttr(n.element, "id") === id)!
const context = (id = "cta") =>
  preparePatchContext(
    index(),
    "修改这里",
    { artifactRevision: 2, variationId: null, targets: [{ nodeId: byBusinessId(id).id }] },
    2,
    null
  )
const proposal = (prepared: ReturnType<typeof context>, operations: unknown[]) => ({
  protocol: "design-patch/1",
  contextId: prepared.public.contextId,
  baseArtifactRevision: 2,
  operations,
  summary: "已修改目标"
})
const op = (id: string, rest: Record<string, unknown>) => ({
  targetId: byBusinessId(id).id,
  expectedHash: sourceHash(page.slice(byBusinessId(id).start, byBusinessId(id).end)),
  ...rest
})

describe("local design patches", () => {
  it("decorates preview nodes consistently without changing canonical source or existing IDs", () => {
    const decorated = decorateDesignNodes(page)
    expect(designSourceNodes(decorated).map((n) => n.id)).toEqual(
      designSourceNodes(page).map((n) => n.id)
    )
    expect(decorateDesignNodes(decorated)).toBe(decorated)
    expect(page).not.toContain("data-design-node")
    expect(
      decorateDesignNodes('<html><body><img src="a"/><svg><path d=""/></svg></body></html>')
    ).toContain('src="a" data-design-node=')
  })
  it("uses bounded subtree context with conditional CSS and transitive tokens", () => {
    const prepared = context()
    const text = JSON.stringify(prepared.public)
    expect(prepared.public.targets[0].html).toContain('data-design-node="')
    expect(text).toContain("max-width:600px")
    expect(text).toContain("--gap")
    expect(text).not.toContain("window.businessRuns")
    expect(text).not.toContain('<button id=\\"other')
    expect(prepared.allowed.has(byBusinessId("other").id)).toBe(false)
  })
  it("omits nested executable source and host runtime from local model context", () => {
    const html = page.replace(
      '<p id="copy">介绍</p>',
      '<p id="copy" onclick="secretBusinessLogic()">介绍</p><script>nestedPrivateBusiness()</script>'
    )
    const i = indexDesignDocument(html),
      n = [...i.nodes.values()].find(
        (n) => designAttr(n.element, "data-design-section") === "hero"
      )!
    const p = preparePatchContext(
      i,
      "调整间距",
      { artifactRevision: 2, variationId: null, targets: [{ nodeId: n.id }] },
      2,
      null
    )
    expect(JSON.stringify(p.public)).not.toContain("nestedPrivateBusiness")
    expect(JSON.stringify(p.public)).not.toContain("secretBusinessLogic")
    expect(JSON.stringify(p.public)).toContain("protected script omitted")
  })
  it("rejects stale, ambiguous and wrong-variation anchors", () => {
    expect(() =>
      preparePatchContext(
        index(),
        "x",
        { artifactRevision: 1, variationId: null, targets: [] },
        2,
        null
      )
    ).toThrow("版本")
    expect(() =>
      preparePatchContext(
        index(),
        "x",
        { artifactRevision: 2, variationId: "a", targets: [{ nodeId: byBusinessId("cta").id }] },
        2,
        null
      )
    ).toThrow("目标")
    expect(() =>
      preparePatchContext(
        index(),
        "x",
        { artifactRevision: 2, variationId: null, targets: [{ tagName: "button", text: "" }] },
        2,
        null
      )
    ).toThrow()
  })
  it("changes a single instance while preserving shared CSS, siblings and scripts", () => {
    const prepared = context()
    const result = applyDesignPatch(
      prepared,
      proposal(prepared, [
        op("cta", { op: "set_style", declarations: { "background-color": "red" } }),
        op("label", { op: "set_text", text: "立即开始" })
      ])
    )
    expect(result.html).toContain('style="background-color:red"')
    expect(result.html).toContain('<button id="other" class="btn">其他</button>')
    expect(result.html).toContain("window.businessRuns=(window.businessRuns||0)+1")
    expect(result.patch.mode).toBe("live")
    expect(result.html.slice(0, result.html.indexOf("<body>"))).toBe(
      page.slice(0, page.indexOf("<body>"))
    )
    expect(index().html).toBe(page) // cached AST was not mutated
  })
  it("rejects out-of-scope nodes, wrong hashes, non-leaf text and CSS injection", () => {
    const p = context()
    for (const operation of [
      op("other", { op: "set_text", text: "bad" }),
      op("cta", { op: "set_text", text: "bad" }),
      { ...op("cta", { op: "set_style", declarations: { color: "red" } }), expectedHash: "stale" },
      op("cta", { op: "set_style", declarations: { color: "red;background:black" } })
    ]) {
      expect(() => applyDesignPatch(p, proposal(p, [operation]))).toThrow()
    }
  })
  it("supports structural fragments but protects identity, handlers and bindings", () => {
    const p = context()
    const candidate = applyDesignPatch(
      p,
      proposal(p, [
        op("cta", { op: "replace_fragment", html: '<span id="label">新的标题</span><em>提示</em>' })
      ])
    )
    expect(candidate.patch.mode).toBe("reload")
    for (const html of [
      "<span>missing ID</span>",
      "<script>alert(1)</script>",
      '<img onerror="x()">',
      '<span id="label">x</span><svg><a href="&#x6a;avascript:alert(1)">bad</a></svg>',
      "<html><body>x</body></html>",
      '<span id="label"></span><span id="other"></span>'
    ]) {
      expect(() =>
        applyDesignPatch(p, proposal(p, [op("cta", { op: "replace_fragment", html })]))
      ).toThrow()
    }
    expect(() =>
      applyDesignPatch(
        p,
        proposal(p, [
          op("label", { op: "set_text", text: "x" }),
          op("cta", { op: "replace_fragment", html: '<span id="label">x</span>' })
        ])
      )
    ).toThrow("重叠")
  })
  it("keeps state/media styles scoped and merges repeated declarations", () => {
    const p = context()
    const candidate = applyDesignPatch(
      p,
      proposal(p, [
        op("cta", {
          op: "set_style",
          declarations: { color: "red" },
          state: "hover",
          maxWidth: 600
        }),
        op("cta", {
          op: "set_style",
          declarations: { padding: "8px" },
          state: "hover",
          maxWidth: 600
        })
      ])
    )
    expect(candidate.html).toContain('data-design-patch-style="patch-')
    expect(candidate.html).toContain("color:red;padding:8px")
    expect(candidate.html).toContain(":hover")
    expect(candidate.html).not.toContain("body{color")
  })
  it("accepts var() values and retains existing inline priorities", () => {
    const p = context()
    const result = applyDesignPatch(
      p,
      proposal(p, [op("cta", { op: "set_style", declarations: { color: "var(--brand)" } })])
    )
    expect(result.html).toContain("color:var(--brand)")
  })
  it("tracks external CSS/imports and detects changes before commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "design-css-index-"))
    try {
      writeFileSync(join(dir, "styles.css"), '@import "tokens.css"; .btn{color:var(--tone)}')
      writeFileSync(join(dir, "tokens.css"), ":root{--tone:red}")
      const source = page.replace("</head>", '<link rel="stylesheet" href="styles.css"></head>')
      const indexed = indexDesignDocument(source, join(dir, "index.html"), dir)
      expect(Object.keys(indexed.externalFiles)).toHaveLength(2)
      expect(indexed.unresolved).toEqual([])
      verifyDesignPatchDependencies(indexed.externalFiles)
      writeFileSync(join(dir, "tokens.css"), ":root{--tone:blue}")
      expect(() => verifyDesignPatchDependencies(indexed.externalFiles)).toThrow("样式文件已变化")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it("handles table fragments with the correct parsing context", () => {
    const html =
      '<html><head></head><body><table id="table"><tbody id="rows"><tr><td>x</td></tr></tbody></table></body></html>'
    const i = indexDesignDocument(html),
      n = [...i.nodes.values()].find((n) => designAttr(n.element, "id") === "rows")!
    const p = preparePatchContext(
      i,
      "增加一行",
      { artifactRevision: 2, variationId: null, targets: [{ nodeId: n.id }] },
      2,
      null
    )
    const result = applyDesignPatch(
      p,
      proposal(p, [
        {
          op: "replace_fragment",
          targetId: n.id,
          expectedHash: sourceHash(html.slice(n.start, n.end)),
          html: "<tr><td>new</td></tr>"
        }
      ])
    )
    expect(result.html).toContain('<tbody id="rows"><tr><td>new</td></tr></tbody>')
  })
  it("validates parameters and prevents changes to shared bindings outside the scope", () => {
    const html = page.replace(
      "</head>",
      '<script type="application/design-tweaks+json">{"defaults":{"label":"开始"},"schema":{"label":{"type":"text","label":"文案"}},"bindings":{"label":[{"type":"text","selector":"#label"}]}}</script></head>'
    )
    const i = indexDesignDocument(html),
      n = [...i.nodes.values()].find((n) => designAttr(n.element, "id") === "cta")!
    const state = reconcileTweaks(readTweakDeclaration(html))!
    const p = preparePatchContext(
      i,
      "更新文案",
      { artifactRevision: 2, variationId: null, targets: [{ nodeId: n.id }] },
      2,
      state
    )
    const result = applyDesignPatch(
      p,
      proposal(p, [{ op: "set_tweak", key: "label", value: "新文案" }])
    )
    expect(effectiveTweaks(result.tweaks!).label).toBe("新文案")
    expect(result.html).toBe(html)
    expect(() =>
      applyDesignPatch(p, proposal(p, [{ op: "set_tweak", key: "unknown", value: "x" }]))
    ).toThrow()
  })
  it("enforces protocol bounds and routes explicit global requests to the full executor", () => {
    expect(() =>
      parseDesignPatch({
        ...proposal(context(), []),
        operations: Array(26).fill(op("label", { op: "set_text", text: "x" }))
      })
    ).toThrow()
    expect(shouldUseDesignPatch("把整个页面重新设计")).toBe(false)
    expect(shouldUseDesignPatch("把按钮变红")).toBe(true)
    expect(shouldUseDesignPatch("调整这个布局", true)).toBe(true)
  })
  it("compares visual boundaries while allowing natural downstream vertical movement", () => {
    const before = {
      horizontalOverflow: [],
      styles: { target: ["red"], other: ["blue"] },
      expectations: []
    }
    expect(
      compareDesignPatchLayouts(
        before,
        { ...before, styles: { target: ["black"], other: ["blue"] } },
        new Set(["target"])
      )
    ).toEqual([])
    expect(
      compareDesignPatchLayouts(
        before,
        { ...before, horizontalOverflow: ["document"], styles: { other: ["red"] } },
        new Set(["target"])
      )
    ).toHaveLength(2)
  })
  it("bounds asynchronous browser validation and cancels immediately", async () => {
    const controller = new AbortController()
    const pending = withDesignValidationDeadline(new Promise(() => undefined), controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow("取消")
    await expect(
      withDesignValidationDeadline(new Promise(() => undefined), new AbortController().signal, 1)
    ).rejects.toThrow("超时")
    await expect(
      withDesignValidationDeadline(Promise.resolve(1), new AbortController().signal)
    ).resolves.toBe(1)
  })
})

describe("bounded patch model executor", () => {
  it("assembles streamed tool arguments before parsing and retains usage", async () => {
    const stream = async function* () {
      yield new AIMessageChunk({
        content: "",
        tool_call_chunks: [
          { name: "get_design_context", id: "call1", index: 0, args: '{"targetIds":[' }
        ]
      })
      yield new AIMessageChunk({
        content: "",
        tool_call_chunks: [{ index: 0, args: '"n_1"]}' }],
        usage_metadata: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }
      })
    }
    const reply = normalizeDesignPatchReply(await readDesignPatchStream(stream()))
    expect(JSON.parse(reply.content)).toEqual({ action: "target", targetIds: ["n_1"] })
    expect(reply.inputTokens).toBe(100)
  })
  it("exposes only bounded tools and validates tool replies through the JSON protocol", () => {
    expect(DESIGN_PATCH_TOOLS.map((t) => t.function.name)).toEqual([
      "get_design_context",
      "submit_design_patch",
      "request_design_scope"
    ])
    expect(
      JSON.parse(
        normalizeDesignPatchReply({
          content: "",
          tool_calls: [{ name: "get_design_context", args: { targetIds: ["n_1"] } }]
        }).content
      )
    ).toEqual({ action: "target", targetIds: ["n_1"] })
    expect(
      JSON.parse(
        normalizeDesignPatchReply({
          content: "",
          tool_calls: [{ name: "write_file", args: { path: "/ignored" } }]
        }).content
      )
    ).toEqual({})
    expect(
      JSON.parse(
        normalizeDesignPatchReply({
          content: "",
          tool_calls: [
            { name: "request_design_scope", args: { reason: "扩大范围" } },
            { name: "request_design_scope", args: {} }
          ]
        }).content
      )
    ).toEqual({})
  })
  const options = () => ({
    html: page,
    artifactRevision: 2,
    instruction: "把按钮变红",
    tweaks: null,
    request: {
      artifactRevision: 2,
      variationId: null,
      targets: [{ nodeId: byBusinessId("cta").id }]
    },
    signal: new AbortController().signal,
    status: vi.fn(),
    validate: vi.fn(async () => [] as string[])
  })
  it("submits only local context, repairs bounded failures, and reports token usage", async () => {
    const seen: string[] = []
    const result = await executeDesignPatch({
      ...options(),
      complete: async (messages) => {
        seen.push(JSON.stringify(messages))
        const c = JSON.parse(messages[1].content.split("\nHost validation feedback:")[0])
        return {
          content:
            seen.length === 1
              ? "bad json"
              : JSON.stringify({
                  ...proposal(context(), [
                    op("cta", { op: "set_style", declarations: { color: "red" } })
                  ]),
                  contextId: c.contextId
                }),
          inputTokens: 123,
          outputTokens: 20
        }
      }
    })
    expect(result.metrics.repairs).toBe(1)
    expect(result.metrics.inputTokens).toBe(246)
    expect(
      seen.every((s) => !s.includes("window.businessRuns") && !s.includes("<!doctype html>"))
    ).toBe(true)
  })
  it("selects a target from a bounded directory without loading old model history", async () => {
    let calls = 0
    const result = await executeDesignPatch({
      ...options(),
      request: { artifactRevision: 2, variationId: null, targets: [] },
      complete: async (messages) => {
        const c = JSON.parse(messages[1].content)
        calls++
        if (calls === 1)
          return {
            content: JSON.stringify({ action: "target", targetIds: [c.directory[0].targetId] })
          }
        const target = c.directory.find(
          (n: { targetId: string }) => n.targetId === byBusinessId("label").id
        )
        return {
          content: JSON.stringify({
            protocol: "design-patch/1",
            contextId: c.contextId,
            baseArtifactRevision: 2,
            summary: "更新文案",
            operations: [
              {
                op: "set_text",
                targetId: target.targetId,
                expectedHash: target.hash,
                text: "新文案"
              }
            ]
          })
        }
      }
    })
    expect(result.candidate.html).toContain("新文案")
    expect(result.metrics.expansions).toBe(1)
  })
  it("stops after two repair attempts and never submits a rejected candidate", async () => {
    const complete = vi.fn(async () => ({ content: "{}" }))
    await expect(executeDesignPatch({ ...options(), complete })).rejects.toThrow()
    expect(complete).toHaveBeenCalledTimes(3)
  })
  it("requests full scope explicitly and honors cancellation", async () => {
    await expect(
      executeDesignPatch({
        ...options(),
        complete: async () => ({ content: '{"action":"scope","reason":"需要新增交互"}' })
      })
    ).rejects.toBeInstanceOf(DesignPatchScopeError)
    const controller = new AbortController()
    controller.abort()
    const complete = vi.fn()
    await expect(
      executeDesignPatch({ ...options(), signal: controller.signal, complete })
    ).rejects.toThrow("取消")
    expect(complete).not.toHaveBeenCalled()
  })
})

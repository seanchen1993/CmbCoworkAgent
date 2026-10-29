import { describe, it, expect, vi } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { NativeSqliteAdapter } from "../../db/native-sqlite-adapter"
import { DesignRunManager } from "./run-manager"
import { DesignSessionStore } from "./session-store"
import { createDesignState } from "../../../shared/managed-design-session"
import {
  readTweakDeclaration,
  reconcileTweaks,
  materializeTweaks,
  effectiveTweaks
} from "../../../shared/design-tweaks"
import { applyDirectEdit, inspectEditableSource, prepareEditableSource } from "./direct-edit"
import type { DesignEditCommand, DesignEditableNode } from "../../../shared/design-edit"

const page = (body: string, head = "") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`
const command = (
  node: DesignEditableNode,
  type: "set_text" | "delete_node",
  value = "",
  revision = 0
): DesignEditCommand => ({
  protocol: "design-edit/1",
  commandId: crypto.randomUUID(),
  baseRevision: revision,
  variationId: null,
  operations:
    type === "set_text"
      ? [{ type, nodeId: node.id, expectedHash: node.hash, textSlotId: node.text[0].id, value }]
      : [{ type, nodeId: node.id, expectedHash: node.hash }]
})

describe("direct design source editing", () => {
  it("preserves icon, scripts and unrelated source while editing a text slot", () => {
    const html = prepareEditableSource(
      page(
        '<button id="save"><svg viewBox="0 0 10 10"><path d="M0 0"/></svg>保存</button><p>other</p><script>window.runs=1</script>'
      )
    )
    const doc = inspectEditableSource(html, 0)
    const button = doc.nodes.find((n) => n.tagName === "button")!
    const after = applyDirectEdit(html, null, command(button, "set_text", '<中文 & "文字">')).html
    expect(after).toContain('&lt;中文 &amp; "文字"&gt;')
    expect(after).toContain('<svg viewBox="0 0 10 10"')
    expect(after.slice(after.indexOf("<p "))).toBe(html.slice(html.indexOf("<p ")))
    expect(
      inspectEditableSource(after, 1).nodes.find((n) => n.id === button.id)?.text[0].value
    ).toBe('<中文 & "文字">')
  })
  it("keeps surviving IDs after deleting siblings, rejects stale content and scopes variations", () => {
    const html = prepareEditableSource(
      page(
        '<div id="variation-a"><section><p>first</p><p>second</p></section></div><div id="variation-b"><p>third</p></div>'
      )
    )
    expect(prepareEditableSource(html)).toBe(html)
    const nodes = inspectEditableSource(html, 0).nodes
    const first = nodes.find((n) => n.label === "first" && n.tagName === "p")!
    const second = nodes.find((n) => n.label === "second" && n.tagName === "p")!
    const after = applyDirectEdit(html, null, command(first, "delete_node")).html
    expect(
      inspectEditableSource(after, 1).nodes.find((n) => n.label === "second" && n.tagName === "p")
        ?.id
    ).toBe(second.id)
    expect(() => applyDirectEdit(after, null, command(first, "delete_node"))).toThrow()
    expect(() =>
      applyDirectEdit(html, null, { ...command(first, "delete_node"), variationId: "b" })
    ).toThrow("当前方案")
    expect(after).toContain("third")
  })
  it("edits JSX literals and removes JSX children without changing script logic", () => {
    let html = prepareEditableSource(
      page(
        '<div id="root"></div><script type="text/babel">const App=()=> <main><h1>原标题</h1><button><svg/>保存</button><p>删除我</p></main>;ReactDOM.createRoot(document.getElementById("root")).render(<App/>);</script>'
      )
    )
    expect(prepareEditableSource(html)).toBe(html)
    const heading = inspectEditableSource(html, 0).nodes.find(
      (n) => n.source === "jsx" && n.tagName === "h1"
    )!
    const result = applyDirectEdit(html, null, command(heading, "set_text", "修改后"))
    expect(result.mode).toBe("reload")
    expect(result.html).toContain('{"修改后"}')
    html = result.html
    const paragraph = inspectEditableSource(html, 1).nodes.find(
      (n) => n.source === "jsx" && n.tagName === "p"
    )!
    html = applyDirectEdit(html, null, command(paragraph, "delete_node")).html
    expect(html).not.toContain("删除我")
    expect(html).toContain('ReactDOM.createRoot(document.getElementById("root"))')
    expect(html).toContain("<svg")
  })
  it("edits Vue inline templates, with interpolation and repeated templates protected", () => {
    const html = prepareEditableSource(
      page(
        '<div id="app"></div><script>Vue.createApp({data(){return {n:0}},template:`<main><h1>Vue标题</h1><p>{{n}}</p><ul><li v-for="x in [1,2]">重复</li></ul></main>`}).mount("#app")</script>'
      )
    )
    expect(prepareEditableSource(html)).toBe(html)
    const doc = inspectEditableSource(html, 0)
    const heading = doc.nodes.find((n) => n.source === "vue" && n.tagName === "h1")!
    expect(heading.text[0].value).toBe("Vue标题")
    const after = applyDirectEdit(html, null, command(heading, "set_text", "Vue新标题")).html
    expect(
      inspectEditableSource(after, 1).nodes.find((n) => n.id === heading.id)?.text[0].value
    ).toBe("Vue新标题")
    expect(doc.nodes.find((n) => n.source === "vue" && n.tagName === "li")?.canDelete).toBe(false)
    expect(doc.nodes.find((n) => n.source === "vue" && n.tagName === "p")?.text).toEqual([])
  })
  it("edits and deletes one controlled data record while preserving the other instance", () => {
    const data = {
      data: { records: { a: { title: "甲" }, b: { title: "乙" } } },
      bindings: {
        titleA: { kind: "text", path: "/records/a/title" },
        recordA: { kind: "record", path: "/records/a" },
        titleB: { kind: "text", path: "/records/b/title" }
      }
    }
    let html = prepareEditableSource(
      page(
        '<div id="app"></div>',
        `<script type="application/design-edit+json">${JSON.stringify(data)}</script>`
      )
    )
    expect(html).toContain("data-design-edit-data-runtime")
    let nodes = inspectEditableSource(html, 0).nodes
    html = applyDirectEdit(
      html,
      null,
      command(nodes.find((n) => n.id === "b_titleA")!, "set_text", "新甲")
    ).html
    nodes = inspectEditableSource(html, 1).nodes
    expect(nodes.find((n) => n.id === "b_titleA")?.text[0].value).toBe("新甲")
    html = applyDirectEdit(
      html,
      null,
      command(nodes.find((n) => n.id === "b_recordA")!, "delete_node")
    ).html
    nodes = inspectEditableSource(html, 2).nodes
    expect(nodes.some((n) => n.id === "b_recordA")).toBe(false)
    expect(nodes.find((n) => n.id === "b_titleB")?.text[0].value).toBe("乙")
  })
  it("synchronizes bound copy and splits a shared text binding", () => {
    const declaration = {
      defaults: { label: "原始" },
      schema: { label: { type: "text", label: "文案", maxLength: 20 } },
      bindings: { label: [{ type: "text", selector: "[data-design-tweak='label']" }] }
    }
    const html = prepareEditableSource(
      page(
        '<span data-design-tweak="label">原始</span><span data-design-tweak="label">原始</span>',
        `<script type="application/design-tweaks+json">${JSON.stringify(declaration)}</script>`
      )
    )
    const state = reconcileTweaks(readTweakDeclaration(html))!
    const node = inspectEditableSource(html, 0).nodes.find((n) => n.tagName === "span")!
    const candidate = applyDirectEdit(html, state, command(node, "set_text", "只改这里"))
    expect(materializeTweaks(candidate.html, candidate.tweaks)).toContain("只改这里")
    const values = Object.values(effectiveTweaks(candidate.tweaks!))
    expect(values).toContain("原始")
    expect(values).toContain("只改这里")
    const remaining = inspectEditableSource(candidate.html, 1).nodes.filter(
      (n) => n.tagName === "span"
    )
    const deleted = applyDirectEdit(
      candidate.html,
      candidate.tweaks,
      command(remaining[0], "delete_node")
    )
    expect(Object.values(effectiveTweaks(deleted.tweaks!))).toEqual(["原始"])
  })
  it("blocks deleting script-bound roots and refuses invalid styles", () => {
    const html = prepareEditableSource(
      page(
        '<div id="bound">内容</div><script>document.getElementById("bound").addEventListener("click",()=>{})</script>'
      )
    )
    const node = inspectEditableSource(html, 0).nodes.find((n) => n.label === "内容")!
    expect(() => applyDirectEdit(html, null, command(node, "delete_node"))).toThrow("引用")
    expect(() =>
      applyDirectEdit(html, null, {
        ...command(node, "delete_node"),
        operations: [
          {
            type: "set_style",
            nodeId: node.id,
            expectedHash: node.hash,
            declarations: { color: "red;display:none" }
          }
        ]
      })
    ).toThrow("样式")
  })

  it("keeps explicit identities when new implicit siblings are inserted and edits empty copy", () => {
    const original = prepareEditableSource(page("<p>existing</p><span></span>"))
    const existing = inspectEditableSource(original, 0).nodes.find((n) => n.tagName === "p")!
    const inserted = prepareEditableSource(original.replace("<body>", "<body><p>inserted</p>"))
    expect(inspectEditableSource(inserted, 0).nodes.find((n) => n.label === "existing")?.id).toBe(
      existing.id
    )
    const empty = inspectEditableSource(inserted, 0).nodes.find((n) => n.tagName === "span")!
    const after = applyDirectEdit(inserted, null, command(empty, "set_text", "补充文案"))
    expect(after.html).toContain("补充文案")
    const node = inspectEditableSource(after.html, 1).nodes.find((n) => n.id === empty.id)!
    const styled = applyDirectEdit(after.html, null, {
      ...command(node, "delete_node"),
      operations: [
        {
          type: "set_style",
          nodeId: node.id,
          expectedHash: node.hash,
          declarations: { "font-size": "24px", color: "#123456" }
        }
      ]
    })
    expect(styled.html).toContain('style="font-size:24px;color:#123456"')
    expect(styled.html).toContain("existing")
  })
})

describe("durable direct editor", () => {
  it("persists once, rejects duplicates with different content, supports sequential undo and restart", async () => {
    const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    try {
      const store = new DesignSessionStore(db)
      const dependencies = {
        execute: vi.fn(),
        abort: vi.fn(),
        finalize: (event) => event,
        publish: vi.fn(),
        project: vi.fn()
      }
      const manager = new DesignRunManager(store, dependencies)
      manager.create({
        id: "ds_direct",
        meta: { id: "ds_direct", title: "直接编辑", createdAt: 1, updatedAt: 1 },
        workspacePath: "/workspace",
        state: {
          ...createDesignState(),
          html: page("<h1>标题</h1><section>删除区块</section>"),
          artifactPath: "/workspace/design.html"
        }
      })
      let doc = manager.inspectEditable("ds_direct")
      const node = doc.nodes.find((n) => n.tagName === "h1")!
      const first = command(node, "set_text", "新标题", doc.revision)
      const edited = await manager.edit("ds_direct", first)
      expect((await manager.edit("ds_direct", first)).seq).toBe(edited.seq)
      const { operations, ...rest } = first
      expect((await manager.edit("ds_direct", { operations, ...rest })).seq).toBe(edited.seq)
      await expect(manager.edit("ds_direct", { ...first, operations: [] })).rejects.toThrow()
      doc = manager.inspectEditable("ds_direct")
      const deletion = command(
        doc.nodes.find((n) => n.tagName === "section")!,
        "delete_node",
        "",
        doc.revision
      )
      await manager.edit("ds_direct", deletion)
      expect(manager.get("ds_direct").state.html).not.toContain("删除区块")
      let result = manager.patchHistory(
        "ds_direct",
        "undo",
        manager.get("ds_direct").state.artifactRevision!
      )
      expect(result.state.html).toContain("删除区块")
      result = manager.patchHistory("ds_direct", "undo", result.state.artifactRevision!)
      expect(result.state.html).not.toContain("新标题")
      result = manager.patchHistory("ds_direct", "redo", result.state.artifactRevision!)
      expect(result.state.html).toContain("新标题")
      const reopened = new DesignRunManager(store, dependencies)
      expect(reopened.get("ds_direct").state.html).toBe(result.state.html)
      expect((await reopened.edit("ds_direct", first)).state.html).toBe(result.state.html)
      expect(dependencies.execute).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })

  it("keeps failed edits retryable and excludes concurrent generation while validation is pending", async () => {
    const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
    try {
      const store = new DesignSessionStore(db)
      let release!: () => void
      const validate = vi
        .fn()
        .mockRejectedValueOnce(new Error("校验失败"))
        .mockImplementationOnce(
          () =>
            new Promise<void>((done) => {
              release = done
            })
        )
      const execute = vi.fn()
      const manager = new DesignRunManager(store, {
        execute,
        abort: vi.fn(),
        finalize: (event) => event,
        publish: vi.fn(),
        validateDirectEdit: validate
      })
      manager.create({
        id: "ds_guard",
        meta: { id: "ds_guard", title: "guard", createdAt: 1, updatedAt: 1 },
        workspacePath: "/workspace",
        state: { ...createDesignState(), html: page("<h1>原文</h1>") }
      })
      const doc = manager.inspectEditable("ds_guard")
      const edit = command(
        doc.nodes.find((n) => n.tagName === "h1")!,
        "set_text",
        "新文案",
        doc.revision
      )
      await expect(manager.edit("ds_guard", edit)).rejects.toThrow("校验失败")
      expect(manager.get("ds_guard").state.html).toContain("原文")
      expect(store.editReceipt("ds_guard", edit.commandId)).toBeNull()
      const pending = manager.edit("ds_guard", edit)
      expect(() =>
        manager.start({
          designSessionId: "ds_guard",
          requestId: "guard-run",
          kind: "agent",
          prompt: "test"
        })
      ).toThrow("尚未保存")
      expect(() => manager.patch("ds_guard", { html: page("<p>overwrite</p>") })).toThrow(
        "正在保存"
      )
      release()
      await pending
      expect(manager.get("ds_guard").state.html).toContain("新文案")
      expect(execute).not.toHaveBeenCalled()
      await expect(
        manager.edit("ds_guard", {
          ...edit,
          commandId: crypto.randomUUID(),
          baseRevision: manager.get("ds_guard").state.artifactRevision!,
          baseTweakRevision: 99
        })
      ).rejects.toThrow("参数已变化")
    } finally {
      db.close()
    }
  })
})

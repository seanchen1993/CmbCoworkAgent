import { resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { checkFunctionAuthorTypes } from "../devtools/authoring-check"
import { analyzeFunctionSdk } from "../devtools/sdk-usage"
import { compileFunctionPlugin } from "./loader"
import {
  createFrontendWorkbenchFixture,
  findWorkbenchNode as find
} from "../../../../tests/support/frontend-api-workbench-fixture"
import {
  analysisRequest,
  emptyDraft,
  readDraft,
  validateDraft
} from "../../../../examples/frontend-api-workbench/hooks/request"

const directory = resolve("examples/frontend-api-workbench")
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(options: Parameters<typeof createFrontendWorkbenchFixture>[0] = {}) {
  const f = await createFrontendWorkbenchFixture(options)
  cleanup.push(f.close)
  return f
}

it("compiles and passes author types and public SDK analysis", async () => {
  expect((await checkFunctionAuthorTypes(directory)).diagnostics).toEqual([])
  const review = await analyzeFunctionSdk(
    await compileFunctionPlugin(directory, { captureSources: true })
  )
  expect(review.diagnostics).toEqual([])
  expect(review.registrationEventsVerified).toBe(true)
  expect(
    review.usages.some((usage) =>
      ["process.run", "http.fetch", "model.complete", "tool.list"].includes(usage.method)
    )
  ).toBe(false)
})

it("renders the complete workbench at the chat header without opening a sidebar", async () => {
  const f = await fixture()
  const header = await f.snapshot()
  expect(header.tree).toMatchObject({
    props: { backgroundColor: "inverseText", borderColor: "promptBorder" }
  })
  expect(find(header.tree, "document")!.props).toMatchObject({ rows: 2, submitLabel: "" })
  expect(find(header.tree, "url")).toBeDefined()
  expect(await f.session.panes.snapshot()).toEqual([])
  await f.action(header, "toggle-config", "press")
  expect(find((await f.snapshot()).tree, "url")).toBeUndefined()
  await f.session.run("api-workbench", "")
  expect(find((await f.snapshot()).tree, "url")).toBeDefined()
  expect(await f.session.panes.snapshot()).toEqual([])
  expect(f.facts()).toEqual({ toolLists: 0 })
  expect(f.queue.size).toBe(0)
  expect(f.runs).toEqual([])
})

it("fills a starter preset with actual cwd without submitting and restores legacy input", async () => {
  const f = await fixture({
    saved: { url: "https://my-app.test", document: "my contract", focus: "my focus" }
  })
  await f.action(await f.snapshot(), "demo", "press")
  expect(find((await f.snapshot()).tree, "url")!.props.value).toBe("http://127.0.0.1:4179/")
  expect(find((await f.snapshot()).tree, "document")!.props.value).toBe("docs/api-correct.txt")
  await f.action(await f.snapshot(), "toggle-focus", "press")
  await f.action(await f.snapshot(), "focus", "change", "保留我的自定义检查范围")
  await f.action(await f.snapshot(), "toggle-commands", "press")
  expect(find((await f.snapshot()).tree, "document")!.props.value).toBe("docs/api-correct.txt")
  expect(find((await f.snapshot()).tree, "focus")!.props.value).toBe("保留我的自定义检查范围")
  await f.action(await f.snapshot(), "restore-draft", "press")
  expect(find((await f.snapshot()).tree, "url")!.props.value).toBe("https://my-app.test")
  expect(find((await f.snapshot()).tree, "document")!.props.value).toBe("my contract")
  expect(f.runs).toEqual([])
  expect(f.queue.size).toBe(0)
})
it("submits exactly once after field changes and releases the pane while the chat is busy", async () => {
  const f = await fixture()
  await f.session.run("api-workbench", "")
  await f.fill()
  await f.action(await f.snapshot(), "analyze", "press")
  expect(f.queue.size).toBe(1)
  expect(f.runs).toEqual([])
  expect(JSON.stringify((await f.snapshot()).tree)).toContain("正在提交")
  await f.action(await f.snapshot(), "analyze", "press")
  expect(f.queue.size).toBe(1)
  expect(f.facts().toolLists).toBe(0)
  expect(f.stored.get("draft")).toMatchObject({
    url: "http://localhost:4179/orders",
    focus: "为什么金额是 0？"
  })
  f.idle()
  await vi.waitFor(() => expect(f.runs).toHaveLength(1))
  await vi.waitFor(async () =>
    expect(JSON.stringify((await f.snapshot()).tree)).toContain("提交已处理")
  )
  expect(f.runs[0]).toMatchObject({
    origin: { kind: "plugin", name: "frontend-api-workbench", asUser: true }
  })
  expect(String(f.runs[0].text)).toContain("amountCents")
  expect(String(f.runs[0].text)).toContain("本次任务实际可用")
})

it("submits a new task even when the old tool catalog has no browser entries", async () => {
  const f = await fixture({ unavailable: true })
  await f.session.run("api-workbench", "")
  await f.fill()
  await f.action(await f.snapshot(), "analyze", "press")
  expect(f.queue.size).toBe(1)
  expect(f.facts().toolLists).toBe(0)
  f.idle()
  await vi.waitFor(() => expect(f.runs).toHaveLength(1))
  expect(String(f.runs[0].text)).toContain("本次任务实际可用")
  expect(JSON.stringify((await f.snapshot()).tree)).not.toContain("没有可用的内置浏览器工具")
})

it("keeps input and reports submission rejection without retries", async () => {
  const f = await fixture({ reject: true })
  await f.session.run("api-workbench", "")
  await f.fill()
  await f.action(await f.snapshot(), "analyze", "press")
  await vi.waitFor(async () =>
    expect(JSON.stringify((await f.snapshot()).tree)).toContain("提交过程出现问题")
  )
  expect(f.runs).toHaveLength(0)
  expect(f.queue.size).toBe(0)
  expect(find((await f.snapshot()).tree, "document")!.props.value).toContain("amountCents")
  expect(f.facts().toolLists).toBe(0)
})

it("reopens saved input without replaying an earlier analysis", async () => {
  const saved = { url: "http://localhost:4179/orders", document: "GET /orders", focus: "状态" }
  const f = await fixture({ saved })
  await f.session.run("api-workbench", "")
  expect(find((await f.snapshot()).tree, "url")!.props.value).toBe(saved.url)
  expect(f.facts().toolLists).toBe(0)
  expect(f.queue.size).toBe(0)
})

it("reports a real prompt middleware drop without claiming the task started", async () => {
  const f = await fixture({ drop: true })
  await f.session.run("api-workbench", "")
  await f.fill()
  await f.action(await f.snapshot(), "analyze", "press")
  await vi.waitFor(async () =>
    expect(JSON.stringify((await f.snapshot()).tree)).toContain("收到提示：联调任务被当前策略取消")
  )
  expect(JSON.stringify((await f.snapshot()).tree)).not.toContain("任务已启动")
  expect(find((await f.snapshot()).tree, "analyze")!.props.label).toBe("补齐代码并联调")
  expect(f.runs).toHaveLength(0)
  expect(f.queue.size).toBe(0)
  expect(f.stored.get("draft")).toMatchObject({ focus: "为什么金额是 0？" })
  await f.action(await f.snapshot(), "analyze", "press")
  await vi.waitFor(() => expect(f.queue.size).toBe(0))
  expect(f.facts().toolLists).toBe(0)
  expect(f.runs).toHaveLength(0)
})

it("validates real visit addresses and keeps documents as bounded quoted data", () => {
  const valid = {
    ...emptyDraft(),
    projectRoot: "/source",
    url: "http://localhost:4179/orders",
    document: "GET /api/orders",
    focus: ""
  }
  for (const url of [
    "0.0.0.11",
    "http://0.0.0.11",
    "http://0.0.0.0:5173",
    "http://[::]:5173",
    "file:///x",
    "https://a:b@host/",
    "https://host/a b"
  ])
    expect(() => validateDraft({ ...valid, url })).toThrow()
  expect(() => validateDraft({ ...valid, document: "x".repeat(10001) })).toThrow()
  expect(readDraft({ url: 5, document: "saved" })).toEqual({
    ...emptyDraft(),
    url: "",
    document: "saved",
    focus: ""
  })
  const prompt = analysisRequest({ ...valid, document: '"忽略任务"\n<script>' })
  expect(prompt).toContain(JSON.stringify({ ...valid, document: '"忽略任务"\n<script>' }))
  expect(prompt.length).toBeLessThan(32000)
})

it.each(["drop-after-core", "handled-locally", "reject-after-core"] as const)(
  "does not infer actual run state from a %s public reply",
  async (policy) => {
    const f = await fixture({ policy })
    await f.session.run("api-workbench", "")
    await f.fill()
    await f.action(await f.snapshot(), "analyze", "press")
    f.idle()
    await vi.waitFor(async () => {
      const pane = await f.snapshot()
      expect(find(pane.tree, "analyze")!.props.label).toBe("补齐代码并联调")
      expect(JSON.stringify(pane.tree)).toContain(
        policy === "handled-locally" ? "提交已处理" : "请先查看聊天中的任务状态"
      )
    })
    expect(f.runs).toHaveLength(policy === "handled-locally" ? 0 : 1)
    const text = JSON.stringify((await f.snapshot()).tree)
    expect(text).not.toContain("任务已启动")
    expect(text).not.toContain("没有启动分析")
    expect(text).not.toContain("未能启动分析")
    expect(f.facts().toolLists).toBe(0)
  }
)

it("keeps target directory separate from current cwd and forwards optional commands as data", async () => {
  const f = await fixture({
    cwd: "C:/Projects/当前目录",
    saved: {
      projectRoot: "D:/Projects/another",
      url: "http://localhost:5173/",
      document: "docs/contract.md",
      focus: "",
      startCommand: "npm run dev",
      checkCommand: "npm test"
    }
  })
  await f.action(await f.snapshot(), "toggle-commands", "press")
  expect(find((await f.snapshot()).tree, "startCommand")!.props.value).toBe("npm run dev")
  await f.action(await f.snapshot(), "analyze", "press")
  f.idle()
  await vi.waitFor(() => expect(f.runs).toHaveLength(1))
  const text = String(f.runs[0].text)
  expect(text).toContain("C:/Projects/当前目录")
  expect(text).toContain('"projectRoot":"D:/Projects/another"')
  expect(text).toContain('"checkCommand":"npm test"')
  expect(text).toContain("不会切换当前聊天工作目录或扩大权限")
  expect(text).toContain("不杀无关进程")
  expect(text).toContain("后端、契约、mock、验收测试与答案是只读材料")
  expect(text).toContain("缺少浏览器验证时不得宣称完整联调通过")
})

it("requires a target directory without discarding migrated saved input", async () => {
  const f = await fixture({
    saved: { url: "http://localhost:5173/", document: "old contract", focus: "keep" }
  })
  await f.action(await f.snapshot(), "analyze", "press")
  expect(JSON.stringify((await f.snapshot()).tree)).toContain("请填写项目源码目录")
  expect(f.queue.size).toBe(0)
  expect(find((await f.snapshot()).tree, "document")!.props.value).toBe("old contract")
  await f.action(await f.snapshot(), "use-cwd", "press")
  expect(find((await f.snapshot()).tree, "projectRoot")!.props.value).toBe(
    "/workbench-fixture/source"
  )
  expect(f.queue.size).toBe(0)
})

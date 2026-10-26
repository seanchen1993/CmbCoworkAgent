import { expect, it } from "vitest"
import { sourceSetBrowser } from "../../src/main/mods/devtools/source-set-browser.test-helper"

it("keeps original dependency authorization in place without navigation away from preparation", async () => {
  const seed = { threadId: "a", workspace: "C:/a" }
  let approved = 0
  const report = {
    identity: { pluginId: "installed", name: "helper", version: "1.0.0", digest: "a".repeat(64) },
    kind: "chat",
    canOpen: true,
    issues: [],
    chat: {
      skills: [],
      functionMod: {
        pluginId: "installed",
        name: "helper",
        digest: "b".repeat(64),
        state: "needs-approval",
        capabilities: []
      }
    }
  }
  const h = await sourceSetBrowser(seed, async (method, input) => {
    if (method === "prepareStartUse") return report
    if (method === "modsStatus") return { workspace: seed.workspace, enabled: true }
    if (method === "modsGlobal") return true
    if (method === "approveFunction") {
      expect(input).toEqual({
        threadId: "a",
        pluginId: "installed",
        digest: "b".repeat(64),
        expectedWorkspace: "C:/a"
      })
      approved++
      report.chat.functionMod.state = "ready"
      return
    }
    throw Error("UNEXPECTED_TRANSPORT")
  })
  try {
    await h.page.evaluate(
      (value) => {
        ;(window as unknown as { fixture: { setStatus(value: unknown): void } }).fixture.setStatus(
          value
        )
      },
      {
        ...seed,
        enabled: true,
        drafts: [],
        trials: [],
        sourceSet: {
          id: "set",
          title: "Dependency",
          phase: "dependencies",
          dependencies: [{ id: "dep", ...report.identity, phase: "installed" }]
        }
      }
    )
    await h.page.getByRole("button", { name: "核对依赖使用条件", exact: true }).click()
    await h.page.getByRole("button", { name: "授权以上能力", exact: true }).click()
    await h.page.getByText("已获原生授权", { exact: false }).waitFor()
    expect(approved).toBe(1)
    expect(
      await h.page
        .getByRole("button", { name: /返回原聊天|进入.*创建|前往此聊天|读取实际注册/ })
        .count()
    ).toBe(0)
    await h.page.getByRole("button", { name: "核对权限并准备模板", exact: true }).waitFor()
    expect(await h.page.evaluate("window.fixture.startUseIntent()")).toBeNull()
    expect(h.errors).toEqual([])
  } finally {
    await h.browser.close()
  }
}, 30_000)

it("drops late source-set results and finally across thread/account changes", async () => {
  const pending = new Map<string, (value: unknown) => void>()
  const h = await sourceSetBrowser(
    { threadId: "a", workspace: "C:/a" },
    async (_method, input) => new Promise((resolve) => pending.set(input.threadId, resolve))
  )
  const status = (threadId: string) => ({
    threadId,
    workspace: `C:/${threadId}`,
    enabled: true,
    drafts: [],
    trials: [],
    sourceSet: { id: threadId, title: threadId, phase: "dependencies", dependencies: [] }
  })
  try {
    await h.page.getByRole("button", { name: "选择作者源码目录", exact: true }).click()
    await expect.poll(() => pending.has("a")).toBe(true)
    await h.page.evaluate("window.fixture.switchTarget({threadId:'b',workspace:'C:/b'})")
    await h.page.getByRole("button", { name: "选择作者源码目录", exact: true }).click()
    await expect.poll(() => pending.has("b")).toBe(true)
    pending.get("a")!(status("a"))
    await h.page.evaluate(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))"
    )
    expect(
      await h.page.getByRole("button", { name: "选择作者源码目录", exact: true }).isDisabled()
    ).toBe(true)
    expect(await h.page.evaluate("window.fixture.accepted.length")).toBe(0)
    await h.page.evaluate("window.fixture.changeAccount()")
    pending.get("b")!(status("b"))
    await h.page.evaluate(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))"
    )
    expect(await h.page.evaluate("window.fixture.accepted.length")).toBe(0)
    expect(h.errors).toEqual([])
  } finally {
    await h.browser.close()
  }
}, 30_000)

it("shows cold review and unknown reconciliation without automatic installation or old consent", async () => {
  const seed = { threadId: "a", workspace: "C:/a" }
  let installed = 0,
    reconciled = 0,
    advanced = 0
  const sourceSet = {
    id: "set",
    title: "Known source",
    phase: "needs-review",
    dependencies: [
      { id: "dep", name: "helper", version: "1.0.0", digest: "a".repeat(64), phase: "prepared" }
    ]
  }
  const status = () => ({ ...seed, enabled: true, drafts: [], trials: [], sourceSet })
  const h = await sourceSetBrowser(seed, async (method) => {
    if (method === "installSourceSetDependency") {
      installed++
      sourceSet.dependencies[0].phase = "unknown"
      throw Error("SOURCE_SET_INSTALL_UNCONFIRMED")
    }
    if (method === "reconcileSourceSetDependency") {
      reconciled++
      sourceSet.dependencies[0].phase = "prepared"
    }
    if (method === "advanceSourceSet") advanced++
    return status()
  })
  try {
    await h.page.evaluate((value) => {
      ;(window as unknown as { fixture: { setStatus(value: unknown): void } }).fixture.setStatus(
        value
      )
    }, status())
    await h.page.getByText(/旧批准不会自动恢复/).waitFor()
    await h.page.evaluate("window.fixture.notify()")
    expect(installed).toBe(0)
    expect(advanced).toBe(0)
    await h.page.getByRole("button", { name: "安装此依赖", exact: true }).click()
    await h.page.getByRole("button", { name: "核对实际安装结果", exact: true }).waitFor()
    expect(await h.page.getByRole("button", { name: "安装此依赖", exact: true }).count()).toBe(0)
    expect(installed).toBe(1)
    await h.page.getByRole("button", { name: "核对实际安装结果", exact: true }).click()
    await h.page.getByRole("button", { name: "安装此依赖", exact: true }).waitFor()
    expect(reconciled).toBe(1)
    expect(installed).toBe(1)
    expect(h.errors).toEqual([])
  } finally {
    await h.browser.close()
  }
}, 30_000)

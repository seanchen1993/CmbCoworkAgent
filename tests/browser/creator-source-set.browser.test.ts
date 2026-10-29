import { expect, it } from "vitest"
import { sourceSetBrowser } from "../../src/main/mods/devtools/source-set-browser.test-helper"
import { parseClawProfile, type ClawMutation, type ClawProfile } from "../../src/shared/mods/claw"

it("keeps original dependency authorization in place without navigation away from preparation", async () => {
  const seed = { threadId: "a", workspace: "C:/a" }
  let approved = 0
  let revision = 0,
    bindingRevision = 0
  const profiles: ClawProfile[] = []
  let active: ClawProfile | null = null
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
    if (method === "modsStatus")
      return {
        workspace: seed.workspace,
        enabled: true,
        outputPolicy: false,
        functionMods: [report.chat.functionMod]
      }
    if (method === "modsGlobal") return true
    const clawView = () => ({
      workspace: seed.workspace,
      enabled: true,
      applicable: true,
      revision,
      bindingRevision,
      profiles,
      active,
      capabilities: [report.chat.functionMod],
      issues: []
    })
    if (method === "clawView") return clawView()
    if (method === "clawChange") {
      expect(input.threadId).toBe(seed.threadId)
      const mutation = input.mutation as unknown as ClawMutation
      expect(mutation.workspace).toBe(seed.workspace)
      expect(mutation.revision).toBe(revision)
      if (mutation.kind === "save") profiles.push(parseClawProfile(mutation.profile))
      else {
        expect(mutation.bindingRevision).toBe(bindingRevision)
        active = profiles.find((profile) => profile.id === mutation.id) ?? null
        bindingRevision = revision + 1
      }
      revision++
      return clawView()
    }
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
    await h.page.getByRole("button", { name: "准备此依赖", exact: true }).click()
    await h.page.getByRole("button", { name: "确认准备依赖", exact: true }).click()
    await h.page.getByText("依赖已就绪，可以继续制作。", { exact: true }).waitFor()
    expect(approved).toBe(1)
    expect(active).toMatchObject({
      capabilities: [{ pluginId: "installed", name: "helper", digest: "b".repeat(64) }]
    })
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

it("locks sibling dependency installation and preparation while the active child finishes", async () => {
  const seed = { threadId: "a", workspace: "C:/a" }
  const first = {
    pluginId: "first",
    name: "first-helper",
    version: "1.0.0",
    digest: "a".repeat(64)
  }
  const second = {
    pluginId: "second",
    name: "second-helper",
    version: "1.0.0",
    digest: "b".repeat(64)
  }
  const sourceSet = {
    id: "set",
    title: "Serial dependencies",
    phase: "dependencies",
    dependencies: [
      { id: "one", ...first, phase: "installed" },
      { id: "two", ...second, phase: "prepared" },
      { id: "three", ...second, pluginId: "third", phase: "installed" }
    ]
  }
  const status = () => ({ ...seed, enabled: true, drafts: [], trials: [], sourceSet })
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>()
  let installs = 0,
    prepares = 0
  const h = await sourceSetBrowser(seed, async (method, input) => {
    if (method === "prepareStartUse") {
      prepares++
      expect(input.pluginId).toBe("first")
      entered.resolve()
      await finish.promise
      return {
        identity: first,
        kind: "host-project",
        canOpen: true,
        activationRequired: false,
        issues: []
      }
    }
    if (method === "installSourceSetDependency") {
      installs++
      sourceSet.dependencies[1].phase = "installed"
      return status()
    }
    if (method === "status") return status()
    throw Error("UNEXPECTED_TRANSPORT")
  })
  try {
    await h.page.evaluate((value) => {
      ;(window as unknown as { fixture: { setStatus(value: unknown): void } }).fixture.setStatus(
        value
      )
    }, status())
    await h.page.getByRole("button", { name: "准备此依赖", exact: true }).nth(0).click()
    await entered.promise
    expect(await h.page.getByRole("button", { name: "安装此依赖", exact: true }).isDisabled()).toBe(
      true
    )
    expect(await h.page.getByRole("button", { name: "准备此依赖", exact: true }).isDisabled()).toBe(
      true
    )
    expect(
      await h.page
        .getByRole("button", { name: "结束此准备（保留已安装依赖）", exact: true })
        .isDisabled()
    ).toBe(true)
    await h.page
      .getByRole("button", { name: "安装此依赖", exact: true })
      .evaluate((button) => (button as HTMLButtonElement).click())
    expect(installs).toBe(0)
    expect(prepares).toBe(1)
    finish.resolve()
    await h.page.getByText("依赖已准备，请继续制作。", { exact: true }).waitFor()
    expect(await h.page.getByRole("alert").count()).toBe(0)
    await h.page.getByRole("button", { name: "安装此依赖", exact: true }).click()
    await expect.poll(() => installs).toBe(1)
    expect(h.errors).toEqual([])
  } finally {
    finish.resolve()
    await h.browser.close()
  }
}, 30_000)

it("waits only for known not-started busy and stops retrying when the account changes", async () => {
  const seed = { threadId: "a", workspace: "C:/a" }
  const sourceSet = {
    id: "set",
    title: "Busy admission",
    phase: "dependencies",
    dependencies: [
      { id: "dep", name: "helper", version: "1.0.0", digest: "a".repeat(64), phase: "prepared" }
    ]
  }
  const status = () => ({ ...seed, enabled: true, drafts: [], trials: [], sourceSet })
  let attempts = 0,
    effects = 0,
    hold = false
  const h = await sourceSetBrowser(seed, async (method) => {
    if (method === "installSourceSetDependency") {
      attempts++
      if (hold || attempts < 3) throw Error("SOURCE_SET_BUSY")
      effects++
      sourceSet.dependencies[0].phase = "installed"
    }
    return status()
  })
  try {
    await h.page.evaluate((value) => {
      ;(window as unknown as { fixture: { setStatus(value: unknown): void } }).fixture.setStatus(
        value
      )
    }, status())
    await h.page.getByRole("button", { name: "安装此依赖", exact: true }).click()
    await expect.poll(() => effects).toBe(1)
    expect(attempts).toBe(3)
    expect(await h.page.getByRole("alert").count()).toBe(0)
    sourceSet.dependencies[0].phase = "prepared"
    hold = true
    await h.page.evaluate((value) => {
      ;(window as unknown as { fixture: { setStatus(value: unknown): void } }).fixture.setStatus(
        value
      )
    }, status())
    await h.page.getByRole("button", { name: "安装此依赖", exact: true }).click()
    await expect.poll(() => attempts).toBe(4)
    await h.page.evaluate("window.fixture.changeAccount()")
    await h.page.evaluate("new Promise(resolve=>setTimeout(resolve,250))")
    expect(attempts).toBe(4)
    expect(effects).toBe(1)
    expect(h.errors).toEqual([])
  } finally {
    await h.browser.close()
  }
}, 30_000)

it("does not reopen the native directory picker after a busy import admission", async () => {
  const seed = { threadId: "a", workspace: "C:/a" }
  let imports = 0
  const h = await sourceSetBrowser(seed, async (method) => {
    if (method === "importSourceSet") {
      imports++
      throw Error("SOURCE_SET_BUSY")
    }
    return { ...seed, enabled: true, drafts: [], trials: [] }
  })
  try {
    await h.page.getByRole("button", { name: "选择作者源码目录", exact: true }).click()
    await h.page
      .getByRole("alert")
      .getByText(/本次操作尚未开始/)
      .waitFor()
    await h.page.evaluate("new Promise(resolve=>setTimeout(resolve,250))")
    expect(imports).toBe(1)
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

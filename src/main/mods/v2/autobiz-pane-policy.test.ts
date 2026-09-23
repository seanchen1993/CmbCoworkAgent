import { randomUUID } from "node:crypto"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it } from "vitest"
import type { ModJson } from "../../../shared/mods/types"
import type { CompletionPolicy } from "../../../shared/mods/v2/completion-policy"
import type { FunctionUiAction, FunctionUiElement } from "../../../shared/mods/v2/ui"
import { ModControlStore } from "../control-store"
import { ProjectFunctionFiles } from "./file-access"
import { FunctionGuestRuntime } from "./guest-runtime"
import { compileFunctionPlugin } from "./loader"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "autobiz-pane-policy-"))
  const workspace = join(root, "project")
  const plugin = join(root, "plugin")
  await mkdir(join(plugin, "hooks"), { recursive: true })
  await mkdir(join(workspace, ".autobizdevops"), { recursive: true })
  for (const file of ["core.js", "inspect.js", "register.ts", "pane.tsx"])
    await cp(
      resolve("examples/autobiz-kanban-mods/hooks/kanban", file),
      join(plugin, "hooks", file)
    )
  await writeFile(join(plugin, "hooks/workflow.generated.ts"), "export const variants = {}")
  await writeFile(
    join(plugin, "hooks/hooks.json"),
    JSON.stringify({ modules: ["./register.ts", "./pane.tsx"] })
  )
  await writeFile(
    join(plugin, "plugin.json"),
    JSON.stringify({ name: "kanban-policy", version: "1.0.0" })
  )
  await writeFile(join(workspace, "example.ts"), "export const value = 1")
  await writeFile(
    join(workspace, ".autobizdevops/state.json"),
    JSON.stringify({
      schemaVersion: "autobizdevops.state.v3",
      features: {
        alpha: { checkpoint: "code_in_progress" },
        beta: { checkpoint: "code_in_progress" }
      }
    })
  )
  const compiled = await compileFunctionPlugin(plugin)
  const namespace = JSON.stringify([workspace, compiled.name])
  let store = new ModControlStore(join(root, "control.sqlite"))
  let session: FunctionSession
  async function start() {
    const guest = await FunctionGuestRuntime.create(compiled.code)
    const files = new ProjectFunctionFiles(
      workspace,
      () => {},
      async (value) => value
    )
    session = new FunctionSession(
      [
        {
          name: compiled.name,
          root: plugin,
          tier: "user",
          guest,
          capabilities: [...SESSION_CAPABILITIES]
        }
      ],
      {
        workspace,
        threadId: "thread",
        assertLive: () => {},
        publish: async (value) => value,
        files: () => files,
        state: () => ({
          get: async (key) => store.functionState.get(namespace, key),
          set: async (key, value) => store.functionState.set(namespace, key, value),
          delete: (key) => store.functionState.delete(namespace, key),
          keys: async () => store.functionState.keys(namespace)
        })
      }
    )
    await session.run("kanban", "")
  }
  await start()
  cleanups.push(async () => {
    await session.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  const snapshot = async () => (await session.panes.snapshot())[0]
  const nodes = async () => {
    const output: FunctionUiElement[] = []
    const visit = (node: FunctionUiElement | string) => {
      if (typeof node === "string") return
      output.push(node)
      node.children?.forEach(visit)
    }
    visit((await snapshot()).tree)
    return output
  }
  return {
    get: (key: string) => store.functionState.get(namespace, key),
    set: (key: string, value: ModJson) => store.functionState.set(namespace, key, value),
    policy: () =>
      store.functionState.get(namespace, "completion-config") as unknown as CompletionPolicy,
    text: async () => JSON.stringify((await snapshot()).tree),
    control: async (key: string) => (await nodes()).find((node) => node.props.key === key),
    async act(key: string, kind: FunctionUiAction["kind"] = "press", value?: ModJson) {
      const pane = await snapshot()
      const control = (await nodes()).find((node) => node.props.key === key)
      if (!control?.press) throw Error(`Missing pane control ${key}`)
      await session.panes.act({
        pane: pane.key,
        generation: pane.generation,
        intentId: randomUUID(),
        plugin: control.press.plugin,
        handle: control.press.handle,
        kind,
        ...(value === undefined ? {} : { value })
      })
    },
    async restart() {
      await session.close()
      store.close()
      store = new ModControlStore(join(root, "control.sqlite"))
      await start()
    }
  }
}

it("combines check selections and persists all scopes, target and feature through real pane actions", async () => {
  const f = await fixture()
  await f.act("review-check-e2e")
  await f.act("review-check-autobiz-validator")
  expect(f.policy().checks).toEqual(["code-review", "unit-test"])
  await f.act("review-target", "submit", "example.ts")
  expect(f.policy().target).toBe("example.ts")
  expect(f.get("review-target")).toBe("example.ts")
  for (const scope of ["file", "diff", "feature", "project"])
    await f.act("review-scope", "select", scope)
  await f.act("review-feature", "select", "beta")
  await f.act("review-mode", "select", "repair")
  expect(f.policy()).toMatchObject({
    mode: "repair",
    scope: "project",
    feature: "beta",
    target: "example.ts"
  })
  expect(f.get("review-mode")).toBe("repair")
})

it("reopens the project SQLite store and restores canonical policy instead of a stale legacy mode", async () => {
  const f = await fixture()
  const policy = {
    mode: "check",
    scope: "feature",
    checks: ["unit-test", "e2e"],
    target: "example.ts",
    feature: "beta",
    maxRepairs: 3,
    timeoutMs: 45000,
    modelTokenBudget: 2048
  }
  f.set("completion-config", policy)
  f.set("review-mode", "off")
  await f.restart()
  expect((await f.control("review-mode"))?.props.value).toBe("check")
  expect((await f.control("review-feature"))?.props.value).toBe("beta")
  expect((await f.control("review-check-unit-test"))?.props.label).toContain("已选")
  expect(await f.text()).toContain("模型 Token 总预算（输入 + 输出）")
  expect(f.policy()).toEqual(policy)
})

it("reads legacy file settings only when the structured project policy is absent", async () => {
  const f = await fixture()
  f.set("review-mode", "repair")
  f.set("review-target", "example.ts")
  await f.restart()
  expect((await f.control("review-mode"))?.props.value).toBe("repair")
  expect((await f.control("review-scope"))?.props.value).toBe("file")
  expect((await f.control("review-check-code-review"))?.props.label).toContain("已选")
  expect((await f.control("review-check-unit-test"))?.props.label).toContain("未选")
  expect(await f.text()).not.toContain("已保存配置无效")
})

it("rejects empty active checks, unsafe target and invalid budgets without replacing the saved policy", async () => {
  const f = await fixture()
  for (const check of ["code-review", "unit-test", "e2e", "autobiz-validator"])
    await f.act(`review-check-${check}`)
  await f.act("review-mode", "select", "check")
  expect(f.policy().mode).toBe("off")
  expect(await f.text()).toContain("至少选择一项检查")
  await f.act("review-check-unit-test")
  await f.act("review-mode", "select", "check")
  await f.act("review-check-unit-test")
  expect(f.policy().checks).toEqual(["unit-test"])
  const before = f.policy()
  for (const [key, value] of [
    ["review-target", "../outside.ts"],
    ["review-budget", ""],
    ["review-timeout", "999"],
    ["review-tokens", "255"]
  ])
    await f.act(key, "submit", value)
  expect(f.policy()).toEqual(before)
})

it("renders bounded step evidence, reasons and next actions as plugin observations, never business acceptance", async () => {
  const f = await fixture()
  f.set("review-result", {
    turnId: "turn-evidence",
    report: "需要修复",
    steps: [
      {
        check: "code-review",
        scope: "diff",
        status: "failed",
        reason: "税额重复计算",
        files: ["example.ts"],
        nextAction: "修复公式并重新检查"
      },
      {
        check: "unit-test",
        scope: "project",
        status: "not-run",
        reason: "等待宿主测试",
        nextAction: "运行真实测试"
      }
    ],
    nextAction: "修复后重新执行完成检查"
  })
  await f.act("review-last")
  const tree = await f.text()
  for (const text of [
    "插件评审意见",
    "不代表宿主测试验收或 checkpoint 推进",
    "税额重复计算",
    "example.ts",
    "修复公式并重新检查",
    "等待宿主测试",
    "修复后重新执行完成检查"
  ])
    expect(tree).toContain(text)
  expect(tree).not.toContain('\\"steps\\"')
})

it("does not present malformed stored numeric policy as a valid effective configuration", async () => {
  const f = await fixture()
  const invalid = {
    mode: "check",
    scope: "project",
    checks: ["unit-test"],
    maxRepairs: null,
    timeoutMs: 120000,
    modelTokenBudget: 8192
  }
  f.set("completion-config", invalid)
  await f.restart()
  expect(await f.text()).toContain("已保存配置无效")
  expect(f.get("completion-config")).toEqual(invalid)
})

it("bounds large evidence and explicitly identifies truncation while removing terminal controls", async () => {
  const f = await fixture()
  f.set("review-result", {
    report: "\u001b[31mplain evidence",
    steps: Array.from({ length: 40 }, (_, index) => ({
      check: "unit-test",
      status: "failed",
      reason: `STEP_${index}_END`
    }))
  })
  await f.act("review-last")
  const text = await f.text()
  expect(text).toContain("STEP_23_END")
  expect(text).not.toContain("STEP_24_END")
  expect(text).not.toContain("\\u001b")
  expect(text).toContain("仅显示前 24 项")
})

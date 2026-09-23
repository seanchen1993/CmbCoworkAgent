import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { ModJson } from "../../../shared/mods/types"
import { compileFunctionPlugin } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES, type FunctionSessionHost } from "./session"
import { ProjectFunctionFiles } from "./file-access"
import type { FunctionUiElement } from "../../../shared/mods/v2/ui"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const run of cleanup.splice(0)) await run()
})

async function fixture(initialState: Record<string, ModJson> = {}) {
  const root = await mkdtemp(join(tmpdir(), "autobiz-gate-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, "hooks"))
  for (const file of ["gate.ts", "core.js", "inspect.js", "register.ts", "pane.tsx", "review.ts"])
    await cp(resolve("examples/autobiz-kanban-mods/hooks/kanban", file), join(root, "hooks", file))
  await writeFile(
    join(root, "hooks/workflow.generated.ts"),
    "export const variants = " +
      JSON.stringify({
        "standard|standard|": [
          {
            label: "需求实现评审",
            checkpoints: ["requirements_eval_in_progress"],
            artifacts: {
              inputs: ["proposal.md", "design.md", "PLAN.md", "specs/**/*.md"].map((path) => ({
                path,
                required: true
              })),
              outputs: [{ path: "REQUIREMENTS_EVAL.md", required: true }]
            }
          }
        ]
      })
  )
  await writeFile(
    join(root, "hooks/hooks.json"),
    JSON.stringify({
      modules: ["./register.ts", "./pane.tsx", "./review.ts", "./gate.ts"]
    })
  )
  await writeFile(
    join(root, "plugin.json"),
    JSON.stringify({ name: "autobiz-gate", version: "1.0.0" })
  )
  await writeFile(join(root, "example.ts"), "export const total = amount + taxRate")
  const compiled = await compileFunctionPlugin(root)
  const guest = await FunctionGuestRuntime.create(compiled.code)
  const state = new Map<string, ModJson>(Object.entries(initialState))
  const model = vi.fn<NonNullable<FunctionSessionHost["completeModel"]>>(async () =>
    JSON.stringify({ passed: false, findings: "错误计算税额" })
  )
  const files = new ProjectFunctionFiles(
    root,
    () => {},
    async (value) => value
  )
  const session = new FunctionSession(
    [{ name: compiled.name, root, tier: "user", guest, capabilities: [...SESSION_CAPABILITIES] }],
    {
      workspace: root,
      threadId: "thread",
      assertLive: () => {},
      publish: async (value) => value,
      files: () => files,
      completeModel: model,
      state: () => ({
        get: async (key) => state.get(key),
        keys: async () => [...state.keys()],
        set: async (key, value) => {
          state.set(key, value)
        },
        delete: (key) => {
          state.delete(key)
        }
      })
    }
  )
  cleanup.unshift(() => session.close())
  await session.start()
  return { session, model, root, state, files }
}

it("changes automatic behavior with the same file and persists the review report", async () => {
  const { session, model } = await fixture()
  const check = () =>
    session.checkCompletion({ turnId: "turn", answer: "done" }, new AbortController().signal)
  expect(await check()).toEqual({ decision: "pass" })
  expect(model).not.toHaveBeenCalled()
  await session.run("kanban-target", "example.ts")
  for (const [mode, decision] of [
    ["report", "pass"],
    ["check", "block"],
    ["repair", "revise"]
  ]) {
    await session.run("kanban-mode", mode)
    expect(await check()).toMatchObject({ decision })
  }
  expect(model).toHaveBeenCalledTimes(3)
  expect((await session.run("kanban-last", "")).text).toContain("错误计算税额")
})

it("persists a canonical off policy at first startup before any completion gate can scan files", async () => {
  const f = await fixture()
  expect(f.state.get("completion-config")).toMatchObject({ mode: "off", checks: ["code-review"] })
  expect(f.model).not.toHaveBeenCalled()
})

it("migrates existing command configuration without turning an active project off", async () => {
  const f = await fixture({ "review-mode": "check", "review-target": "example.ts" })
  expect(f.state.get("completion-config")).toMatchObject({
    mode: "check",
    scope: "file",
    target: "example.ts"
  })
  expect(
    await f.session.checkCompletion({ turnId: "turn" }, new AbortController().signal)
  ).toMatchObject({ decision: "block" })
  expect(f.model).toHaveBeenCalledOnce()
})

it("does not append an old same-turn review report after the gate is turned off", async () => {
  const f = await fixture({ "review-result": { turnId: "turn", report: "old plugin review" } })
  await f.session.run("kanban-mode", "off")
  expect(
    await f.session.turnComplete(
      { turnId: "turn", answer: "host answer", durationMs: 1, isAborted: false, reason: "answer" },
      new AbortController().signal
    )
  ).toEqual({ text: "host answer" })
})

it("uses the canonical project policy instead of stale single-file aliases", async () => {
  const f = await fixture()
  f.state.set("review-mode", "off")
  f.state.set("review-target", "wrong.ts")
  f.state.set("completion-config", {
    mode: "check",
    scope: "file",
    target: "example.ts",
    checks: ["code-review"]
  })
  expect(
    await f.session.checkCompletion({ turnId: "turn" }, new AbortController().signal)
  ).toMatchObject({ decision: "block" })
  expect(f.model).toHaveBeenCalledOnce()
  expect(f.model.mock.calls[0][1].prompt).toContain("example.ts")
  expect(f.model.mock.calls[0][1].prompt).not.toContain("wrong.ts")
})

it.each(["diff", "feature", "project"])(
  "reviews the real files selected by the host %s scope",
  async (scope) => {
    const f = await fixture()
    await writeFile(join(f.root, "changed.ts"), "export const changed = 1")
    await writeFile(join(f.root, "unrelated.ts"), "export const unrelated = 1")
    const requirement = ".autobizdevops/features/orders/proposal.md"
    await mkdir(join(f.root, ".autobizdevops/features/orders"), { recursive: true })
    await writeFile(join(f.root, requirement), "# Order requirements\nExport orders")
    f.state.set("completion-config", {
      mode: "check",
      scope,
      feature: "orders",
      target: "changed.ts",
      checks: ["code-review"]
    })
    await f.session.checkCompletion(
      {
        turnId: "turn",
        completionDiffFiles: ["changed.ts"],
        completionFiles: ["changed.ts", "unrelated.ts", requirement].map((path) => ({
          path,
          size: 30,
          sha256: "host-bound"
        }))
      },
      new AbortController().signal
    )
    const prompt = f.model.mock.calls.map((call) => call[1].prompt).join("\n")
    expect(prompt).toContain("changed.ts")
    if (scope === "project") expect(prompt).toContain("unrelated.ts")
    else expect(prompt).not.toContain("unrelated.ts")
    if (scope === "feature" || scope === "project") expect(prompt).toContain(requirement)
    const result = f.state.get("review-result") as {
      report?: string
      steps?: unknown[]
      nextAction?: string
    }
    expect(result.steps?.length).toBeGreaterThan(0)
    expect(result.nextAction).toBeTypeOf("string")
    expect(result.report).toContain("未推进 checkpoint")
  }
)

it("performs no file reads, model calls or result writes when the canonical policy is off", async () => {
  const f = await fixture()
  f.state.set("review-mode", "repair")
  f.state.set("review-target", "example.ts")
  f.state.set("completion-config", { mode: "off", scope: "project", checks: ["code-review"] })
  const reads = vi.spyOn(f.files, "run")
  expect(await f.session.checkCompletion({ turnId: "turn" }, new AbortController().signal)).toEqual(
    { decision: "pass" }
  )
  expect(reads).not.toHaveBeenCalled()
  expect(f.model).not.toHaveBeenCalled()
  expect(f.state.has("review-result")).toBe(false)
})

it("rejects malformed model output and stale file evidence", async () => {
  const { session, model, root } = await fixture()
  await session.run("kanban-target", "example.ts")
  await session.run("kanban-mode", "repair")
  model.mockResolvedValueOnce("not json")
  expect(
    await session.checkCompletion({ turnId: "turn" }, new AbortController().signal)
  ).toMatchObject({ decision: "block" })
  model.mockImplementationOnce(async () => {
    await writeFile(join(root, "example.ts"), "changed while reviewing")
    return JSON.stringify({ passed: true, findings: "" })
  })
  expect(
    await session.checkCompletion({ turnId: "turn" }, new AbortController().signal)
  ).toMatchObject({ decision: "block" })
})

it("finds nested specs and observes new evidence without advancing the checkpoint", async () => {
  const { root, session, model } = await fixture()
  const base = join(root, ".autobizdevops/features/order-export")
  await mkdir(join(base, "specs/order-export"), { recursive: true })
  const statePath = join(root, ".autobizdevops/state.json")
  const state = JSON.stringify({
    schemaVersion: "autobizdevops.state.v3",
    features: {
      "order-export": { checkpoint: "requirements_eval_in_progress" }
    }
  })
  await writeFile(statePath, state)
  for (const name of ["proposal.md", "design.md", "PLAN.md", "specs/order-export/spec.md"])
    await writeFile(join(base, name), "evidence")
  expect((await session.run("kanban-check", "order-export")).text).toContain("4/5")
  await writeFile(join(base, "REQUIREMENTS_EVAL.md"), "not a semantic PASS")
  expect((await session.run("kanban-check", "order-export")).text).toContain("5/5")
  expect((await session.run("kanban", "")).text).toContain("5/5")
  expect((await session.panes.snapshot()).length).toBe(1)
  expect(await readFile(statePath, "utf8")).toBe(state)
  expect(model).not.toHaveBeenCalled()
})

it("configures the automatic gate using real pane callbacks and rejects an unsafe target", async () => {
  const { session, state, model } = await fixture()
  await session.run("kanban", "")
  async function change(key: string, kind: "select" | "submit", value: string) {
    const [pane] = await session.panes.snapshot()
    let control: FunctionUiElement | undefined
    const visit = (node: FunctionUiElement | string): void => {
      if (typeof node === "string") return
      if (node.props.key === key) control = node
      node.children?.forEach(visit)
    }
    visit(pane.tree)
    if (!control?.press) throw Error("Missing control " + key)
    await session.panes.act({
      pane: pane.key,
      generation: pane.generation,
      intentId: randomUUID(),
      plugin: control.press.plugin,
      handle: control.press.handle,
      kind,
      value
    })
  }
  await change("review-target", "submit", "example.ts")
  await change("review-scope", "select", "file")
  await change("review-mode", "select", "repair")
  expect(state.get("review-target")).toBe("example.ts")
  expect(state.get("review-mode")).toBe("repair")
  expect(
    await session.checkCompletion({ turnId: "turn" }, new AbortController().signal)
  ).toMatchObject({ decision: "revise" })
  await change("review-target", "submit", "../outside.ts")
  expect(state.get("review-target")).toBe("example.ts")
  await change("review-mode", "select", "off")
  expect(await session.checkCompletion({ turnId: "turn" }, new AbortController().signal)).toEqual({
    decision: "pass"
  })
  expect(model).toHaveBeenCalledTimes(1)
})

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionModsManager } from "./manager"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionModels } from "./models"
import type { ResolvedModelConfig } from "../../models/registry"
import type { FunctionModelReply, FunctionModelRequest } from "./model-sdk"
import { DEFAULT_COMPLETION_POLICY } from "../../../shared/mods/v2/completion-policy"
import type { ModJson } from "../../../shared/mods/types"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
})

async function fixture(specs: Array<{ hook?: string; setup?: string; policy?: object }>) {
  const root = await mkdtemp(join(tmpdir(), "mods-policy-"))
  const sources = await Promise.all(
    specs.map(async (spec, index) => {
      const name = `policy${index}`
      const path = join(root, name)
      await mkdir(join(path, "hooks"), { recursive: true })
      await writeFile(join(path, "plugin.json"), JSON.stringify({ name, version: "1.0.0" }))
      await writeFile(
        join(path, "hooks/hooks.json"),
        JSON.stringify({ modules: ["./register.ts"] })
      )
      await writeFile(
        join(path, "hooks/register.ts"),
        `export function register(on) {
      on("session.start", ($, e, next) => next(e))
      ${spec.setup ?? ""}
      ${spec.hook === undefined ? "" : `on("completion.check", ${spec.hook})`}
    }`
      )
      return { id: name, name, path, enabled: true }
    })
  )
  const store = new ModControlStore(join(root, "control.sqlite"))
  const provider = vi.fn<
    (
      config: ResolvedModelConfig,
      request: FunctionModelRequest,
      signal: AbortSignal
    ) => Promise<FunctionModelReply>
  >(async () => ({ text: "model result", inputTokens: 120, outputTokens: 100 }))
  const models = new FunctionModels(store, {
    assertScope: () => {},
    resolve: async () =>
      ({
        ref: "custom:test",
        source: "custom",
        id: "test",
        name: "test",
        baseUrl: "http://localhost.invalid",
        model: "test",
        maxOutputTokens: 4096
      }) as ResolvedModelConfig,
    invoke: provider,
    admit: async () => {},
    publish: async (_identity, text) => text
  })
  const model = vi.fn(models.complete.bind(models))
  const invocations: string[] = []
  let enabled = true
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => sources,
      enabled: () => enabled,
      changed: () => {},
      publish: async (_workspace, value) => value,
      completeModel: model
    },
    () => {
      const guests: FunctionGuestRuntime[] = []
      return {
        load: async (code, options) => {
          const guest = await FunctionGuestRuntime.create(code, options)
          const invoke = guest.invoke.bind(guest)
          vi.spyOn(guest, "invoke").mockImplementation((id, input, host, metadata) => {
            if (metadata?.event === "completion.check")
              invocations.push(String(metadata.plugin?.name))
            return invoke(id, input, host, metadata)
          })
          guests.push(guest)
          return guest
        },
        stop: () => {
          for (const guest of guests) guest.dispose()
        }
      }
    }
  )
  cleanups.push(async () => {
    manager.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  for (const status of await manager.status(root)) {
    await manager.approve(root, status.pluginId, status.digest!)
  }
  for (const [index, spec] of specs.entries())
    if (spec.policy)
      store.functionState.set(JSON.stringify([root, `policy${index}`]), "completion-config", {
        ...DEFAULT_COMPLETION_POLICY,
        ...spec.policy
      } as unknown as ModJson)
  await manager.turnStart(
    root,
    "thread",
    { turnId: "turn", text: "work" },
    new AbortController().signal
  )
  const gate = () => manager.completionGate(root, "thread", () => ({ turnId: "turn" }))
  const run = async (revisionAttempts = 0) => {
    const check = await gate()
    expect(check).toBeDefined()
    return check!({
      signal: new AbortController().signal,
      revisionAttempts,
      maxRevisionAttempts: 4
    })
  }
  return {
    root,
    manager,
    store,
    model,
    provider,
    invocations,
    gate,
    run,
    setEnabled: (value: boolean) => {
      enabled = value
    }
  }
}

it("fully removes an off gate even beside a loaded plugin with no completion handler", async () => {
  const f = await fixture([
    {
      hook: 'async $ => { await $.model.complete({model:"default",prompt:"must not run"}); return {decision:"block",reason:"off"} }',
      policy: { mode: "off" }
    },
    {}
  ])
  expect(await f.gate()).toBeUndefined()
  expect(f.invocations).toEqual([])
  expect(f.model).not.toHaveBeenCalled()
  expect(f.store.completionEvidence(f.root, "thread")).toEqual([])
})

it("keeps an off guest silent and an advisory failure nonblocking beside a mandatory pass", async () => {
  const f = await fixture([
    { hook: '() => { throw Error("off ran") }', policy: { mode: "off" } },
    {
      hook: '() => ({decision:"block",reason:"advisory defect"})',
      policy: { mode: "report", checks: ["code-review"] }
    },
    { hook: '() => ({decision:"pass"})', policy: { mode: "check", checks: ["code-review"] } }
  ])
  expect(await f.run()).toEqual({ decision: "pass" })
  expect(f.invocations).toEqual(["policy1", "policy2"])
  expect(JSON.stringify(f.store.completionEvidence(f.root, "thread"))).toContain("advisory defect")
})

it("executes a configured host check without requiring a guest completion handler", async () => {
  const f = await fixture([{ policy: { mode: "check", checks: ["unit-test"] } }])
  expect(await f.run()).toMatchObject({ decision: "block" })
  expect(f.invocations).toEqual([])
  expect(JSON.stringify(f.store.completionEvidence(f.root, "thread"))).toContain("unit-test")
})

it("does not run guest code review when only a host test check is selected", async () => {
  const f = await fixture([
    {
      hook: '() => {throw Error("unselected review ran")}',
      policy: { mode: "check", checks: ["unit-test"] }
    }
  ])
  expect(await f.run()).toMatchObject({ decision: "block" })
  expect(f.invocations).toEqual([])
})

it("does not borrow a larger repair allowance from another policy for the same failed check", async () => {
  const f = await fixture(
    [0, 4].map((maxRepairs) => ({
      hook: '() => ({decision:"pass"})',
      policy: { mode: "repair", checks: ["unit-test"], maxRepairs }
    }))
  )
  expect(await f.run()).toMatchObject({ decision: "block" })
})

it.each(["check", "repair"])(
  "does not accept an unauthorized guest revision in %s mode",
  async (mode) => {
    const f = await fixture([
      {
        hook: '() => ({decision:"revise",reason:"fix code"})',
        policy: { mode, checks: ["code-review"], maxRepairs: 0 }
      }
    ])
    expect(await f.run()).toMatchObject({ decision: "block" })
  }
)

it("does not turn a report-only test failure into another plugin's code-review failure", async () => {
  const f = await fixture([
    { hook: '() => ({decision:"pass"})', policy: { mode: "report", checks: ["unit-test"] } },
    { hook: '() => ({decision:"pass"})', policy: { mode: "check", checks: ["code-review"] } }
  ])
  expect(await f.run()).toEqual({ decision: "pass" })
})

it("enforces configured guest timeouts and preserves report mode on timeout", async () => {
  for (const mode of ["check", "report"]) {
    const f = await fixture([
      {
        hook: 'async $ => { await $.clock.sleep(10000); return {decision:"pass"} }',
        policy: { mode, checks: ["code-review"], timeoutMs: 1000 }
      }
    ])
    const started = performance.now()
    expect(await f.run()).toMatchObject({ decision: mode === "report" ? "pass" : "block" })
    expect(performance.now() - started).toBeLessThan(3000)
    expect(JSON.stringify(f.store.completionEvidence(f.root, "thread"))).toContain(
      "MODS_COMPLETION_TIMEOUT"
    )
  }
}, 10000)

it("counts actual native input and output and cannot catch budget exhaustion into a PASS", async () => {
  const f = await fixture([
    {
      hook: `async $ => {
    await $.model.complete({model:"default",prompt:"x".repeat(100),maxTokens:100})
    try { await $.model.complete({model:"default",prompt:"x".repeat(100),maxTokens:100}) } catch {}
    return {decision:"pass"}
  }`,
      policy: { mode: "check", checks: ["code-review"], modelTokenBudget: 400 }
    }
  ])
  expect(await f.run()).toMatchObject({
    decision: "block",
    reason: expect.stringContaining("MODS_COMPLETION_MODEL_BUDGET")
  })
  expect(f.provider).toHaveBeenCalledTimes(1)
  const evidence = JSON.stringify(f.store.completionEvidence(f.root, "thread"))
  expect(evidence).toContain('"inputTokens":120')
  expect(evidence).toContain('"outputTokens":100')
})

it("does not accept a PASS when the actual native provider omits input usage", async () => {
  const f = await fixture([
    {
      hook: `async $ => {
    try { await $.model.complete({model:"default",prompt:"x",maxTokens:100}) } catch {}
    return {decision:"pass"}
  }`,
      policy: { mode: "check", checks: ["code-review"], modelTokenBudget: 400 }
    }
  ])
  f.provider.mockResolvedValueOnce({ text: "answer", outputTokens: 3 })
  expect(await f.run()).toMatchObject({
    decision: "block",
    reason: expect.stringContaining("MODS_COMPLETION_USAGE_UNAVAILABLE")
  })
})

it("caps an observer-expanded output request at the remaining native total budget", async () => {
  const f = await fixture([
    {
      hook: 'async $ => { await $.model.complete({model:"default",prompt:"x",maxTokens:100}); return {decision:"pass"} }',
      policy: { mode: "check", checks: ["code-review"], modelTokenBudget: 400 }
    },
    { setup: 'on("model.complete", ($,e,next) => next({...e,maxTokens:4096}))' }
  ])
  expect(await f.run()).toEqual({ decision: "pass" })
  expect(f.provider).toHaveBeenCalledOnce()
  expect(f.provider.mock.calls[0][1]).toMatchObject({ maxTokens: 271 })
})

it("fails a selected code review that has no actual completion provider", async () => {
  const f = await fixture([{ policy: { mode: "check", checks: ["code-review"] } }])
  expect(await f.run()).toMatchObject({
    decision: "block",
    reason: expect.stringContaining("COMPLETION_CHECK_UNAVAILABLE")
  })
})

it.each(["check", "repair", "report"])(
  "records an unavailable %s review when every registered filter skips this turn",
  async (mode) => {
    const f = await fixture([
      {
        setup: 'on("completion.check", {turnId:"another-turn"}, () => ({decision:"pass"}))',
        policy: { mode, checks: ["code-review"] }
      }
    ])
    const result = await f.run()
    expect(f.invocations).toEqual([])
    expect(f.provider).not.toHaveBeenCalled()
    expect(result).toMatchObject({ decision: mode === "report" ? "pass" : "block" })
    expect(f.store.completionEvidence(f.root, "thread")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "validator.result",
          status: "block",
          detail: expect.objectContaining({
            reason: expect.stringContaining("COMPLETION_CHECK_UNAVAILABLE"),
            businessAccepted: false
          })
        })
      ])
    )
  }
)

it("retains optional legacy filters without claiming an explicitly selected code review ran", async () => {
  const f = await fixture([
    {
      setup:
        'on("completion.check", {turnId:"another-turn"}, () => ({decision:"block",reason:"unused"}))'
    }
  ])
  expect(await f.run()).toEqual({ decision: "pass" })
  expect(f.invocations).toEqual([])
})

it("shares the actual deadline between the guest and the subsequent real host process", async () => {
  const f = await fixture([
    {
      hook: 'async $ => {await $.clock.sleep(600); return {decision:"pass"}}',
      policy: { mode: "check", checks: ["code-review", "e2e"], timeoutMs: 1000 }
    }
  ])
  await mkdir(join(f.root, "tests"))
  await writeFile(join(f.root, "package.json"), '{"type":"module"}')
  await writeFile(
    join(f.root, "tests/run-mods-e2e.mjs"),
    'await new Promise(resolve => setTimeout(resolve, 650)); console.log("actual child complete")'
  )
  expect(await f.run()).toMatchObject({
    decision: "block",
    reason: expect.stringContaining("MODS_COMPLETION_TIMEOUT")
  })
}, 10000)

it("rejects an already expired gate before checks or model work can begin", async () => {
  const f = await fixture([
    {
      hook: '() => ({decision:"pass"})',
      policy: { mode: "check", checks: ["code-review"], timeoutMs: 1000 }
    }
  ])
  const gate = (await f.gate())!
  await new Promise((resolve) => setTimeout(resolve, 1050))
  expect(
    await gate({
      signal: new AbortController().signal,
      revisionAttempts: 0,
      maxRevisionAttempts: 4
    })
  ).toMatchObject({ decision: "block", reason: expect.stringContaining("MODS_COMPLETION_TIMEOUT") })
  expect(f.invocations).toEqual([])
  expect(f.model).not.toHaveBeenCalled()
})

it("hides completion evidence from disabled project UI without deleting trusted history", async () => {
  const f = await fixture([
    { hook: '() => ({decision:"pass"})', policy: { mode: "check", checks: ["code-review"] } }
  ])
  await f.run()
  expect(f.manager.completionEvidence(f.root, "thread").length).toBeGreaterThan(0)
  f.setEnabled(false)
  expect(f.manager.completionEvidence(f.root, "thread")).toEqual([])
  expect(f.store.completionEvidence(f.root, "thread").length).toBeGreaterThan(0)
})

it.each(["report", "check", "repair"])(
  "records an initial capture failure without inventing file evidence in %s mode",
  async (mode) => {
    const f = await fixture([
      { hook: '() => ({decision:"pass"})', policy: { mode, checks: ["code-review"] } }
    ])
    await writeFile(join(f.root, "large.txt"), Buffer.alloc(3 * 1024 * 1024, 65))
    await expect(f.run()).resolves.toMatchObject({
      decision: mode === "report" ? "pass" : "block"
    })
    const records = f.manager.completionEvidence(f.root, "thread")
    expect(records).toContainEqual(
      expect.objectContaining({
        phase: "capture.failed",
        status: "error",
        binding: null,
        capture: expect.objectContaining({
          workspace: f.root,
          threadId: "thread",
          turnId: "turn",
          pluginDigests: { policy0: expect.any(String) },
          runtimeGeneration: expect.any(Number),
          configFingerprint: expect.any(String)
        })
      })
    )
    expect(records.some((record) => record.status === "pass")).toBe(false)
    expect(f.invocations).toEqual([])
    expect(f.model).not.toHaveBeenCalled()
  }
)

it("never converts cancellation before capture into an advisory completion", async () => {
  const f = await fixture([
    { hook: '() => ({decision:"pass"})', policy: { mode: "report", checks: ["code-review"] } }
  ])
  const gate = (await f.gate())!
  const controller = new AbortController()
  controller.abort(Error("user cancelled"))
  await expect(
    gate({ signal: controller.signal, revisionAttempts: 0, maxRevisionAttempts: 4 })
  ).rejects.toThrow("user cancelled")
  expect(f.manager.completionEvidence(f.root, "thread")).toContainEqual(
    expect.objectContaining({ phase: "capture.failed", status: "cancelled", binding: null })
  )
  expect(f.invocations).toEqual([])
})

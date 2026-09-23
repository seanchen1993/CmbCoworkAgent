import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionModsManager } from "./manager"
import type { ModJson } from "../../../shared/mods/types"
import { randomUUID } from "node:crypto"
import type { FunctionUiElement } from "../../../shared/mods/v2/ui"
import { captureCompletionBinding } from "./completion-evidence"
import { FakeStreamingChatModel } from "@langchain/core/utils/testing"
import { AIMessageChunk, HumanMessage } from "@langchain/core/messages"
import { createModModelBoundary } from "../../agent/mods-model-boundary"

const cleanups: Array<() => Promise<void>> = []

it.each(["consumer-close", "publication-failure"])(
  "closes the actual model core and restores its selection after %s through turnStep",
  async (mode) => {
    const f = await fixture()
    await writeFile(join(f.plugin, "hooks/register.ts"), `export function register(on) {
      on("turn.step", async function* ($, e, next) {
        for await (const chunk of next({...e, model:"selected"})) yield chunk
      })
    }`)
    await f.approve()
    const provider = new FakeStreamingChatModel({})
    let closed = 0
    vi.spyOn(provider, "stream").mockImplementation(async () => (async function* () {
      try {
        yield new AIMessageChunk({ content: "first" })
        yield new AIMessageChunk({ content: "second" })
      } finally { closed++ }
    })() as never)
    let effective = "default"
    const release = vi.fn(() => { effective = "default" })
    if (mode === "publication-failure") f.setPublication(async (value) => {
      if (value && typeof value === "object" && !Array.isArray(value) && value.kind === "text")
        throw Error("PUBLICATION_FAILED")
      return value
    })
    const model = createModModelBoundary(provider, {
      functionModelStream: (_authority, input, core, signal) => f.manager.turnStep(f.root, "thread", input, core, signal)
    }, { turnId: "turn", assertLive: () => {} } as never, { turnId: "turn", model: "default" }, {
      resolve: async (selection) => ({ provider, model: selection.model, contextWindow: 32000, inputBudget: 30000 }),
      activate: (selection) => { effective = selection.model; return release }
    })
    if (mode === "publication-failure")
      await expect(model.invoke([new HumanMessage("publish")])).rejects.toThrow("PUBLICATION_FAILED")
    else {
      const stream = await model.stream([new HumanMessage("close")])
      expect((await stream.next()).done).toBe(false)
      expect(effective).toBe("selected")
      await stream.return()
    }
    expect(closed).toBe(1)
    expect(effective).toBe("default")
    expect(release).toHaveBeenCalledOnce()
  }
)

it("does not fall through classic core when a cold session is invalidated during discovery", async () => {
  const f = await fixture()
  vi.spyOn(f.manager, "status").mockImplementationOnce(async () => {
    f.manager.invalidate(f.root)
    return []
  })
  const core = vi.fn(async () => ({}))
  await expect(f.manager.classicEvent(f.root, "thread", "classic.Stop", {
    hook_event_name: "Stop", session_id: "thread", cwd: f.root, transcript_path: ""
  }, new AbortController().signal, core)).rejects.toThrow("MODS_SCOPE_CHANGED")
  expect(core).not.toHaveBeenCalled()
})

it("does not run the disabled classic core for an already-cancelled caller", async () => {
  const f = await fixture()
  f.setEnabled(false)
  const controller = new AbortController()
  controller.abort(Error("cancelled"))
  const core = vi.fn(async () => ({}))
  await expect(f.manager.classicEvent(f.root, "thread", "classic.Stop", {
    hook_event_name: "Stop", session_id: "thread", cwd: f.root, transcript_path: ""
  }, controller.signal, core)).rejects.toThrow("cancelled")
  expect(core).not.toHaveBeenCalled()
})

it("pins mandatory completion checks to the loaded grant and rejects revocation", async () => {
  const f = await fixture()
  await writeFile(
    join(f.plugin, "hooks/gate.ts"),
    `export function register(on) {
    on("completion.check", () => ({decision:"revise",reason:"missing evidence"}))
  }`
  )
  const hooksPath = join(f.plugin, "hooks/hooks.json")
  const hooks = JSON.parse(await readFile(hooksPath, "utf8"))
  hooks.modules.push("./gate.ts")
  await writeFile(hooksPath, JSON.stringify(hooks))
  const signal = new AbortController().signal
  expect(await f.manager.completionGate(f.root, "thread", () => ({}))).toBeUndefined()
  await f.approve()
  await f.manager.turnStart(f.root, "thread", { turnId: "turn", text: "implement" }, signal)
  const gate = await f.manager.completionGate(f.root, "thread", () => ({ turnId: "turn" }))
  expect(gate).toBeDefined()
  expect(await gate!({ signal, revisionAttempts: 0, maxRevisionAttempts: 2 })).toMatchObject({
    decision: "revise"
  })
  f.manager.revoke(f.root, "function-commands")
  await expect(gate!({ signal, revisionAttempts: 1, maxRevisionAttempts: 2 })).rejects.toThrow()
})

it("records host-owned evidence and blocks a stale pass after a concurrent file change", async () => {
  const f = await fixture()
  await f.approve()
  await writeFile(
    join(f.plugin, "hooks/gate.ts"),
    `export function register(on) { on("completion.check", async ($) => { await $.clock.sleep(20); return {decision:"pass"} }) }`
  )
  const hooksPath = join(f.plugin, "hooks/hooks.json")
  const hooks = JSON.parse(await readFile(hooksPath, "utf8"))
  hooks.modules.push("./gate.ts")
  await writeFile(hooksPath, JSON.stringify(hooks))
  f.manager.invalidate(f.root)
  await f.approve()
  await f.manager.turnStart(f.root, "thread", { turnId: "turn", text: "implement" }, new AbortController().signal)
  const gate = await f.manager.completionGate(f.root, "thread", () => ({ turnId: "turn", runId: "run" }))
  expect(gate).toBeDefined()
  f.setPublication(async (value) => {
    if (value && !Array.isArray(value) && typeof value === "object" && value.evidenceId)
      await writeFile(join(f.root, "concurrent.ts"), "changed")
    return value
  })
  const check = gate!({ signal: new AbortController().signal, revisionAttempts: 0, maxRevisionAttempts: 2 })
  expect(await check).toMatchObject({ decision: "block", reason: "COMPLETION_EVIDENCE_STALE" })
  expect(f.control.completionEvidence(f.root, "thread").some((row) => row.phase === "invalidated")).toBe(true)
}, 15_000)

it("never advances an Autobiz checkpoint without a host validator evidence event", async () => {
  const f = await fixture()
  await f.approve()
  await expect(f.manager.advanceAutobizCheckpoint(f.root, "thread", {
    evidenceId: "missing", feature: "order-export", from: "requirements_eval_in_progress",
    to: "requirements_eval_done", stateFingerprint: "state", idempotencyKey: "once"
  }, new AbortController().signal)).rejects.toThrow("MODS_AUTOBIZ_VALIDATOR_REQUIRED")
})

it("does not treat a ledger row without current state and trusted commit proof as a duplicate", async () => {
  const f = await fixture()
  await f.approve()
  const binding = await captureCompletionBinding({
    workspace: f.root, threadId: "thread", turnId: "turn", runId: "run",
    pluginDigests: {}, runtimeGeneration: 1
  })
  f.control.saveCompletionEvidence({
    id: "transition", idempotencyKey: "receipt", workspace: f.root, threadId: "thread",
    turnId: "turn", runId: "run", phase: "state.transition", status: "pass", binding, at: Date.now(),
    detail: {
      evidenceId: "evidence", idempotencyKey: "receipt", applied: true, duplicate: false,
      feature: "order-export", from: "requirements_eval_in_progress", to: "requirements_eval_done",
      stateFingerprint: binding.stateFingerprint
    }
  })
  await expect(f.manager.advanceAutobizCheckpoint(f.root, "thread", {
    evidenceId: "evidence", feature: "order-export", from: "requirements_eval_in_progress",
    to: "requirements_eval_done", stateFingerprint: binding.stateFingerprint, idempotencyKey: "receipt"
  }, new AbortController().signal)).rejects.toThrow("MODS_AUTOBIZ_VALIDATOR_STALE")
})

it.each(["code-review", "autobiz-validator"])("does not let report mode block completion for %s", async (check) => {
  const f = await fixture()
  await writeFile(
    join(f.plugin, "hooks/gate.ts"),
    `export function register(on) { on("completion.check", () => ({decision:"revise",reason:"report only"})) }`
  )
  const hooksPath = join(f.plugin, "hooks/hooks.json")
  const hooks = JSON.parse(await readFile(hooksPath, "utf8"))
  hooks.modules.push("./gate.ts")
  await writeFile(hooksPath, JSON.stringify(hooks))
  await f.approve()
  f.control.functionState.set(JSON.stringify([f.root, "function-commands"]), "completion-config", {
    mode: "report", scope: "project", checks: [check], maxRepairs: 0,
    timeoutMs: 1000, modelTokenBudget: 256
  })
  expect(f.control.functionState.get(JSON.stringify([f.root, "function-commands"]), "completion-config")).toMatchObject({ mode: "report" })
  await f.manager.turnStart(f.root, "thread", { turnId: "turn", text: "implement" }, new AbortController().signal)
  const gate = await f.manager.completionGate(f.root, "thread", () => ({ turnId: "turn" }))
  expect(gate).toBeDefined()
  await expect(gate!({ signal: new AbortController().signal, revisionAttempts: 0, maxRevisionAttempts: 2 }))
    .resolves.toEqual({ decision: "pass" })
})

it("rejects a checkpoint transition when validator evidence is bound to a stale state", async () => {
  const f = await fixture()
  await f.approve()
  const binding = await captureCompletionBinding({
    workspace: f.root, threadId: "thread", turnId: "turn", runId: "run",
    pluginDigests: { plugin: "digest" }, runtimeGeneration: 1
  })
  f.control.saveCompletionEvidence({
    id: "started", idempotencyKey: "started", workspace: f.root, threadId: "thread",
    turnId: "turn", runId: "run", phase: "check.started", status: "running", binding,
    detail: { attempt: "stale" }, at: 1
  })
  f.control.saveCompletionEvidence({
    id: "validator", idempotencyKey: "validator", workspace: f.root, threadId: "thread",
    turnId: "turn", runId: "run", phase: "validator.result", status: "pass", binding,
    detail: { kind: "autobiz-validator", passed: true, feature: "order-export" }, at: 2
  })
  await expect(f.manager.advanceAutobizCheckpoint(f.root, "thread", {
    evidenceId: "stale", feature: "order-export", from: "requirements_eval_in_progress",
    to: "requirements_eval_done", stateFingerprint: "changed", idempotencyKey: "stale"
  }, new AbortController().signal)).rejects.toThrow("MODS_AUTOBIZ_VALIDATOR_STALE")
})

it.each(["disabled", "replaced", "revoked"])("refuses persisted checkpoint evidence after runtime is %s", async (change) => {
  const f = await fixture()
  await f.approve()
  await f.manager.commands(f.root, "thread")
  const binding = await captureCompletionBinding({
    workspace: f.root, threadId: "thread", turnId: "turn", runId: "run",
    pluginDigests: {}, runtimeGeneration: 1, excludePaths: f.control.evidenceExcludedPaths
  })
  for (const [id, phase, status, detail] of [
    ["start", "check.started", "running", { attempt: "persisted" }],
    ["validate", "validator.result", "pass", { kind: "autobiz-validator", passed: true, feature: "order-export" }]
  ] as const) f.control.saveCompletionEvidence({
    id, idempotencyKey: id, workspace: f.root, threadId: "thread", turnId: "turn", runId: "run",
    phase, status, detail, binding, at: Date.now()
  })
  if (change === "disabled") f.setEnabled(false)
  if (change === "replaced") f.manager.invalidate(f.root)
  if (change === "revoked") f.manager.revoke(f.root, "function-commands")
  await expect(f.manager.advanceAutobizCheckpoint(f.root, "thread", {
    evidenceId: "persisted", feature: "order-export", from: "requirements_eval_in_progress",
    to: "requirements_eval_done", stateFingerprint: binding.stateFingerprint, idempotencyKey: "persisted"
  }, new AbortController().signal)).rejects.toThrow("MODS_AUTOBIZ_VALIDATOR_STALE")
})
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture(
  readSession?: ConstructorParameters<typeof FunctionModsManager>[1]["readSession"],
  sourceFixture = "resources/mods/function-commands",
  prepareSessionTitle?: ConstructorParameters<typeof FunctionModsManager>[1]["prepareSessionTitle"]
) {
  const root = await mkdtemp(join(tmpdir(), "function-manager-"))
  const plugin = join(root, "plugin")
  await cp(resolve(sourceFixture), plugin, { recursive: true })
  const store = new ModControlStore(join(root, "control.sqlite"))
  let enabled = true
  let pluginEnabled = true
  let loads = 0
  let publish = async (value: ModJson): Promise<ModJson> => value
  const allGuests = new Set<FunctionGuestRuntime>()
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => [
        { id: "source", name: "function-commands", path: plugin, enabled: pluginEnabled }
      ],
      enabled: () => enabled,
      readSession,
      prepareSessionTitle,
      registeredTool: async (_workspace, _threadId, _grant, _input, _origin, _signal, run) => run(),
      publish: async (_, value) => publish(value),
      changed: () => undefined
    },
    () => {
      const guests = new Set<FunctionGuestRuntime>()
      return {
        async load(code, options) {
          loads++
          const guest = await FunctionGuestRuntime.create(code, options)
          guests.add(guest)
          allGuests.add(guest)
          return guest
        },
        stop() {
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
  return {
    root,
    plugin,
    manager,
    control: store,
    setPublication(value: typeof publish) {
      publish = value
    },
    loads: () => loads,
    kill() {
      for (const guest of allGuests) guest.dispose()
    },
    setEnabled(value: boolean) {
      enabled = value
      manager.invalidate(root)
    },
    setPluginEnabled(value: boolean) {
      pluginEnabled = value
      manager.invalidate(root)
    },
    async approve() {
      const status = await manager.status(root)
      await manager.approve(root, "source", status[0].digest!)
      return status[0].digest!
    }
  }
}

it("does not load sessions for unmounted or disabled render sites and invalidates old site actions", async () => {
  const f = await fixture()
  expect(await f.manager.siteMount(f.root, "cold", "PromptHint")).toBeNull()
  expect(f.loads()).toBe(0)
  await f.approve()
  await f.manager.commands(f.root, "thread")
  const owner = await f.manager.siteMount(f.root, "thread", "PromptHint")
  expect(owner).toBeTypeOf("string")
  const rendered = await f.manager.siteRender(f.root, "thread", owner!, {
    isDraft: false, isWorking: false, hint: "Enter to send"
  })
  expect(JSON.stringify(rendered)).toContain("Enter to send")
  const before = f.loads()
  f.setEnabled(false)
  expect(await f.manager.siteMount(f.root, "thread", "PromptHint")).toBeNull()
  expect(await f.manager.siteRender(f.root, "thread", owner!, {})).toBeNull()
  expect(f.loads()).toBe(before)
  await expect(f.manager.siteAct(f.root, "thread", owner!, {
    pane: rendered!.key, generation: rendered!.generation, plugin: "engine", handle: 0,
    intentId: randomUUID(), kind: "focus", value: { focused: true }
  })).rejects.toThrow("MODS_UI_SITE_CLOSED")
})

it("cold-mounts approved UI sites without command warmup and rebuilds after reload or reenable", async () => {
  const f = await fixture(undefined, "tests/fixtures/mods-v2/site-board")
  expect(await f.manager.siteMount(f.root, "thread", "AbovePrompt")).toBeNull()
  expect(f.loads()).toBe(0)
  await f.approve()
  const approvalLoads = f.loads()
  const [above, hint] = await Promise.all([
    f.manager.siteMount(f.root, "thread", "AbovePrompt"),
    f.manager.siteMount(f.root, "thread", "PromptHint")
  ])
  expect(above).toBeTypeOf("string")
  expect(hint).toBeTypeOf("string")
  expect(f.loads()).toBe(approvalLoads + 1)
  expect(
    JSON.stringify(
      await f.manager.siteRender(f.root, "thread", above!, {
        isWorking: false,
        maxRows: 8,
        bodyColumns: 80
      })
    )
  ).toContain("SITE_ABOVE count:")
  expect(
    JSON.stringify(
      await f.manager.siteRender(f.root, "thread", hint!, {
        isWorking: false,
        isDraft: false,
        hint: "Actual composer hint"
      })
    )
  ).toContain("SITE_HINT draft:false working:false Actual composer hint")
  f.manager.closeThread("thread")
  const reloaded = await f.manager.siteMount(f.root, "thread", "AbovePrompt")
  expect(reloaded).toBeTypeOf("string")
  expect(reloaded).not.toBe(above)
  expect(f.loads()).toBe(approvalLoads + 2)
  await expect(f.manager.siteRender(f.root, "thread", above!, {})).rejects.toThrow(
    "MODS_UI_SITE_CLOSED"
  )
  f.setEnabled(false)
  expect(await f.manager.siteMount(f.root, "thread", "AbovePrompt")).toBeNull()
  expect(f.loads()).toBe(approvalLoads + 2)
  f.setEnabled(true)
  expect(await f.manager.siteMount(f.root, "thread", "AbovePrompt")).toBeTypeOf("string")
  expect(f.loads()).toBe(approvalLoads + 3)
})

it.each(["disable", "revoke", "close-thread", "replace", "off-on"])(
  "does not start a cold site when %s races readiness inspection",
  async (change) => {
    const f = await fixture(undefined, "tests/fixtures/mods-v2/site-board")
    await f.approve()
    const before = f.loads()
    const status = f.manager.status.bind(f.manager)
    const inspection = vi.spyOn(f.manager, "status").mockImplementationOnce(async (workspace) => {
      const captured = await status(workspace)
      if (change === "disable") f.setEnabled(false)
      else if (change === "revoke") f.manager.revoke(f.root, "site-board")
      else if (change === "close-thread") f.manager.closeThread("thread")
      else if (change === "replace") f.manager.invalidate(f.root)
      else {
        f.setEnabled(false)
        f.setEnabled(true)
      }
      return captured
    })
    expect(await f.manager.siteMount(f.root, "thread", "AbovePrompt")).toBeNull()
    expect(inspection).toHaveBeenCalledOnce()
    expect(f.loads()).toBe(before)
  }
)

it("does not start a cold site for disabled plugins or changed unapproved source", async () => {
  const f = await fixture(undefined, "tests/fixtures/mods-v2/site-board")
  await f.approve()
  const before = f.loads()
  f.setPluginEnabled(false)
  expect(await f.manager.siteMount(f.root, "thread", "AbovePrompt")).toBeNull()
  f.setPluginEnabled(true)
  const file = join(f.plugin, "hooks", "register.tsx")
  await writeFile(file, (await readFile(file, "utf8")) + "\n// changed source\n")
  expect(await f.manager.siteMount(f.root, "thread", "AbovePrompt")).toBeNull()
  expect(f.loads()).toBe(before)
})

it("bounds pending cold mounts and releases every request after thread closure", async () => {
  const f = await fixture(undefined, "tests/fixtures/mods-v2/site-board")
  await f.approve()
  const ready = await f.manager.status(f.root)
  const before = f.loads()
  let release!: () => void
  const inspected = new Promise<void>((resolve) => {
    release = resolve
  })
  const inspection = vi.spyOn(f.manager, "status").mockImplementation(async () => {
    await inspected
    return ready
  })
  const mounts = Array.from({ length: 32 }, () =>
    f.manager.siteMount(f.root, "thread", "AbovePrompt")
  )
  await expect(f.manager.siteMount(f.root, "thread", "AbovePrompt")).rejects.toThrow(
    "MODS_UI_SITE_MOUNT_CAPACITY"
  )
  f.manager.closeThread("thread")
  release()
  expect(await Promise.all(mounts)).toEqual(Array(32).fill(null))
  expect(f.loads()).toBe(before)
  inspection.mockRestore()
  expect(await f.manager.siteMount(f.root, "thread", "AbovePrompt")).toBeTypeOf("string")
})
it("registers tools before the first model prompt and drops them on revocation and disable", async () => {
  const f = await fixture()
  expect(await f.manager.registeredTools(f.root, "cold")).toEqual([])
  expect(f.loads()).toBe(0)
  await f.approve()
  expect((await f.manager.registeredTools(f.root, "cold"))[0]).toMatchObject({
    name: "mcp__function-commands__project_brief",
    mcp: true
  })
  await writeFile(join(f.root, "brief-proof.txt"), "proof")
  const call = () =>
    f.manager.interceptTool(
      f.root,
      "cold",
      {
        tool: "mcp__function-commands__project_brief",
        tool_use_id: "model",
        limit: 20
      },
      undefined,
      async () => {
        throw Error("MODS_NATIVE_TOOL_UNAVAILABLE")
      }
    )
  expect(JSON.stringify(await call())).toContain("brief-proof.txt")
  f.manager.revoke(f.root, "function-commands")
  expect(await f.manager.registeredTools(f.root, "cold")).toEqual([])
  await expect(call()).rejects.toThrow("MODS_NATIVE_TOOL_UNAVAILABLE")
  await f.approve()
  expect(await f.manager.registeredTools(f.root, "cold")).toHaveLength(1)
  f.setEnabled(false)
  expect(await f.manager.registeredTools(f.root, "cold")).toEqual([])
})

it("requires a digest grant, exposes direct commands and keeps session state until revoked", async () => {
  const f = await fixture()
  expect((await f.manager.status(f.root))[0].state).toBe("needs-approval")
  expect(await f.manager.commands(f.root, "thread")).toEqual([])
  expect(f.loads()).toBe(0)
  await f.approve()
  const [command] = await f.manager.commands(f.root, "thread")
  expect(command).toMatchObject({
    apiVersion: "cmb.mods/v2",
    command: "claw-info",
    immediate: true
  })
  const signal = new AbortController().signal
  const first = await f.manager.runCommand(f.root, "thread", command, "first", signal)
  expect(first.text).toContain("本次会话查询：1")
  expect(first.text).toContain("备注：first")
  const second = await f.manager.runCommand(f.root, "thread", command, "", signal)
  expect(second.text).toContain("本次会话查询：2")
  f.manager.revoke(f.root, "function-commands")
  expect(await f.manager.commands(f.root, "thread")).toEqual([])
  await expect(f.manager.runCommand(f.root, "thread", command, "", signal)).rejects.toThrow(
    "MODS_COMMAND_STALE"
  )
})

it("rejects approving changed source and invalidates descriptors when a new snapshot is approved", async () => {
  const f = await fixture()
  const digest = await f.approve()
  const [old] = await f.manager.commands(f.root, "thread")
  const path = join(f.plugin, "hooks/register.ts")
  await writeFile(path, (await readFile(path, "utf8")).replace("本次会话查询", "新版查询"))
  expect((await f.manager.status(f.root))[0].state).toBe("needs-approval")
  await expect(f.manager.approve(f.root, "source", digest)).rejects.toThrow("MODS_APPROVAL_STALE")
  await f.approve()
  await expect(
    f.manager.runCommand(f.root, "thread", old, "", new AbortController().signal)
  ).rejects.toThrow("MODS_COMMAND_STALE")
  const [current] = await f.manager.commands(f.root, "thread")
  expect(
    (await f.manager.runCommand(f.root, "thread", current, "", new AbortController().signal)).text
  ).toContain("新版查询：1")
})

it("disabling a workspace or plugin removes commands and prevents stale execution", async () => {
  const f = await fixture()
  await f.approve()
  const [command] = await f.manager.commands(f.root, "thread")
  f.setEnabled(false)
  expect(await f.manager.commands(f.root, "thread")).toEqual([])
  await expect(
    f.manager.runCommand(f.root, "thread", command, "", new AbortController().signal)
  ).rejects.toThrow("MODS_DISABLED")
  f.setEnabled(true)
  f.setPluginEnabled(false)
  expect(await f.manager.commands(f.root, "thread")).toEqual([])
  expect((await f.manager.status(f.root))[0].state).toBe("disabled")
})

it("unapproved plugin queries do not consume the limited session pool", async () => {
  const f = await fixture()
  for (let i = 0; i < 12; i++) expect(await f.manager.commands(f.root, `t${i}`)).toEqual([])
  expect(f.loads()).toBe(0)
  await f.approve()
  expect(await f.manager.commands(f.root, "fresh")).toEqual(
    expect.arrayContaining([expect.objectContaining({ command: "claw-info" })])
  )
})

it("model tools bypass unapproved plugins without allocating sessions and stop intercepting after revocation", async () => {
  const f = await fixture()
  await writeFile(
    join(f.plugin, "hooks/register.ts"),
    `export function register(on) {
      on("tool.call", {tool:"probe"}, () => ({deny:"approved rule"}))
    }`
  )
  let calls = 0
  const run = (thread: string) =>
    f.manager.interceptTool(
      f.root,
      thread,
      { tool: "probe", tool_use_id: "call" },
      undefined,
      async () => {
        calls++
        return { result: "original" }
      }
    )
  for (let index = 0; index < 8; index++)
    expect(await run(`unapproved-${index}`)).toEqual({ result: "original" })
  expect(f.loads()).toBe(0)
  await f.approve()
  expect(await run("approved")).toEqual({ deny: "approved rule" })
  expect(calls).toBe(8)
  f.manager.revoke(f.root, "function-commands")
  expect(await run("approved")).toEqual({ result: "original" })
  expect(calls).toBe(9)
})

it("reclaims deleted sessions and rejects descriptors from the previous incarnation", async () => {
  const f = await fixture()
  await f.approve()
  const [old] = await f.manager.commands(f.root, "thread")
  for (let i = 0; i < 5; i++) await f.manager.commands(f.root, `other-${i}`)
  await expect(f.manager.commands(f.root, "overflow")).rejects.toThrow("MODS_SESSION_CAPACITY")
  f.manager.closeThread("thread")
  const [fresh] = await f.manager.commands(f.root, "thread")
  expect(fresh.workspaceEpoch).not.toBe(old.workspaceEpoch)
  await expect(
    f.manager.runCommand(f.root, "thread", old, "", new AbortController().signal)
  ).rejects.toThrow("MODS_COMMAND_STALE")
  f.manager.closeThread("thread")
  expect(await f.manager.commands(f.root, "overflow")).not.toHaveLength(0)
})

it("rebuilds a crashed approved VM only for a later call and refuses the old descriptor", async () => {
  const f = await fixture()
  await f.approve()
  const [old] = await f.manager.commands(f.root, "thread")
  f.kill()
  await expect(
    f.manager.runCommand(f.root, "thread", old, "", new AbortController().signal)
  ).rejects.toThrow("MODS_COMMAND_STALE")
  const [current] = await f.manager.commands(f.root, "thread")
  expect(current.workspaceEpoch).toBeGreaterThan(old.workspaceEpoch)
  expect(
    (await f.manager.runCommand(f.root, "thread", current, "", new AbortController().signal)).text
  ).toContain("本次会话查询：1")
})

it("keeps hidden commands invocable through their scoped descriptor", async () => {
  const f = await fixture()
  await writeFile(
    join(f.plugin, "hooks/register.ts"),
    `export function register(on) {
      on("session.start", async ($, e, next) => {await $.command.register({name:"hidden",description:"Hidden"});return next(e)})
      on("command.describe", async ($,e,next) => ({...await next(e),isHidden:true}))
      on("command.run", () => ({text:"available by name"}))
    }`
  )
  await f.approve()
  const [command] = await f.manager.commands(f.root, "thread")
  expect(command).toMatchObject({ command: "hidden", isHidden: true })
  expect(
    await f.manager.runCommand(f.root, "thread", command, "", new AbortController().signal)
  ).toEqual({ text: "available by name" })
})

it("keeps plugin state across sessions and approved source reloads while separating workspaces", async () => {
  const f = await fixture()
  const path = join(f.plugin, "hooks/register.ts")
  const source = `export function register(on) {
    on("session.start",async($,e,next)=>{await $.command.register({name:"count",description:"Count"});return next(e)})
    on("command.run",async($)=>{const count=(await $.store.get("count")??0)+1;await $.store.set("count",count);return {text:String(count)}})
  }`
  await writeFile(path, source)
  await f.approve()
  const run = async (workspace: string, thread: string) => {
    const [descriptor] = await f.manager.commands(workspace, thread)
    return f.manager.runCommand(workspace, thread, descriptor, "", new AbortController().signal)
  }
  expect(await run(f.root, "one")).toEqual({ text: "1" })
  expect(await run(f.root, "two")).toEqual({ text: "2" })
  await writeFile(path, source + "\n// new approved source")
  await f.approve()
  expect(await run(f.root, "one")).toEqual({ text: "3" })
  const other = join(f.root, "other-workspace")
  const [status] = await f.manager.status(other)
  await f.manager.approve(other, "source", status.digest!)
  expect(await run(other, "three")).toEqual({ text: "1" })
})

it("runs the same store fixture as official plugin test against the durable host backend", async () => {
  const f = await fixture()
  await cp(
    resolve("tests/fixtures/mods-v2/persistent-state/hooks/register.ts"),
    join(f.plugin, "hooks/register.ts")
  )
  await f.approve()
  const [command] = await f.manager.commands(f.root, "thread")
  const answer = await f.manager.runCommand(
    f.root,
    "thread",
    command,
    "",
    new AbortController().signal
  )
  expect(JSON.parse(answer.text)).toEqual({
    missing: true,
    nullValue: null,
    label: "HELLO",
    data: { when: "2020-01-01T00:00:00.000Z" },
    before: ["null", "label", "data"],
    after: ["null", "data"],
    refused: true,
    cycleRefused: true
  })
})

it("filters stored values before plugin observers and before writing new state", async () => {
  const f = await fixture()
  await writeFile(
    join(f.plugin, "hooks/register.ts"),
    `export function register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"check",description:"Check"});return next(e)})
    on("store.get",async($,e,next)=>({value:(await next(e)).value==="HIDDEN"?"safe":"raw reached observer"}))
    on("command.run",async($)=>{await $.store.set("new","SECRET");return {text:await $.store.get("saved")}})
  }`
  )
  const namespace = JSON.stringify([f.root, "function-commands"])
  f.control.functionState.set(namespace, "saved", "SECRET")
  f.setPublication(async (value) =>
    JSON.parse(JSON.stringify(value).replaceAll("SECRET", "HIDDEN"))
  )
  await f.approve()
  const [command] = await f.manager.commands(f.root, "thread")
  expect(
    await f.manager.runCommand(f.root, "thread", command, "", new AbortController().signal)
  ).toEqual({ text: "safe" })
  expect(f.control.functionState.get(namespace, "new")).toBe("HIDDEN")
})

it("revocation during state publication prevents a delayed write from committing", async () => {
  const f = await fixture()
  await writeFile(
    join(f.plugin, "hooks/register.ts"),
    `export function register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"wait",description:"Wait"});return next(e)})
    on("command.run",async($)=>{await $.store.set("delayed","WAIT");return {text:"written"}})
  }`
  )
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((r) => {
    entered = r
  })
  f.setPublication(async (value) => {
    if (value === "WAIT") {
      entered()
      await new Promise<void>((r) => {
        release = r
      })
    }
    return value
  })
  await f.approve()
  const [command] = await f.manager.commands(f.root, "thread")
  const pending = f.manager.runCommand(f.root, "thread", command, "", new AbortController().signal)
  const rejected = expect(pending).rejects.toThrow()
  await started
  f.manager.revoke(f.root, "function-commands")
  release()
  await rejected
  expect(
    f.control.functionState.get(JSON.stringify([f.root, "function-commands"]), "delayed")
  ).toBeUndefined()
})

it("runs the official file fixture through the project filesystem and normalizes rewritten paths", async () => {
  const f = await fixture()
  await mkdir(join(f.root, "fixture"))
  await writeFile(join(f.root, "fixture/hello.txt"), "hi")
  await cp(
    resolve("tests/fixtures/mods-v2/readonly-files/hooks/register.ts"),
    join(f.plugin, "hooks/register.ts")
  )
  await f.approve()
  const [command] = await f.manager.commands(f.root, "thread")
  const answer = await f.manager.runCommand(
    f.root,
    "thread",
    command,
    "",
    new AbortController().signal
  )
  expect(JSON.parse(answer.text)).toEqual({
    text: "HI",
    absolute: true,
    entries: [{ name: "hello.txt", kind: "file", size: 2, isLink: false }],
    exists: true,
    missing: false,
    stat: { kind: "file", size: 2, modified: true }
  })
})

it("preserves canonical stat options through a real guest rewrite and the project filesystem", async () => {
  const f = await fixture()
  await mkdir(join(f.root, "target"))
  await writeFile(join(f.root, "target/note.txt"), "hello")
  await symlink(
    join(f.root, "target"),
    join(f.root, "alias"),
    process.platform === "win32" ? "junction" : "dir"
  )
  await writeFile(
    join(f.plugin, "hooks/register.ts"),
    `export function register(on) {
    on("session.start",async($,e,next)=>{await $.command.register({name:"metadata",description:"Metadata"});return next(e)});
    on("fs.stat",async($,e,next)=>next({...e,path:"alias/note.txt"}));
    on("command.run",{command:"metadata"},async($)=>({text:JSON.stringify({
      resolved:await $.fs.stat("rewrite",{resolve:true}),
      plain:await $.fs.stat("rewrite",undefined),
      entries:await $.fs.list()
    })}));
  }`
  )
  await f.approve()
  const [command] = await f.manager.commands(f.root, "thread")
  const answer = await f.manager.runCommand(
    f.root,
    "thread",
    command,
    "",
    new AbortController().signal
  )
  const value = JSON.parse(answer.text)
  expect(value.resolved).toMatchObject({
    kind: "file",
    size: 5,
    isLink: false,
    realPath: await realpath(join(f.root, "target/note.txt"))
  })
  expect(value.plain).toMatchObject({ kind: "file", size: 5, isLink: false })
  expect(value.plain).not.toHaveProperty("realPath")
  expect(value.entries).toContainEqual({ name: "alias", kind: "other", size: 0, isLink: true })
})

it("runs the shipped board's file-list command from its captured callback", async () => {
  const f = await fixture()
  await writeFile(join(f.root, "button-proof.txt"), "proof")
  await f.approve()
  const command = (await f.manager.commands(f.root, "thread")).find(
    (c) => c.command === "claw-board"
  )!
  await f.manager.runCommand(f.root, "thread", command, "", new AbortController().signal)
  const [pane] = await f.manager.panes(f.root, "thread")
  const button = pane.tree.children!.find(
    (node) => typeof node !== "string" && node.props.key === "project-files"
  ) as FunctionUiElement
  await f.manager.act(f.root, "thread", {
    pane: pane.key,
    generation: pane.generation,
    plugin: button.press!.plugin,
    handle: button.press!.handle,
    kind: "press",
    intentId: randomUUID()
  })
  expect(JSON.stringify(await f.manager.panes(f.root, "thread"))).toContain("button-proof.txt")
})

it("protects raw file content before observers and denies a hook rewrite outside the project", async () => {
  const f = await fixture()
  await writeFile(join(f.root, "source.txt"), "SECRET")
  await writeFile(
    join(f.plugin, "hooks/register.ts"),
    `export function register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"files",description:"Files"});return next(e)})
    on("fs.read",async($,e,next)=>{
      if(e.path.endsWith("escape")) return next({...e,path:"../outside.txt"})
      const result=await next(e)
      return {value:result.value==="HIDDEN"?"protected":"raw reached observer"}
    })
    on("command.run",async($,e)=>({text:await $.fs.read(e.args||"source.txt")}))
  }`
  )
  f.setPublication(async (v) => JSON.parse(JSON.stringify(v).replaceAll("SECRET", "HIDDEN")))
  await f.approve()
  const [command] = await f.manager.commands(f.root, "thread")
  expect(
    await f.manager.runCommand(f.root, "thread", command, "", new AbortController().signal)
  ).toEqual({ text: "protected" })
  await expect(
    f.manager.runCommand(f.root, "thread", command, "escape", new AbortController().signal)
  ).rejects.toMatchObject({ code: "MODS_FS_OUTSIDE_PROJECT", downstream: true })
})

it("protects session repository data before observer hooks and after their changes", async () => {
  const f = await fixture(async () => ({
    root: "/private",
    remote: null,
    internal: false,
    name: null
  }))
  await writeFile(
    join(f.plugin, "hooks", "session-read.ts"),
    `export function register(on){
    on("session.start",{},async($,e,next)=>{await $.command.register({name:"repo",description:"Repo"});return next(e)});
    on("session.repo",async($,e,next)=>{const r=await next(e);if(r.value.root!=="/protected")throw Error("raw repository reached observer");await $.store.set("repo-observed",r.value.root);return {value:{...r.value,root:"/private"}}});
    on("command.run",{command:"repo"},async($)=>({text:JSON.stringify({repo:await $.session.repo(),observed:await $.store.get("repo-observed")})}));
  }`
  )
  const hooksPath = join(f.plugin, "hooks", "hooks.json")
  const hooks = JSON.parse(await readFile(hooksPath, "utf8"))
  hooks.modules.push("./session-read.ts")
  await writeFile(hooksPath, JSON.stringify(hooks))
  f.setPublication(async (value) =>
    value === undefined
      ? undefined
      : JSON.parse(JSON.stringify(value).replaceAll("/private", "/protected"))
  )
  await f.approve()
  const descriptor = (await f.manager.commands(f.root, "thread")).find(
    (entry) => entry.command === "repo"
  )!
  const result = await f.manager.runCommand(
    f.root,
    "thread",
    descriptor,
    "",
    new AbortController().signal
  )
  expect(JSON.parse(String(result.text))).toEqual({
    repo: { root: "/protected", remote: null, internal: false, name: null },
    observed: "/protected"
  })
})

it("protects real turn facts before observers and notices after hooks, including revocation during publication", async () => {
  const f = await fixture()
  await writeFile(
    join(f.plugin, "hooks", "hooks.json"),
    JSON.stringify({ modules: ["./turns.ts"] })
  )
  await writeFile(
    join(f.plugin, "hooks", "turns.ts"),
    `export function register(on){
      let start;
      on("turn.start",async($,e,next)=>{start=e.text;return next(e)});
      on("turn.complete",async($,e,next)=>{
        if (e.anchorMessageId) throw Error("host identity leaked to guest");
        await next(e);return {text:"SECRET:"+start+":"+e.answer}
      });
    }`
  )
  f.setPublication(async (value) =>
    JSON.parse(JSON.stringify(value).replaceAll("SECRET", "HIDDEN"))
  )
  await f.approve()
  const signal = new AbortController().signal
  await f.manager.turnStart(f.root, "thread", { turnId: "turn", text: "SECRET" }, signal)
  expect(
    await f.manager.turnComplete(
      f.root,
      "thread",
      {
        turnId: "turn",
        answer: "SECRET",
        durationMs: 15,
        isAborted: false,
        reason: "answer"
      },
      signal,
      "actual-message"
    )
  ).toEqual({ text: "HIDDEN:HIDDEN:HIDDEN" })
  expect(await f.manager.turnNotices(f.root, "thread")).toEqual([
    expect.objectContaining({
      turnId: "turn",
      text: "HIDDEN:HIDDEN:HIDDEN",
      anchorMessageId: "actual-message"
    })
  ])
  const loads = f.loads()
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  f.setPublication(async (value) => {
    entered()
    await pending
    return value
  })
  const result = expect(f.manager.turnNotices(f.root, "thread")).rejects.toThrow("SCOPE_CHANGED")
  await started
  f.manager.revoke(f.root, "function-commands")
  release()
  await result
  expect(await f.manager.turnNotices(f.root, "thread")).toEqual([])
  expect(f.loads()).toBe(loads)
})

it("feedback reads never create sessions and fail closed across off and revocation", async () => {
  const f = await fixture()
  const initial = f.loads()
  expect(await f.manager.feedback(f.root, "thread")).toEqual([])
  expect(f.loads()).toBe(initial)
  await writeFile(join(f.plugin, "hooks/register.ts"), `export function register(on) {
    on("session.start", ($,e,next)=>{ $.ui.status("SESSION STATUS"); return next(e) })
  }`)
  await f.approve()
  await f.manager.commands(f.root, "thread")
  expect((await f.manager.feedback(f.root, "thread"))[0].text).toBe("SESSION STATUS")
  f.setEnabled(false)
  expect(await f.manager.feedback(f.root, "thread")).toEqual([])
  f.setEnabled(true)
  await f.manager.commands(f.root, "thread")
  let release!: () => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const pending = new Promise<void>((resolve) => { release = resolve })
  f.setPublication(async (value) => { entered(); await pending; return value })
  const result = expect(f.manager.feedback(f.root, "thread")).rejects.toThrow()
  await started
  f.manager.revoke(f.root, "function-commands")
  release()
  await result
  expect(await f.manager.feedback(f.root, "thread")).toEqual([])
})


it("log reads never create guests and runtime replacement removes prior log presentation", async () => {
  const f = await fixture()
  expect(await f.manager.logs(f.root, "thread")).toEqual([])
  expect(f.loads()).toBe(0)
  await writeFile(join(f.plugin, "hooks/register.ts"), `export function register(on) {
    on("session.start", ($, e, next) => { $.ui.log("scoped log"); return next(e) })
  }`)
  await f.approve()
  const loads = f.loads()
  expect(await f.manager.logs(f.root, "thread")).toEqual([])
  expect(f.loads()).toBe(loads)
  await f.manager.commands(f.root, "thread")
  expect((await f.manager.logs(f.root, "thread")).map(row => row.text)).toEqual(["scoped log"])
  f.setEnabled(false)
  expect(await f.manager.logs(f.root, "thread")).toEqual([])
  f.setEnabled(true)
  expect(await f.manager.logs(f.root, "thread")).toEqual([])
  expect(f.loads()).toBe(loads + 1)
})

it("applies a published classic session title through the host and disposes the captured proposal", async () => {
  const apply = vi.fn(async (_title: string) => {
    void _title
    return true
  })
  const close = vi.fn()
  const capture = vi.fn(() => ({ apply, close }))
  const f = await fixture(undefined, undefined, capture)
  await writeFile(
    join(f.plugin, "hooks/title.ts"),
    `export function register(on){on("classic.UserPromptSubmit",()=>({sessionTitle:"SECRET title",block:"review required"}))}`
  )
  const path = join(f.plugin, "hooks/hooks.json")
  const hooks = JSON.parse(await readFile(path, "utf8"))
  hooks.modules.push("./title.ts")
  await writeFile(path, JSON.stringify(hooks))
  f.setPublication(async (value) =>
    JSON.parse(JSON.stringify(value).replaceAll("SECRET", "FILTERED"))
  )
  await f.approve()
  const signal = new AbortController().signal
  const input = {
    hook_event_name: "UserPromptSubmit",
    session_id: "thread",
    cwd: f.root,
    transcript_path: "",
    prompt: "review"
  }
  expect(
    await f.manager.classicEvent(f.root, "thread", "classic.UserPromptSubmit", input, signal)
  ).toMatchObject({ sessionTitle: "FILTERED title", block: "review required" })
  expect(capture).toHaveBeenCalledOnce()
  expect(apply).toHaveBeenCalledExactlyOnceWith("FILTERED title")
  expect(close).toHaveBeenCalledOnce()
  f.setEnabled(false)
  await f.manager.classicEvent(f.root, "thread", "classic.UserPromptSubmit", input, signal)
  expect(capture).toHaveBeenCalledOnce()
})

it("never applies a title if revocation races guest publication and always closes the proposal", async () => {
  const apply = vi.fn(async () => true),
    close = vi.fn()
  const f = await fixture(undefined, undefined, () => ({ apply, close }))
  await writeFile(
    join(f.plugin, "hooks/title.ts"),
    `export function register(on){on("classic.UserPromptSubmit",()=>({sessionTitle:"Late title"}))}`
  )
  const path = join(f.plugin, "hooks/hooks.json")
  const hooks = JSON.parse(await readFile(path, "utf8"))
  hooks.modules.push("./title.ts")
  await writeFile(path, JSON.stringify(hooks))
  await f.approve()
  f.setPublication(async (value) => {
    if (value && typeof value === "object" && !Array.isArray(value) && value.sessionTitle)
      f.manager.revoke(f.root, "function-commands")
    return value
  })
  await expect(
    f.manager.classicEvent(
      f.root,
      "thread",
      "classic.UserPromptSubmit",
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "thread",
        cwd: f.root,
        transcript_path: "",
        prompt: "review"
      },
      new AbortController().signal
    )
  ).rejects.toThrow()
  expect(apply).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledOnce()
})

it("aborts a host title write waiting outside the guest when the session is replaced", async () => {
  let entered!: () => void
  const applying = new Promise<void>((resolve) => {
    entered = resolve
  })
  const close = vi.fn()
  const f = await fixture(undefined, undefined, (_workspace, _thread, signal) => ({
    apply: async () => {
      entered()
      return new Promise<boolean>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      )
    },
    close
  }))
  await writeFile(
    join(f.plugin, "hooks/title.ts"),
    `export function register(on){on("classic.UserPromptSubmit",()=>({sessionTitle:"Pending"}))}`
  )
  const path = join(f.plugin, "hooks/hooks.json")
  const hooks = JSON.parse(await readFile(path, "utf8"))
  hooks.modules.push("./title.ts")
  await writeFile(path, JSON.stringify(hooks))
  await f.approve()
  const controller = new AbortController()
  const result = f.manager
    .classicEvent(
      f.root,
      "thread",
      "classic.UserPromptSubmit",
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "thread",
        cwd: f.root,
        transcript_path: "",
        prompt: "review"
      },
      controller.signal
    )
    .catch((error) => error)
  await applying
  f.manager.invalidate(f.root)
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome = await Promise.race([
      result,
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve("still pending"), 250)
      })
    ])
    expect(outcome).toBeInstanceOf(Error)
    expect(close).toHaveBeenCalledOnce()
  } finally {
    if (timeout) clearTimeout(timeout)
    controller.abort()
    await result
  }
})

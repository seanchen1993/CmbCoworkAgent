import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { ModJson } from "../../../shared/mods/types"
import { captureDirectDisplayScope } from "../../ipc/mods-display-thread-scope"
import { ClawStore } from "../claw-store"
import { ModControlStore } from "../control-store"
import { FunctionGuestRuntime } from "./guest-runtime"
import { compileFunctionPlugin } from "./loader"
import { FunctionModsManager } from "./manager"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture(withObserver = false, brokenEnabled = false) {
  const workspace = await mkdtemp(join(tmpdir(), "site-disabled-invalid-"))
  const broken = join(workspace, "broken")
  await mkdir(join(broken, "mods"), { recursive: true })
  await writeFile(join(broken, "plugin.json"), JSON.stringify({ name: "broken", version: "1.0.0" }))
  await writeFile(
    join(broken, "mods/manifest.json"),
    JSON.stringify({
      apiVersion: "cmb.mods/v2",
      id: "broken",
      modules: ["./missing.ts"]
    })
  )
  const sources = [{ id: "broken", name: "broken", path: broken, enabled: brokenEnabled }]
  const store = new ModControlStore(join(workspace, "control.sqlite"))
  if (withObserver) {
    const observer = join(workspace, "observer")
    await mkdir(join(observer, "hooks"), { recursive: true })
    await writeFile(
      join(observer, "plugin.json"),
      '{"name":"unrelated-observer","version":"1.0.0"}'
    )
    await writeFile(join(observer, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
    await writeFile(
      join(observer, "hooks/register.ts"),
      `export function register(on) {
      on("ui.render", {component:"AbovePrompt"}, (_$, event, next)=>next(event))
    }`
    )
    const compiled = await compileFunctionPlugin(observer)
    store.grant(workspace, `function:${compiled.name}`, compiled.digest, true)
    sources.push({ id: "observer", name: compiled.name, path: observer, enabled: true })
  }
  let protects = true
  let applied = false
  let direct = true
  let usage: "chat" | "project" = "chat"
  let incarnation = "first"
  const captureDisplayScope = (workspace: string, threadId: string) =>
    captureDirectDisplayScope(workspace, threadId, {
      database: () => store,
      read: () => ({
        created_at: 1,
        metadata: JSON.stringify({ workspacePath: workspace, cmb_thread_incarnation: incarnation })
      }),
      canonical: path => path,
      isChild: () => false
    })
  const guests: FunctionGuestRuntime[] = []
  const publish = vi.fn(
    async (_workspace: string, value: ModJson): Promise<ModJson> =>
      JSON.parse(JSON.stringify(value).replaceAll("PRIVATE_BODY", "SAFE_BODY")) as ModJson
  )
  const load = vi.fn(
    async (code: string, options?: Parameters<typeof FunctionGuestRuntime.create>[1]) => {
      const guest = await FunctionGuestRuntime.create(code, options)
      guests.push(guest)
      return guest
    }
  )
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => sources,
      enabled: () => true,
      protects: () => protects,
      captureSiteGuard: (workspace, threadId) => captureDisplayScope(workspace, threadId).assertCurrent,
      captureDisplayScope: (workspace, threadId) =>
        direct ? captureDisplayScope(workspace, threadId) : undefined,
      capabilityContext: () => ({ identity: usage, usage }),
      clawApplicable: () => applied,
      publish,
      changed() {
        /* This regression inspects returned drawings directly. */
      }
    },
    () => {
      const owned: FunctionGuestRuntime[] = []
      return {
        async load(code, options) {
          const guest = await load(code, options)
          owned.push(guest)
          return guest
        },
        stop() {
          owned.forEach((guest) => guest.dispose())
        },
        async stopAndDrain() {
          owned.forEach((guest) => guest.dispose())
        }
      }
    }
  )
  cleanups.push(async () => {
    manager.close()
    guests.forEach((guest) => guest.dispose())
    await new Promise((resolve) => setTimeout(resolve, 20))
    store.close()
    await rm(workspace, { recursive: true, force: true })
  })
  return {
    workspace,
    manager,
    store,
    broken,
    sources,
    publish,
    load,
    async selectPair(contextMeter = false, threadIds = ["thread"]) {
      await writeFile(
        join(broken, "mods/manifest.json"),
        '{"apiVersion":"cmb.mods/v2","id":"broken","entry":"./register.ts"}'
      )
      await writeFile(join(broken, "mods/register.ts"),
        'export function register(on) { on("ui.render", (_, event, next) => next(event)) }')
      const capabilities = (await manager.status(workspace)).map(({ pluginId, name, digest }) => {
        if (!digest) throw Error("Expected the exact source digest")
        store.grant(workspace, `function:${name}`, digest, true)
        return { pluginId, name, digest }
      })
      const claws = new ClawStore(store)
      for (const threadId of threadIds) {
        claws.apply(workspace, JSON.stringify([threadId, "legacy"]),
          { id: "selected", name: "Selected", capabilities, builtins: { contextMeter } },
          claws.read(workspace).revision)
      }
      applied = true
      return capabilities
    },
    replaceThread() {
      incarnation = "replacement"
    },
    setUsage(value: typeof usage) {
      usage = value
    },
    setNonDirect() {
      direct = false
    },
    setProtection(value: boolean) {
      protects = value
      manager.invalidate(workspace)
    }
  }
}

it("reads more protected messages in a second chat than the held site limit", async () => {
  const f = await fixture(true)
  await f.selectPair(false, ["first", "second"])
  const facts = { text: "PRIVATE_BODY", isFirstOfReply: true }
  const held = await f.manager.siteMountOutcome(f.workspace, "first", "AssistantMessage")
  if (held.state !== "mounted") throw Error("Expected a genuine owned host site")
  const states: string[] = []
  for (let row = 0; row < 40; row++) {
    const outcome = await f.manager.siteRead(
      f.workspace, "second", "AssistantMessage", facts, `row-${row}`
    )
    states.push(outcome.state)
    expect(JSON.stringify(outcome)).toContain("SAFE_BODY")
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE_BODY")
  }
  expect(new Set(states)).toEqual(new Set(["projected"]))
  expect(await f.manager.siteRender(f.workspace, "first", held.owner, facts)).not.toBeNull()
  await f.manager.siteUnmount(f.workspace, "first", held.owner)
  expect(f.load).not.toHaveBeenCalled()
})

it("rejects a host-only projection when the catalog changes during protected publication", async () => {
  const f = await fixture(true)
  await f.selectPair()
  const facts = { text: "PRIVATE_BODY", isFirstOfReply: true }
  f.publish.mockImplementationOnce(async (_workspace, value) => {
    f.manager.pluginsChanged(join(f.workspace, "other-workspace"), ["removed"])
    return JSON.parse(JSON.stringify(value).replaceAll("PRIVATE_BODY", "SAFE_BODY"))
  })
  await expect(f.manager.siteRead(f.workspace, "thread", "AssistantMessage", facts, "row"))
    .rejects.toMatchObject({ code: "MODS_SCOPE_CHANGED" })
  const fresh = await f.manager.siteRead(f.workspace, "thread", "AssistantMessage", facts, "row")
  expect(fresh.state).toBe("projected")
  expect(JSON.stringify(fresh)).toContain("SAFE_BODY")
  expect(f.load).not.toHaveBeenCalled()
})

it.each([
  ["before first display", false, false],
  ["before first display", true, false],
  ["while open", false, false],
  ["while open", true, false],
  ["before first display", false, true],
  ["before first display", true, true]
] as const)(
  "keeps native chat text readable after disable %s with protection %s and context meter %s",
  async (when, protects, contextMeter) => {
    const f = await fixture(true, when === "while open")
    f.setProtection(protects)
    const capabilities = await f.selectPair(contextMeter)
    if (when === "while open") {
      expect((await f.manager.siteRead(f.workspace, "thread", "AssistantMessage",
        { text: "PRIVATE_BODY", isFirstOfReply: true })).state).toBe("mounted")
      expect(f.load).toHaveBeenCalledTimes(2)
      f.sources[0].enabled = false
      f.manager.pluginsChanged(f.workspace, ["broken"])
      f.load.mockClear()
      f.publish.mockClear()
    }
    for (const [site, facts] of [
      ["UserMessage", { text: "PRIVATE_BODY", isExpanded: false }],
      ["AssistantMessage", { text: "PRIVATE_BODY", isFirstOfReply: true }]
    ] as const) {
      const drawing = await f.manager.siteRead(f.workspace, "thread", site, facts)
      if (protects) {
        expect(drawing.state).toBe("mounted")
        expect(JSON.stringify(drawing)).toContain("SAFE_BODY")
        expect(JSON.stringify(drawing)).not.toContain("PRIVATE_BODY")
      } else {
        expect(drawing).toEqual({ state: "inactive", reason: "no-protection-or-functions" })
      }
    }
    if (protects) expect(f.publish).toHaveBeenCalled()
    else expect(f.publish).not.toHaveBeenCalled()
    if (contextMeter) {
      await expect(f.manager.siteRead(f.workspace, "thread", "AbovePrompt", {}))
        .rejects.toMatchObject({ code: "CLAW_CAPABILITY_CHANGED" })
      expect(f.manager.clawSelection(f.workspace, "thread")?.builtins).toEqual({
        contextMeter: true
      })
    }
    expect(f.load).not.toHaveBeenCalled()
    expect(f.manager.clawSelection(f.workspace, "thread")?.capabilities).toEqual(capabilities)
    await expect(f.manager.effectiveStatus(f.workspace, "thread")).rejects.toMatchObject({
      code: "CLAW_CAPABILITY_CHANGED"
    })
    const nativeTurn = vi.fn()
    await expect(f.manager.turnStep(f.workspace, "thread",
      { turnId: "review", index: 0, messageCount: 1, model: "fixture" },
      nativeTurn, new AbortController().signal)).rejects.toMatchObject({
      code: "CLAW_CAPABILITY_CHANGED"
    })
    expect(nativeTurn).not.toHaveBeenCalled()
  }
)

it.each([
  "changed", "revoked", "other-unapproved", "unknown-protection",
  "project", "non-direct", "tool-result"
] as const)(
  "keeps history closed when the disabled selection is %s",
  async (condition) => {
    const f = await fixture(true)
    const [disabled, ready] = await f.selectPair()
    if (condition === "changed") {
      f.setProtection(false)
      await writeFile(join(f.broken, "mods/register.ts"), "export function register() {}")
    }
    if (condition === "revoked" || condition === "other-unapproved") {
      f.setProtection(false)
      const source = condition === "revoked" ? disabled : ready
      f.store.grant(f.workspace, `function:${source.name}`, source.digest, false)
    }
    if (condition === "unknown-protection") f.setProtection(undefined as unknown as boolean)
    if (condition === "project") f.setUsage("project")
    if (condition === "non-direct") f.setNonDirect()
    const component = condition === "tool-result" ? "ToolResult" : "AssistantMessage"
    await expect(f.manager.siteRead(f.workspace, "thread", component,
      { text: "PRIVATE_BODY", isFirstOfReply: true },
      component === "AssistantMessage" ? "candidate-row" : undefined)).rejects.toMatchObject({
      code: condition === "unknown-protection"
        ? "MODS_UI_SITE_PROTECTION_REQUIRED" : "CLAW_CAPABILITY_CHANGED"
    })
    expect(f.publish).not.toHaveBeenCalled()
    expect(f.load).not.toHaveBeenCalled()
  }
)

it.each(["thread-replaced", "source-replaced", "catalog-changed", "enable-aba"] as const)(
  "drops the pending protected transcript when %s during catalog inspection",
  async (change) => {
    const f = await fixture(true)
    await f.selectPair()
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const status = f.manager.status.bind(f.manager)
    vi.spyOn(f.manager, "status").mockImplementationOnce(async workspace => {
      const available = await status(workspace)
      entered.resolve()
      await finish.promise
      return available
    })
    const pending = f.manager.siteRead(f.workspace, "thread", "AssistantMessage",
      { text: "PRIVATE_BODY", isFirstOfReply: true })
    const result = pending.then(value => value, error => error)
    await entered.promise
    if (change === "thread-replaced") f.replaceThread()
    if (change === "source-replaced") f.sources[0].path = f.sources[1].path
    if (change === "catalog-changed") f.manager.pluginsChanged(f.workspace, ["broken"])
    if (change === "enable-aba") {
      f.sources[0].enabled = true
      f.manager.pluginsChanged(f.workspace, ["broken"])
      f.sources[0].enabled = false
      f.manager.pluginsChanged(f.workspace, ["broken"])
    }
    finish.resolve()
    expect(await result).toMatchObject(change === "enable-aba" ? { state: "retired" } : {
      code: change === "thread-replaced" ? "MODS_CALL_SCOPE_CHANGED" :
        change === "source-replaced" ? "CLAW_CAPABILITY_CHANGED" : "MODS_SCOPE_CHANGED"
    })
    expect(f.publish).not.toHaveBeenCalled()
    expect(f.load).not.toHaveBeenCalled()
  }
)

it("keeps disabled broken source diagnostics while drawing protected native messages without a guest", async () => {
  const f = await fixture()
  expect(await f.manager.status(f.workspace)).toMatchObject([
    { pluginId: "broken", state: "invalid" }
  ])
  expect(await f.manager.effectiveStatus(f.workspace, "thread")).toEqual([])
  for (const component of ["UserMessage", "AssistantMessage"] as const) {
    const outcome = await f.manager.siteMountOutcome(f.workspace, "thread", component)
    expect(outcome.state).toBe("mounted")
    if (outcome.state !== "mounted") throw Error("protected native owner required")
    const snapshot = await f.manager.siteRender(
      f.workspace,
      "thread",
      outcome.owner,
      component === "UserMessage"
        ? { text: "PRIVATE_BODY", isExpanded: false }
        : { text: "PRIVATE_BODY", isFirstOfReply: true }
    )
    expect(JSON.stringify(snapshot)).toContain("SAFE_BODY")
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_BODY")
  }
  expect(f.load).not.toHaveBeenCalled()
  expect(f.publish).toHaveBeenCalled()
  f.setProtection(false)
  expect(await f.manager.siteMountOutcome(f.workspace, "thread", "AssistantMessage")).toEqual({
    state: "inactive",
    reason: "no-protection-or-functions"
  })
})

it("renders messages through a real ready unrelated observer despite a disabled broken source", async () => {
  const f = await fixture(true)
  expect(
    (await f.manager.effectiveStatus(f.workspace, "thread")).map((item) => item.state)
  ).toEqual(["ready"])
  const outcome = await f.manager.siteMountOutcome(f.workspace, "thread", "AssistantMessage")
  expect(outcome.state).toBe("mounted")
  if (outcome.state !== "mounted") throw Error("ready observer owner required")
  const snapshot = await f.manager.siteRender(f.workspace, "thread", outcome.owner, {
    text: "PRIVATE_BODY",
    isFirstOfReply: true
  })
  expect(JSON.stringify(snapshot)).toContain("SAFE_BODY")
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_BODY")
  expect(f.load).toHaveBeenCalledOnce()
})

it.each(["needs-approval", "disabled"] as const)(
  "draws protected user and assistant messages after a real turnStep retained an empty %s session",
  async (mode) => {
    const f = await fixture()
    await writeFile(
      join(f.broken, "mods/manifest.json"),
      JSON.stringify({
        apiVersion: "cmb.mods/v2",
        id: "broken",
        entry: "./register.ts"
      })
    )
    await writeFile(
      join(f.broken, "mods/register.ts"),
      `export function register(on) {
      on("ui.render", (_$, event, next)=>next(event))
    }`
    )
    f.sources[0].enabled = mode === "needs-approval"
    expect(await f.manager.status(f.workspace)).toMatchObject([{ state: mode }])
    const stream = await f.manager.turnStep(
      f.workspace,
      "thread",
      {
        turnId: "native-turn",
        index: 0,
        messageCount: 1,
        model: "controlled-native-model"
      },
      async function* () {
        yield { kind: "text", text: "PRIVATE_BODY" }
        return { text: "PRIVATE_BODY" }
      },
      new AbortController().signal
    )
    const chunks: ModJson[] = []
    for await (const chunk of stream) chunks.push(chunk)
    expect(chunks).toEqual([{ kind: "text", text: "SAFE_BODY" }])
    expect(await stream.result).toEqual({ text: "SAFE_BODY" })
    expect(f.manager.runtimeSessions().sessions).toHaveLength(1)
    expect(f.load).not.toHaveBeenCalled()
    for (const component of ["UserMessage", "AssistantMessage"] as const) {
      const outcome = await f.manager.siteMountOutcome(f.workspace, "thread", component)
      expect(outcome.state).toBe("mounted")
      if (outcome.state !== "mounted")
        throw Error("native display must not treat an empty session as retired")
      const snapshot = await f.manager.siteRender(
        f.workspace,
        "thread",
        outcome.owner,
        component === "UserMessage"
          ? { text: "PRIVATE_BODY", isExpanded: false }
          : { text: "PRIVATE_BODY", isFirstOfReply: true }
      )
      expect(JSON.stringify(snapshot)).toContain("SAFE_BODY")
      expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_BODY")
    }
    f.setProtection(false)
    expect(await f.manager.siteMountOutcome(f.workspace, "thread", "AssistantMessage")).toEqual({
      state: "inactive",
      reason: "no-protection-or-functions"
    })
  }
)

it.each([false, true])(
  "fails closed for an enabled broken source, including previously approved=%s",
  async (previouslyApproved) => {
    const f = await fixture(false, true)
    if (previouslyApproved) {
      await writeFile(
        join(f.broken, "mods/manifest.json"),
        JSON.stringify({
          apiVersion: "cmb.mods/v2",
          id: "broken",
          entry: "./missing.ts"
        })
      )
      await writeFile(
        join(f.broken, "mods/missing.ts"),
        `export function register(on) {
        on("ui.render", (_$, event, next)=>next(event))
      }`
      )
      const compiled = await compileFunctionPlugin(f.broken)
      f.store.grant(f.workspace, `function:${compiled.name}`, compiled.digest, true)
      expect(await f.manager.effectiveStatus(f.workspace, "thread")).toMatchObject([
        { state: "ready" }
      ])
      await rm(join(f.broken, "mods/missing.ts"))
      f.manager.invalidate(f.workspace)
    }
    expect(await f.manager.effectiveStatus(f.workspace, "thread")).toMatchObject([
      { state: "invalid" }
    ])
    expect(await f.manager.siteMountOutcome(f.workspace, "thread", "AssistantMessage")).toEqual({
      state: "retired"
    })
    expect(f.publish).not.toHaveBeenCalled()
    expect(f.load).not.toHaveBeenCalled()
  }
)

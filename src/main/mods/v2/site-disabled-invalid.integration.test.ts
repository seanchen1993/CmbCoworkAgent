import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { ModJson } from "../../../shared/mods/types"
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
      captureSiteGuard: () => () => {},
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
    setProtection(value: boolean) {
      protects = value
      manager.invalidate(workspace)
    }
  }
}

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

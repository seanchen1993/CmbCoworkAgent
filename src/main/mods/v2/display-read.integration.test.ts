import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import type { FunctionPluginPromptOrigin } from "../../../shared/mods/v2/plugin-prompt"
import { ModControlStore } from "../control-store"
import { filterModData } from "../publication"
import { FUNCTION_DISPLAY_PROTOCOL } from "./display-rollout"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionModsManager } from "./manager"
import { FunctionSession } from "./session"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

async function fixture(
  body: string,
  prefix = "",
  options: {
    publish?(value: ModJson, call: number): Promise<ModJson> | ModJson
    origin?: FunctionPluginPromptOrigin
    noSources?: boolean
    globallyEnabled?(): boolean
    noDisplayScope?: boolean
    captureSiteGuard?: () => () => void
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "display-read-"))
  const path = join(root, "plugin")
  await mkdir(join(path, "mods"), { recursive: true })
  await writeFile(
    join(path, "plugin.json"),
    JSON.stringify({ name: "display", version: "1.0.0", mods: "mods/manifest.json" })
  )
  await writeFile(
    join(path, "mods/manifest.json"),
    JSON.stringify({ apiVersion: "cmb.mods/v2", id: "display", entry: "main.ts" })
  )
  const file = join(path, "mods/main.ts")
  await writeFile(file, `${prefix}\nexport function register(on) { ${body} }`)
  const source = {
    id: "source",
    name: "display",
    path,
    enabled: true,
    version: "1.0.0",
    description: "",
    author: "",
    skillCount: 0,
    mcpServerCount: 0,
    hookCount: 0,
    createdAt: "2026-10-22",
    updatedAt: "2026-10-22"
  }
  const database = {},
    control = new ModControlStore(join(root, "control.sqlite"))
  const guests: FunctionGuestRuntime[] = [],
    events: string[] = []
  const changed = vi.fn()
  const publish = vi.fn(
    async (_workspace: string, value: ModJson): Promise<ModJson> =>
      options.publish
        ? options.publish(value, publish.mock.calls.length)
        : (JSON.parse(JSON.stringify(value).replaceAll("PRIVATE", "SAFE")) as ModJson)
  )
  const manager = new FunctionModsManager(
    control,
    {
      plugins: () => (options.noSources ? [] : [source]),
      enabled: () => options.globallyEnabled?.() ?? true,
      protects: () => options.globallyEnabled?.() ?? true,
      captureSiteGuard: options.captureSiteGuard ?? (() => () => {}),
      captureDisplayScope: () =>
        options.noDisplayScope
          ? undefined
          : {
              database,
              workspace: root,
              threadId: "thread",
              incarnation: { token: "current", legacyCreatedAt: 1 },
              assertCurrent: () => {}
            },
      userMessageOrigin: (_threadId, messageId) =>
        messageId === "native-message" ? options.origin : undefined,
      changed,
      publish
    },
    () => ({
      async load(code, options) {
        const guest = await FunctionGuestRuntime.create(code, options)
        const invoke = guest.invoke.bind(guest)
        vi.spyOn(guest, "invoke").mockImplementation((...args) => {
          events.push(args[3].event)
          return invoke(...args)
        })
        guests.push(guest)
        return guest
      },
      stop() {
        for (const guest of guests) void guest.dispose()
      },
      async stopAndDrain() {
        await Promise.all(guests.map((guest) => guest.dispose()))
      }
    })
  )
  cleanup.push(async () => {
    manager.close()
    await Promise.all(guests.map((guest) => guest.dispose()))
    control.close()
    await rm(root, { recursive: true, force: true })
  })
  const statuses = await manager.status(root)
  if (options.noSources) expect(statuses).toEqual([])
  else {
    const [status] = statuses
    expect(status.state, status.error).toBe("needs-approval")
    await manager.approve(root, "source", status.digest!)
  }
  events.length = 0
  const read = (text = "PRIVATE", row = "message:block") =>
    manager.siteRead(root, "thread", "AssistantMessage", { text, isFirstOfReply: true }, row)
  return { root, file, control, manager, events, read, changed, publish }
}

it("routes an AbovePrompt-only literal Mod away from transcript guest drawing", async () => {
  const f = await fixture(`on("ui.render", {component:"AbovePrompt"}, ($,e,next)=>next(e))`)
  const first = await f.read()
  expect(first.state).toBe("projected")
  expect(f.events.filter((event) => event === "ui.render")).toHaveLength(0)
  const mount = vi.spyOn(f.manager, "siteMountOutcome")
  expect((await f.read()).state).toBe("projected")
  expect(mount).not.toHaveBeenCalled()
  expect(JSON.stringify(first)).toContain("SAFE")
})

it("hands off a real pure Mod drawing then reuses it without a guest or drawing owner", async () => {
  const f = await fixture(`on("ui.render", {component:"AssistantMessage"}, ($,e)=>
    ({type:"Text",props:{},children:[e.props.text]}))`)
  const first = await f.read()
  expect(first.state).toBe("projected")
  expect(JSON.stringify(first)).not.toContain("PRIVATE")
  expect(f.events.filter((event) => event === "ui.render")).toHaveLength(1)
  const mounts = vi.spyOn(f.manager, "siteMountOutcome")
  expect(await f.read()).toEqual(first)
  expect(mounts).not.toHaveBeenCalled()
  expect(f.events.filter((event) => event === "ui.render")).toHaveLength(1)
  await f.read("changed PRIVATE")
  expect(f.events.filter((event) => event === "ui.render")).toHaveLength(2)
})

it("admits recent passive rows after dependency proofs reach the existing 96-entry limit", async () => {
  const f = await fixture(`on("ui.render", {component:"AssistantMessage"}, ($,e)=>
    ({type:"Text",props:{},children:[e.props.text]}))`)
  for (let index = 0; index < 96; index++)
    expect((await f.read("PRIVATE", `row-${index}`)).state).toBe("projected")
  // Touch row zero: the dependency reclaim must follow cache LRU, not insertion order.
  await f.read("PRIVATE", "row-0")
  expect((await f.read("PRIVATE", "row-96")).state).toBe("projected")
  const before = f.events.filter((event) => event === "ui.render").length
  await f.read("PRIVATE", "row-0")
  expect((await f.read("PRIVATE", "row-96")).state).toBe("projected")
  expect(f.events.filter((event) => event === "ui.render")).toHaveLength(before)
  expect((await f.read("PRIVATE", "row-1")).state).toBe("projected")
  expect(f.events.filter((event) => event === "ui.render")).toHaveLength(before + 1)
  // Eviction observers are outside the pure region: source changes there must fence publication.
  f.changed.mockImplementation((_thread, scope) => {
    if (String(scope).startsWith("site-projection:"))
      writeFileSync(f.file, "export function register(){}")
  })
  await expect(f.read("PRIVATE", "row-97")).rejects.toThrow()
}, 15000)

it.each(["UserMessage", "AssistantMessage"] as const)(
  "publishes a whole %s under the native guard without a persistent display scope",
  async (component) => {
    const f = await fixture("", "", { noSources: true, noDisplayScope: true })
    const text = "PRIVATE".repeat(1500)
    const props: ModObject =
      component === "UserMessage"
        ? { text, origin: { kind: "plugin", name: "forged" }, isExpanded: true }
        : { text, isFirstOfReply: true }
    const read = () => f.manager.siteRead(f.root, "thread", component, props, "child-message")
    const first = await read()
    expect(first.state).toBe("projected")
    if (first.state !== "projected") throw Error("NO_PROJECTION")
    expect(first.snapshot.expiresAt).toBe(0)
    expect(first.snapshot.data.hostMessage?.text).toBe(text.replaceAll("PRIVATE", "SAFE"))
    if (component === "UserMessage")
      expect(first.snapshot.data.hostMessage?.origin).toEqual({ kind: "unclassified" })
    expect(f.events).toEqual([])
    const count = f.publish.mock.calls.length
    expect(count).toBe(2)
    expect((await read()).state).toBe("projected")
    expect(f.publish).toHaveBeenCalledTimes(count + 2)
  }
)

it.each([1, 2])(
  "rejects child replacement across host publication boundary %i",
  async (boundary) => {
    let live = true
    let release!: () => void
    const f = await fixture("", "", {
      noSources: true,
      noDisplayScope: true,
      captureSiteGuard: () => () => {
        if (!live) throw Error("CHILD_REPLACED")
      },
      publish: async (value, call) => {
        if (call === boundary)
          await new Promise<void>((done) => {
            release = done
          })
        return value
      }
    })
    const result = f.read("PRIVATE".repeat(1500))
    const rejected = expect(result).rejects.toThrow("CHILD_REPLACED")
    await expect.poll(() => Boolean(release)).toBe(true)
    live = false
    release()
    await rejected
    expect(f.publish).toHaveBeenCalledTimes(boundary)
  }
)

it.each(["close", "global-toggle"] as const)(
  "retires unretained child reads on %s without releasing physical work early",
  async (change) => {
    let global = true
    let release!: () => void
    const f = await fixture("", "", {
      noSources: true,
      noDisplayScope: true,
      globallyEnabled: () => global,
      publish: async (value) => {
        await new Promise<void>((done) => {
          release = done
        })
        return value
      }
    })
    const result = f.read("PRIVATE".repeat(1500))
    const rejected = expect(result).rejects.toThrow()
    await expect.poll(() => Boolean(release)).toBe(true)
    if (change === "close") f.manager.closeThread("thread")
    else {
      global = false
      f.manager.invalidateAll()
      global = true
      f.manager.invalidateAll()
    }
    expect(() => f.manager.setDisplayProjectionEnabled(false)).toThrow("MODS_DISPLAY_DRAINING")
    release()
    await rejected
    expect(f.publish).toHaveBeenCalledTimes(1)
    expect(() => f.manager.setDisplayProjectionEnabled(false)).not.toThrow()
  }
)

it("coalesces simultaneous cold passive rows without sharing a real drawing owner", async () => {
  const f = await fixture(`on("ui.render", {component:"AssistantMessage"}, ($,e)=>
    ({type:"Text",props:{},children:[e.props.text]}))`)
  await f.read("warm", "warm-row")
  f.events.length = 0
  const [first, second] = await Promise.all([
    f.read("PRIVATE cold", "cold-row"),
    f.read("PRIVATE cold", "cold-row")
  ])
  expect(first.state).toBe("projected")
  expect(second).toEqual(first)
  expect(f.events.filter((event) => event === "ui.render")).toHaveLength(1)
  expect(JSON.stringify(second)).not.toMatch(/"(?:owner|generation|handle)":/)
})

it("keeps separate current owners when a passive candidate returns active UI", async () => {
  const f = await fixture(`on("ui.render", {component:"AssistantMessage"}, () =>
    ({type:"Button",props:{label:"details"}}))`)
  const warm = await f.read("warm", "warm-row")
  if (warm.state === "mounted") await f.manager.siteUnmount(f.root, "thread", warm.owner)
  f.events.length = 0
  const [first, second] = await Promise.all([
    f.read("PRIVATE cold", "cold-row"),
    f.read("PRIVATE cold", "cold-row")
  ])
  expect(first.state).toBe("mounted")
  expect(second.state).toBe("mounted")
  expect(f.events.filter((event) => event === "ui.render")).toHaveLength(2)
  if (first.state === "mounted" && second.state === "mounted") {
    expect(first.owner).not.toBe(second.owner)
    await Promise.all(
      [first, second].map((frame) => f.manager.siteUnmount(f.root, "thread", frame.owner))
    )
  }
})

it("keeps a mutable or effectful callback on its original current owner path", async () => {
  const f = await fixture(
    `on("ui.render",{component:"AssistantMessage"},($,e)=>
    ({type:"Text",props:{},children:[String(++counter)]}))`,
    "let counter=0"
  )
  const first = await f.read()
  expect(first.state).toBe("mounted")
  const second = await f.read()
  expect(second.state).toBe("mounted")
  expect(f.events.filter((event) => event === "ui.render")).toHaveLength(2)
  if (first.state === "mounted") await f.manager.siteUnmount(f.root, "thread", first.owner)
  if (second.state === "mounted") await f.manager.siteUnmount(f.root, "thread", second.owner)
})

it("does not return a proved snapshot after source bytes are replaced", async () => {
  const f = await fixture(`on("ui.render",{component:"AssistantMessage"},($,e)=>
    ({type:"Text",props:{},children:[e.props.text]}))`)
  expect((await f.read()).state).toBe("projected")
  await writeFile(f.file, "export function register(){}")
  await expect(f.read()).rejects.toThrow()
})

it("checks source again after real rendering even when dependency capture cannot hand off", async () => {
  const f = await fixture(`on("ui.render",{component:"AssistantMessage"},($,e)=>
    ({type:"Text",props:{},children:[e.props.text]}))`)
  const dependencies = vi
    .spyOn(FunctionSession.prototype, "captureDisplayDependencies")
    .mockReturnValue(undefined)
  const render = f.manager.siteRender.bind(f.manager)
  const unmount = vi.spyOn(f.manager, "siteUnmount")
  let renderedOwner: string | undefined
  try {
    const current = await f.read("current", "current-row")
    expect(current.state).toBe("mounted")
    expect(dependencies).toHaveBeenCalledTimes(1)
    if (current.state !== "mounted") throw new Error("Expected a real current drawing")
    await f.manager.siteUnmount(f.root, "thread", current.owner)
    dependencies.mockClear()
    unmount.mockClear()
    const rendering = vi.spyOn(f.manager, "siteRender").mockImplementation(async (...args) => {
      const snapshot = await render(...args)
      renderedOwner = args[2]
      // The real renderer has completed its own full guard. Mutate before the
      // awaiting siteRead continuation, without forging a snapshot or owner.
      if (snapshot) queueMicrotask(() => writeFileSync(f.file, "export function register(){}"))
      return snapshot
    })
    try {
      await expect(f.read("changed", "changed-row")).rejects.toThrow()
      expect(rendering).toHaveBeenCalledTimes(1)
      expect(renderedOwner).toBeTypeOf("string")
      expect(unmount).toHaveBeenCalledWith(f.root, "thread", renderedOwner)
      // The final check rejects before attempting a dependency handoff, and
      // the existing error cleanup must retire this actual drawing route.
      expect(dependencies).not.toHaveBeenCalled()
      if (!renderedOwner) throw new Error("Expected the real renderer's drawing owner")
      await expect(
        render(f.root, "thread", renderedOwner, { text: "changed" })
      ).rejects.toMatchObject({ code: "MODS_UI_SITE_CLOSED" })
    } finally {
      rendering.mockRestore()
    }
  } finally {
    dependencies.mockRestore()
    unmount.mockRestore()
  }
})

it("rolls back to real legacy leases and never reuses the retired projection epoch", async () => {
  const f = await fixture(`on("ui.render",{component:"AssistantMessage"},($,e)=>
    ({type:"Text",props:{},children:[e.props.text]}))`)
  const first = await f.read()
  f.manager.setDisplayProjectionEnabled(false)
  const legacy = await f.read()
  expect(legacy.state).toBe("mounted")
  if (legacy.state === "mounted") await f.manager.siteUnmount(f.root, "thread", legacy.owner)
  f.manager.setDisplayProjectionEnabled(true)
  const restored = await f.read()
  expect(restored.state).toBe("projected")
  if (first.state === "projected" && restored.state === "projected")
    expect(restored.snapshot.scopeId).not.toBe(first.snapshot.scopeId)
})

it("keeps unknown protocol peers on the legacy drawing contract", async () => {
  const f = await fixture(`on("ui.render",{component:"AssistantMessage"},($,e)=>
    ({type:"Text",props:{},children:[e.props.text]}))`)
  const read = await f.manager.siteRead(
    f.root,
    "thread",
    "AssistantMessage",
    { text: "PRIVATE", isFirstOfReply: true },
    "message:block",
    undefined,
    undefined,
    "future/v9"
  )
  expect(read.state).toBe("mounted")
  if (read.state === "mounted") await f.manager.siteUnmount(f.root, "thread", read.owner)
})

it("resumes a real owner after passive eviction and releases its cached dependency reader", async () => {
  const f = await fixture(`
    on("ui.render",{component:"AssistantMessage"},async($,e)=>{
      const state=await $.state.get({plugin:"display",key:"label"});
      return {type:"Text",props:{},children:[state.value ? state.value.label : "INITIAL"]}
    });
    on("skill.prompt",async($,e,next)=>{
      await $.state.set({plugin:"display",key:"label"},{label:"UPDATED"});return next(e)
    })`)
  expect((await f.read()).state).toBe("projected")
  const owned = await f.manager.siteRead(
    f.root,
    "thread",
    "AssistantMessage",
    { text: "PRIVATE", isFirstOfReply: true },
    "message:block",
    undefined,
    undefined,
    FUNCTION_DISPLAY_PROTOCOL,
    true
  )
  expect(owned.state).toBe("mounted")
  if (owned.state !== "mounted") throw Error("NO_OWNER")
  expect(f.manager["displayProjection"].stats().entries).toBe(0)
  f.changed.mockClear()
  await f.manager.presentationEvent(
    f.root,
    "thread",
    "skill.prompt",
    { skill: "update", text: "prompt" },
    new AbortController().signal
  )
  expect(f.changed.mock.calls.some((call) => call[1] === `site-invalidated:${owned.owner}`)).toBe(
    true
  )
  expect(f.changed.mock.calls.some((call) => call[1]?.startsWith("site-projection:"))).toBe(false)
  expect(
    JSON.stringify(
      await f.manager.siteRender(f.root, "thread", owned.owner, {
        text: "PRIVATE",
        isFirstOfReply: true
      })
    )
  ).toContain("UPDATED")
  await f.manager.siteUnmount(f.root, "thread", owned.owner)
})

it("keeps real named-state dependencies after unmount and invalidates only their cached rows", async () => {
  const f = await fixture(`
    on("ui.render",{component:"AssistantMessage"},async($,e)=>{
      const state=await $.state.get({plugin:"display",key:"label"});
      return {type:"Text",props:{},children:[state.value ? state.value.label : "INITIAL"]}
    });
    on("skill.prompt",async($,e,next)=>{
      await $.state.set({plugin:"display",key:"label"},{label:"UPDATED"});return next(e)
    });
    on("tool.describe",async($,e,next)=>{
      await $.state.set({plugin:"display",key:"unrelated"},{label:"OTHER"});return next(e)
    })`)
  expect((await f.read()).state).toBe("projected")
  expect((await f.read("PRIVATE", "second-row")).state).toBe("projected")
  const count = () => f.events.filter((event) => event === "ui.render").length
  expect(count()).toBe(2)
  f.changed.mockClear()
  await f.manager.presentationEvent(
    f.root,
    "thread",
    "tool.describe",
    {
      tool: "Read",
      description: "description",
      provider: { plugin: "engine", tier: "core" }
    },
    new AbortController().signal
  )
  expect(
    f.changed.mock.calls.filter((call) => call[1]?.startsWith("site-projection:"))
  ).toHaveLength(0)
  await f.read()
  expect(count()).toBe(2)
  await f.manager.presentationEvent(
    f.root,
    "thread",
    "skill.prompt",
    {
      skill: "update",
      text: "prompt"
    },
    new AbortController().signal
  )
  const invalidations = f.changed.mock.calls.filter((call) =>
    call[1]?.startsWith("site-projection:")
  )
  expect(invalidations).toHaveLength(2)
  expect(new Set(invalidations.map((call) => call[1])).size).toBe(2)
  expect(JSON.stringify(await f.read())).toContain("UPDATED")
  expect(count()).toBe(3)
  await f.read()
  expect(count()).toBe(3)
  expect(JSON.stringify(await f.read("PRIVATE", "second-row"))).toContain("UPDATED")
  expect(count()).toBe(4)
})

it("keeps intercepted state reads on real owners rather than assuming native state semantics", async () => {
  const f = await fixture(`
    on("state.get",($,e,next)=>next(e));
    on("ui.render",{component:"AssistantMessage"},async($,e)=>{
      const state=await $.state.get({plugin:"display",key:"label"});
      return {type:"Text",props:{},children:[state.value ? state.value.label : "INITIAL"]}
    })`)
  const first = await f.read()
  expect(first.state).toBe("mounted")
  if (first.state === "mounted") await f.manager.siteUnmount(f.root, "thread", first.owner)
  const second = await f.read()
  expect(second.state).toBe("mounted")
  if (second.state === "mounted") await f.manager.siteUnmount(f.root, "thread", second.owner)
  expect(f.events.filter((event) => event === "ui.render")).toHaveLength(2)
})

const messageCallbacks = `
  on("ui.render",{component:"UserMessage"},($,e)=>
    ({type:"Text",props:{},children:["USER GUEST ",e.props.text]}));
  on("ui.render",{component:"AssistantMessage"},($,e)=>
    ({type:"Text",props:{},children:["ASSISTANT GUEST ",e.props.text]}))`

it("retires a source-free native display scope across the real global off and on invalidations", async () => {
  let global = true
  const f = await fixture("", "", { noSources: true, globallyEnabled: () => global })
  const first = await f.read()
  expect(first.state).toBe("projected")
  const publications = f.publish.mock.calls.length
  expect(publications).toBeGreaterThan(0)
  expect(f.events).toEqual([])
  global = false
  f.manager.invalidateAll()
  global = true
  f.manager.invalidateAll()
  const next = await f.read()
  expect(next.state).toBe("projected")
  if (first.state !== "projected" || next.state !== "projected")
    throw Error("Expected source-free native projections")
  expect(next.snapshot.scopeId).not.toBe(first.snapshot.scopeId)
  expect(next.snapshot.version).not.toBe(first.snapshot.version)
  expect(next.snapshot.data).toEqual(first.snapshot.data)
  expect(f.publish).toHaveBeenCalledTimes(publications * 2)
  expect(f.events).toEqual([])
})

it("rejects a pending source-free native reply after global off and on before accepting a fresh protected read", async () => {
  let global = true
  let entered!: () => void, release!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture("", "", {
    noSources: true,
    globallyEnabled: () => global,
    async publish(value) {
      entered()
      await gate
      return JSON.parse(JSON.stringify(value).replaceAll("PRIVATE", "SAFE")) as ModJson
    }
  })
  const pending = f.read()
  const rejected = expect(pending).rejects.toThrow(/MODS_(?:DISPLAY_)?SCOPE_CHANGED/)
  await started
  global = false
  f.manager.invalidateAll()
  global = true
  f.manager.invalidateAll()
  release()
  await rejected
  const next = await f.read()
  expect(next.state).toBe("projected")
  expect(JSON.stringify(next)).toContain("SAFE")
  expect(JSON.stringify(next)).not.toContain("PRIVATE")
  expect(f.events).toEqual([])
})
const nativeOrigin: FunctionPluginPromptOrigin = {
  kind: "plugin",
  name: "native-author",
  asUser: true
}

function messageProps(component: "UserMessage" | "AssistantMessage", text: string): ModObject {
  return component === "UserMessage"
    ? { text, origin: { kind: "unclassified" }, isExpanded: true }
    : { text, isFirstOfReply: true }
}

it.each([
  ["UserMessage", 30 * 1024],
  ["AssistantMessage", 30 * 1024],
  ["UserMessage", 64 * 1024],
  ["AssistantMessage", 64 * 1024]
] as const)(
  "protects the complete %s body at %i characters on both real publication boundaries",
  async (component, length) => {
    const firstSecret = "sk-abcdefghijklmnopqrstu"
    const secondSecret = "sk-vwxyzabcdefghijklmnop"
    const framing = `# Whole Markdown\n\n[distant reference][end]\n\n${firstSecret} \n\n[end]: https://example.test/whole\n`
    const text = framing.replace("\n\n[end]:", `${"x".repeat(length - framing.length)}\n\n[end]:`)
    expect(text).toHaveLength(length)
    const f = await fixture(messageCallbacks, "", {
      origin: nativeOrigin,
      publish(value, call) {
        const protectedValue = filterModData(value, true) as ModObject
        return call === 1
          ? { ...protectedValue, text: `${protectedValue.text}\n${secondSecret}` }
          : protectedValue
      }
    })
    const result = await f.manager.siteRead(
      f.root,
      "thread",
      component,
      messageProps(component, text),
      "whole-message",
      component === "UserMessage" ? "native-message" : undefined,
      undefined,
      FUNCTION_DISPLAY_PROTOCOL
    )
    expect(result.state).toBe("projected")
    expect(f.events.filter((event) => event === "ui.render")).toHaveLength(0)
    expect(f.publish).toHaveBeenCalledTimes(2)
    const first = f.publish.mock.calls[0][1] as ModObject
    const second = f.publish.mock.calls[1][1] as ModObject
    expect(first.text).toBe(text)
    expect(second.text).toBe(`${text.replace(firstSecret, "[REDACTED]")}\n${secondSecret}`)
    if (result.state !== "projected") throw Error("Expected a passive host message")
    expect(result.snapshot.data).toEqual({
      component,
      hostMessage: {
        ...messageProps(component, `${text.replace(firstSecret, "[REDACTED]")}\n[REDACTED]`),
        ...(component === "UserMessage" ? { origin: nativeOrigin } : {})
      }
    })
    expect(result).not.toHaveProperty("owner")
    expect(result.snapshot.data).not.toHaveProperty("tree")
    expect(result.snapshot.data.hostMessage?.text).toContain("[end]: https://example.test/whole")

    // Crossing back below the host boundary must still run the actual approved guest.
    const short = await f.manager.siteRead(
      f.root,
      "thread",
      component,
      messageProps(component, "short PRIVATE"),
      "short-message",
      component === "UserMessage" ? "native-message" : undefined,
      undefined,
      FUNCTION_DISPLAY_PROTOCOL
    )
    expect(short.state).toBe("projected")
    expect(f.events.filter((event) => event === "ui.render")).toHaveLength(1)
    expect(JSON.stringify(short)).toContain(
      component === "UserMessage" ? "USER GUEST" : "ASSISTANT GUEST"
    )
  }
)

it.each(["UserMessage", "AssistantMessage"] as const)(
  "protects blank %s without initializing a message guest",
  async (component) => {
    const f = await fixture(messageCallbacks, "", {
      origin: nativeOrigin,
      publish: (value) => filterModData(value, true)
    })
    const result = await f.manager.siteRead(
      f.root,
      "thread",
      component,
      messageProps(component, " \n\t "),
      "blank-message",
      component === "UserMessage" ? "native-message" : undefined,
      undefined,
      FUNCTION_DISPLAY_PROTOCOL
    )
    expect(result.state).toBe("projected")
    expect(f.publish).toHaveBeenCalledTimes(2)
    expect(f.events.filter((event) => event === "ui.render")).toHaveLength(0)
    if (result.state === "projected") expect(result.snapshot.data.hostMessage?.text).toBe(" \n\t ")
  }
)

it.each([
  ["UserMessage", "origin", { kind: "plugin", name: "forged-author" }],
  ["UserMessage", "isExpanded", false],
  ["AssistantMessage", "isFirstOfReply", false]
] as const)(
  "rejects publication changes to %s %s on either boundary",
  async (component, field, value) => {
    for (const boundary of [1, 2]) {
      const f = await fixture(messageCallbacks, "", {
        origin: nativeOrigin,
        publish(input, call) {
          return call === boundary ? { ...(input as ModObject), [field]: value } : input
        }
      })
      await expect(
        f.manager.siteRead(
          f.root,
          "thread",
          component,
          messageProps(component, "x".repeat(10001)),
          `identity-${boundary}`,
          component === "UserMessage" ? "native-message" : undefined,
          undefined,
          FUNCTION_DISPLAY_PROTOCOL
        )
      ).rejects.toThrow("MODS_UI_NATIVE_PUBLICATION")
      expect(f.publish).toHaveBeenCalledTimes(boundary)
      expect(f.events.filter((event) => event === "ui.render")).toHaveLength(0)
    }
  }
)

it.each([
  ["x".repeat(524289), "MODS_OUTPUT_LIMIT"],
  ["数".repeat(350000), "MODS_JSON_SIZE"],
  ["\u0000".repeat(180000), "MODS_JSON_SIZE"]
])(
  "fails closed for host messages beyond existing output or encoded JSON quotas (%#)",
  async (text, code) => {
    const f = await fixture(messageCallbacks, "", {
      publish: (value) => filterModData(value, true)
    })
    await expect(f.read(text)).rejects.toThrow(code)
    expect(f.events.filter((event) => event === "ui.render")).toHaveLength(0)
    if (code === "MODS_JSON_SIZE") expect(f.publish).not.toHaveBeenCalled()
    else expect(f.publish).toHaveBeenCalledTimes(1)
  }
)

it("keeps known-protocol long messages protected but unretained when projection caching is disabled", async () => {
  const f = await fixture(messageCallbacks)
  f.manager.setDisplayProjectionEnabled(false)
  const text = `PRIVATE ${"x".repeat(30 * 1024)}`
  const read = () =>
    f.manager.siteRead(
      f.root,
      "thread",
      "AssistantMessage",
      messageProps("AssistantMessage", text),
      "uncached-long-message",
      undefined,
      undefined,
      FUNCTION_DISPLAY_PROTOCOL
    )
  const first = await read()
  expect(first.state).toBe("projected")
  expect(JSON.stringify(first)).not.toContain("PRIVATE")
  expect(JSON.stringify(first)).toContain("SAFE")
  expect(f.publish).toHaveBeenCalledTimes(2)
  const second = await read()
  expect(second.state).toBe("projected")
  expect(f.publish).toHaveBeenCalledTimes(4)
  expect(f.events.filter((event) => event === "ui.render")).toHaveLength(0)
  if (first.state === "projected" && second.state === "projected") {
    expect(second.snapshot.data).toEqual(first.snapshot.data)
    expect(second.snapshot).not.toBe(first.snapshot)
  }
})

it("rejects an oversized policy result at either boundary instead of returning the original body", async () => {
  for (const boundary of [1, 2]) {
    const f = await fixture(messageCallbacks, "", {
      publish(input, call) {
        return call === boundary ? { ...(input as ModObject), text: "数".repeat(350000) } : input
      }
    })
    await expect(f.read(`PRIVATE ${"x".repeat(10001)}`)).rejects.toThrow("MODS_JSON_SIZE")
    expect(f.publish).toHaveBeenCalledTimes(boundary)
    expect(f.events.filter((event) => event === "ui.render")).toHaveLength(0)
  }
})

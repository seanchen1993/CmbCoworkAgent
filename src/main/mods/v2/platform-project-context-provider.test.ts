import { mkdir, mkdtemp, rm, writeFile, readFile, link, symlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { FunctionModsManager } from "./manager"
import { FunctionGuestRuntime } from "./guest-runtime"
import { ModControlStore } from "../control-store"
import { ModCommandQueue } from "../command-queue"
import { runPlatformUserAction } from "./platform-user-action"
import { createNativeProjectContextPlatformProvider } from "./platform-project-context-provider"
import { withNativeProjectContext, assertNativeProjectContextProof } from "./project-context-scope"
import type { NativeProjectContextScope } from "./project-context-scope"
import type { ModObject } from "../../../shared/mods/types"
import { withNativeProjectReadOnlyChecks } from "./project-readonly-check-scope"
import { encodeMarketContent, MARKET_CONTENT_PREFIX, protectMarketDirectory } from "../../services/market-content"
import { runtimeDigest } from "../../harness-board/project-runtime/safe-files"
import { issueRuntimePluginSourceToken, withRuntimePluginSource } from "../../plugins/runtime-source-scope"

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(extraPermission = false, checkOnly = false, compactText = false, configured = false) {
  const root = await mkdtemp(join(tmpdir(), "project-materials-")),
    plugin = join(root, "selector"),
    knowledge = join(root, "knowledge")
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(plugin, "hooks"), { recursive: true })
  await mkdir(knowledge)
  await writeFile(join(knowledge, "guide.md"), "Approved material")
  await writeFile(join(knowledge, ".env"), "SECRET")
  await writeFile(
    join(plugin, "plugin.json"),
    JSON.stringify({
      name: "selector",
      version: "1.0.0",
      ...(configured ? { userConfig: {
        label: { type: "string", title: "Label", description: "Context label", default: "original" }
      } } : {}),
      claw: {
        actions: [
          {
            id: "context",
            name: "Select context",
            platform: { id: "selector", version: "1.0.0", action: "select" },
            inputSchema: { type: "object" },
            outputSchema: { type: "object" }
          }
        ]
      }
    })
  )
  await writeFile(join(plugin, "hooks/hooks.json"), '{"modules":["./select.ts"]}')
  await writeFile(
    join(plugin, "hooks/select.ts"),
    `export function register(on) {
    on.capability({apiVersion:"devclaw.capability/v1",id:"selector",version:"1.0.0",title:"Selector",scope:"conversation",
      stateSchema:{type:"object"},actions:[{id:"select",title:"Select",inputSchema:{type:"object"},outputSchema:{type:"object"},
        requiredPermissions:[${checkOnly ? '"platform.act"' : '"platform.read","platform.act"'}${extraPermission ? ',"process.run"' : ""}],cancellable:true,idempotency:"keyed"}]}, {
      act: async ($,event) => {
        if(event.input.input.mode === "pure") return {status:"succeeded",text:"Checked original input",output:{checked:event.input.input.value}};
        const ref={provider:"native.project-context",id:"materials",version:"1.0.0"},target={kind:"current"};
        if(event.input.input.mode === "escape") return await $.platform.act({ref:{provider:"selector",id:"selector",version:"1.0.0"},
          target,action:"select",input:{input:{}},requestKey:"nested"});
        if(event.input.input.mode === "status") return await $.platform.status({ref,target,requestKey:"read-original"});
        const state=await $.platform.read({ref,target});
        const list=await $.platform.act({ref,target,action:"list",input:{rootId:"knowledge"},requestKey:event.input.executionId+":list"});
        const file=await $.platform.act({ref,target,action:"read",input:{rootId:"knowledge",path:event.input.input.path||"guide.md"},requestKey:${compactText ? 'event.input.executionId+":read"' : '"read-original"'}});
        return {status:"succeeded",text:${compactText ? '"Context read completed"' : 'JSON.stringify({state:state.value,list:list.value,file})'},output:{state:state.value,list:list.value,file}};
      }
    })
  }`
  )
  const store = new ModControlStore(join(root, "state.sqlite")),
    queue = new ModCommandQueue(store, () => {})
  cleanup.push(() => store.close())
  cleanup.push(() => queue.close())
  const sources = [{ id: "selector-install", name: "selector", path: plugin, enabled: true }]
  let incarnation = "material-incarnation"
  let threadOwner = true
  const guests: FunctionGuestRuntime[] = []
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => sources,
      enabled: () => true,
      clawApplicable: () => true,
      changed: () => {},
      threadIncarnationKey: () => incarnation,
      captureSiteGuard: () => () => {
        if (!threadOwner) throw Error("THREAD_OWNER_REVOKED")
      },
      platformNativeProviders: () => [createNativeProjectContextPlatformProvider()],
      publish: async (_workspace, value) => value
    },
    () => ({
      async load(code, options) {
        const guest = await FunctionGuestRuntime.create(code, options)
        guests.push(guest)
        return guest
      },
      stop() {
        guests.forEach((guest) => guest.dispose())
      },
      async stopAndDrain() {
        guests.forEach((guest) => guest.dispose())
      }
    })
  )
  cleanup.push(() => manager.close())
  const [status] = await manager.status(root)
  await manager.approve(root, status.pluginId, status.digest!)
  const descriptor = (await manager.actionCatalog(root, "thread"))[0]
  const provider = {
    pluginId: descriptor.pluginId,
    plugin: descriptor.plugin,
    digest: descriptor.digest,
    actionId: descriptor.actionId
  }
  const controller = new AbortController()
  const scope: NativeProjectContextScope = {
    workspace: root,
    threadId: "thread",
    operationId: "operation",
    stageId: "plan",
    inputIdentity: "input-1",
    provider,
    roots: [{ id: "knowledge", path: knowledge }],
    configuration: { deploymentUnits: "[]" },
    assertCurrent: () => controller.signal.throwIfAborted()
  }
  let sequence = 0
  const execute = async (input: ModObject = {}, key = "execution-" + ++sequence) =>
    runPlatformUserAction(
      queue,
      { functionUserScope: () => ({}) },
      root,
      "thread",
      controller.signal,
      scope.assertCurrent,
      async (signal) => {
        const prepared = await manager.prepareAction(root, "thread", provider, signal)
        return manager.runAction(
          root,
          "thread",
          prepared,
          {
            version: 1,
            runId: "run",
            stepId: "context",
            executionId: key,
            task: "Select bounded context",
            input,
            config: {}
          },
          signal
        )
      }
    )
  return { root, knowledge, scope, manager, sources, provider, controller, execute, store,
    setIncarnation: (value: string) => { incarnation = value },
    revokeThreadOwner: () => { threadOwner = false } }
}

async function admitEmptyHost(f: Awaited<ReturnType<typeof fixture>>) {
  const path = join(f.root, "host-package")
  await mkdir(path)
  await writeFile(join(path, "plugin.json"), JSON.stringify({ name: "host-package", version: "1.0.0" }))
  const token = issueRuntimePluginSourceToken({
    mode: "host", capabilitySources: [], preserveParentContext: true,
    threadId: "thread", incarnationKey: "material-incarnation",
    projectId: "project", operationId: "operation", stageId: "plan",
    packageDigest: "a".repeat(64), workspace: f.root,
    plugin: { id: "host-install", name: "host-package", path, version: "1.0.0",
      enabled: true, description: "", author: "", skillCount: 1, mcpServerCount: 0,
      hookCount: 0, createdAt: "2026-10-26", updatedAt: "2026-10-26" }
  }, () => {}, () => {})
  await withRuntimePluginSource(token, async () => {
    expect(await f.manager.runtimeReady(f.root, "thread", f.controller.signal)).toBe(false)
  })
}

it("retains only completed context source evidence across the real cold-resume Host VM handoff", async () => {
  const f = await fixture()
  const contextGuard = await f.manager.verifyReadOnlyContextProvider(
    f.root, "thread", f.provider, f.controller.signal)
  const executionGuard = await f.manager.verifyReadOnlyCheckProvider(
    f.root, "thread", f.provider, f.controller.signal)
  // The ordinary selector VM exists before the resumed graph's runtimeReady.
  await admitEmptyHost(f)
  expect(() => contextGuard()).not.toThrow()
  // A historical context proof cannot authorize a new action on the retired VM.
  expect(() => executionGuard()).toThrow("MODS_SCOPE_CHANGED")
  f.sources[0].enabled = false
  expect(() => contextGuard()).toThrow(expect.objectContaining({ code: "MODS_PLUGIN_CHANGED" }))
})

it.each(["source", "grant", "incarnation", "abort", "workspace", "thread-owner"] as const)(
  "rejects %s changes after a legal context evidence handoff",
  async (change) => {
    const f = await fixture()
    const guard = await f.manager.verifyReadOnlyContextProvider(
      f.root, "thread", f.provider, f.controller.signal)
    await admitEmptyHost(f)
    if (change === "source")
      await writeFile(join(f.sources[0].path, "hooks/select.ts"), "export function register() {}")
    if (change === "grant") {
      f.store.grant(f.root, "function:selector", f.provider.digest, false)
      f.store.grant(f.root, "function:selector", f.provider.digest, true)
    }
    if (change === "incarnation") f.setIncarnation("replacement-thread")
    if (change === "abort") f.controller.abort()
    if (change === "workspace") f.manager.pluginsChanged(f.root)
    if (change === "thread-owner") f.revokeThreadOwner()
    expect(() => guard()).toThrow()
  }
)

it("rejects configuration revision changes without requiring the retired context VM", async () => {
  const f = await fixture(false, false, false, true)
  const guard = await f.manager.verifyReadOnlyContextProvider(
    f.root, "thread", f.provider, f.controller.signal)
  await admitEmptyHost(f)
  expect(() => guard()).not.toThrow()
  await f.manager.saveUserConfig(f.root, "configuration-thread", f.provider.pluginId,
    f.provider.digest, "label", "changed", 0, f.controller.signal, () => {})
  expect(() => guard()).toThrow("MODS_CONFIG_VALUE_CHANGED")
})

it("decodes only package materials through the real provider while preserving raw digest and plaintext limits", async () => {
  const f = await fixture(false, false, true)
  const file = join(f.knowledge, "guide.md")
  const plain = "x".repeat(8000)
  await writeFile(file, plain)
  protectMarketDirectory(f.knowledge)
  f.scope.roots = [{ id: "knowledge", path: f.knowledge, source: "package" }]
  const result = await withNativeProjectContext(f.scope, () => f.execute())
  expect(result.value.output).toMatchObject({ file: { status: "succeeded", value: {
    text: plain, bytes: 8000, digest: runtimeDigest(await readFile(file))
  } } })
  await writeFile(file, encodeMarketContent(Buffer.from("x".repeat(8001))))
  const oversized = await withNativeProjectContext({ ...f.scope, inputIdentity: "oversized" }, () => f.execute())
  expect((oversized.value.output?.file as ModObject).status).not.toBe("succeeded")
  await writeFile(file, MARKET_CONTENT_PREFIX + "invalid!")
  const corrupt = await withNativeProjectContext({ ...f.scope, inputIdentity: "corrupt" }, () => f.execute())
  expect((corrupt.value.output?.file as ModObject).status).not.toBe("succeeded")
  const external = encodeMarketContent(Buffer.from("External literal text"))
  await writeFile(file, external)
  const knowledge = await withNativeProjectContext({ ...f.scope, inputIdentity: "external",
    roots: [{ id: "knowledge", path: f.knowledge, source: "knowledge" }] }, () => f.execute())
  expect(knowledge.value.output).toMatchObject({ file: { status: "succeeded", value: {
    text: external.toString("utf8"), digest: runtimeDigest(external)
  } } })
})

it("cold-verifies action-only checks with the same compiled permission boundary as execution", async () => {
  const f = await fixture(false, true)
  const guard = await f.manager.verifyReadOnlyCheckProvider(
    f.root,
    "thread",
    f.provider,
    f.controller.signal
  )
  expect(() => guard()).not.toThrow()
  await expect(
    f.manager.verifyReadOnlyContextProvider(f.root, "thread", f.provider, f.controller.signal)
  ).rejects.toThrow("NOT_READONLY")
  const result = await withNativeProjectReadOnlyChecks(
    {
      workspace: f.root,
      threadId: "thread",
      operationId: "pure-check",
      inputIdentity: "original",
      providers: [f.provider],
      assertCurrent: () => undefined
    },
    () => f.execute({ mode: "pure", value: "artifact bytes" })
  )
  expect(result.output).toEqual({ checked: "artifact bytes" })
  f.sources[0].enabled = false
  expect(() => guard()).toThrow()
  const broad = await fixture(true, true)
  await expect(
    broad.manager.verifyReadOnlyCheckProvider(
      broad.root,
      "thread",
      broad.provider,
      broad.controller.signal
    )
  ).rejects.toThrow("NOT_READONLY")
})

it("runs pure original checks through the real guest but forbids nested dispatch, material reads and broad permissions", async () => {
  const f = await fixture()
  const scope = {
    workspace: f.root,
    threadId: "thread",
    operationId: "check-op",
    inputIdentity: "check-input",
    providers: [f.provider],
    assertCurrent: () => undefined
  }
  const result = await withNativeProjectReadOnlyChecks(scope, async () => {
    const value = await f.execute({ mode: "pure", value: "original artifact" }, "check-original")
    f.controller.abort()
    return value
  })
  expect(result.output).toEqual({ checked: "original artifact" })
  for (const input of [{ mode: "escape" }, {}] as ModObject[]) {
    const current = await fixture()
    await expect(
      withNativeProjectReadOnlyChecks(
        { ...scope, workspace: current.root, providers: [current.provider] },
        () => current.execute(input)
      )
    ).rejects.toThrow()
  }
  const broad = await fixture(true)
  await expect(
    withNativeProjectReadOnlyChecks(
      { ...scope, workspace: broad.root, providers: [broad.provider] },
      () => broad.execute({ mode: "pure" })
    )
  ).rejects.toThrow("PROVIDER_DENIED")
})

it("cannot adopt a check receipt in another operation or after provider revocation", async () => {
  const f = await fixture()
  const scope = {
    workspace: f.root,
    threadId: "thread",
    operationId: "check-op",
    inputIdentity: "check-input",
    providers: [f.provider],
    assertCurrent: () => undefined
  }
  await withNativeProjectReadOnlyChecks(scope, () => f.execute({ mode: "pure" }, "checked"))
  await expect(f.execute({ mode: "pure" }, "checked")).rejects.toThrow()
  await expect(
    withNativeProjectReadOnlyChecks({ ...scope, operationId: "other" }, () =>
      f.execute({ mode: "pure" }, "checked")
    )
  ).rejects.toThrow()
  await expect(
    withNativeProjectReadOnlyChecks(scope, async () => {
      const value = await f.execute({ mode: "pure" }, "checked")
      f.sources[0].enabled = false
      return value
    })
  ).rejects.toThrow()
})

it("reads only bound material through the real guest and queue and mints an unforgeable read-only proof", async () => {
  const f = await fixture()
  const guard = await f.manager.verifyReadOnlyContextProvider(
    f.root,
    "thread",
    f.provider,
    f.controller.signal
  )
  guard()
  const result = await withNativeProjectContext(f.scope, () => f.execute())
  assertNativeProjectContextProof(result.proof)
  expect(result.value.output).toMatchObject({
    state: { stageId: "plan", configuration: { deploymentUnits: "[]" } },
    list: { entries: [{ name: "guide.md", kind: "file" }] },
    file: { status: "succeeded", value: { text: "Approved material" } }
  })
  expect(JSON.stringify(result.value)).not.toContain(f.knowledge)
  expect(() => assertNativeProjectContextProof(JSON.parse(JSON.stringify(result.proof)))).toThrow(
    "UNTRUSTED"
  )
  f.sources[0].enabled = false
  expect(guard).toThrow()
})

it("rejects non-read-only compiled providers and prevents nested self capability dispatch", async () => {
  const broad = await fixture(true)
  await expect(
    broad.manager.verifyReadOnlyContextProvider(
      broad.root,
      "thread",
      broad.provider,
      broad.controller.signal
    )
  ).rejects.toThrow("NOT_READONLY")
  await expect(withNativeProjectContext(broad.scope, () => broad.execute())).rejects.toThrow(
    "NOT_READONLY"
  )
  const f = await fixture()
  await expect(
    withNativeProjectContext(f.scope, () => f.execute({ mode: "escape" }))
  ).rejects.toThrow()
})

it("mints after normal child retirement but still rejects a changed provider or Host owner", async () => {
  const f = await fixture()
  const completed = await withNativeProjectContext(
    { ...f.scope, assertCurrent: () => undefined },
    async () => {
      const value = await f.execute()
      f.controller.abort() // Original Flow retires children before the wrapper returns.
      return value
    }
  )
  assertNativeProjectContextProof(completed.proof)
  const revoked = await fixture()
  await expect(
    withNativeProjectContext({ ...revoked.scope, assertCurrent: () => undefined }, async () => {
      const value = await revoked.execute()
      revoked.controller.abort()
      revoked.sources[0].enabled = false
      return value
    })
  ).rejects.toThrow()
  const owner = await fixture()
  await expect(
    withNativeProjectContext(owner.scope, async () => {
      const value = await owner.execute()
      owner.controller.abort()
      return value
    })
  ).rejects.toThrow()
})

it("cannot reopen cached native materials after the scope ends or under another operation", async () => {
  const f = await fixture()
  await withNativeProjectContext(f.scope, () => f.execute({}, "original"))
  await expect(f.execute({}, "original")).rejects.toThrow()
  await expect(f.execute()).rejects.toThrow()
  await expect(
    withNativeProjectContext({ ...f.scope, operationId: "different" }, () => f.execute())
  ).rejects.toThrow()
  await expect(
    withNativeProjectContext({ ...f.scope, inputIdentity: "different" }, () => f.execute())
  ).rejects.toThrow()
})

it("blocks traversal, credential paths, oversized text and hardlinks in the actual native guest route", async () => {
  for (const path of ["../outside", ".env", "large.md", "linked.md"]) {
    const f = await fixture()
    await writeFile(join(f.knowledge, "large.md"), "x".repeat(8001))
    await link(join(f.knowledge, "guide.md"), join(f.knowledge, "linked.md"))
    const result = await withNativeProjectContext(f.scope, () => f.execute({ path }))
    expect((result.value.output?.file as ModObject).status).not.toBe("succeeded")
  }
})

it("rejects a bound root redirected through a directory junction", async () => {
  const f = await fixture(),
    alias = join(f.root, "alias")
  await symlink(f.knowledge, alias, "junction")
  const result = await withNativeProjectContext(
    { ...f.scope, roots: [{ id: "knowledge", path: alias }] },
    () => f.execute()
  )
  expect((result.value.output?.file as ModObject).status).not.toBe("succeeded")
})

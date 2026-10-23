import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionModsManager } from "./manager"
import { compileFunctionPlugin } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { modCompiler } from "../loader"

const closes: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
})
async function fixture(body: string) {
  const workspace = await mkdtemp(join(tmpdir(), "platform-manager-")),
    root = join(workspace, "plugin")
  await mkdir(join(root, "hooks"), { recursive: true })
  await writeFile(join(root, "plugin.json"), '{"name":"platform-demo","version":"1.0.0"}')
  await writeFile(join(root, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
  await writeFile(join(root, "hooks/register.ts"), `export function register(on){${body}}`)
  const compiled = await compileFunctionPlugin(root, { captureSources: true })
  const store = new ModControlStore(join(workspace, "control.sqlite"))
  const guests: FunctionGuestRuntime[] = []
  let loads = 0,
    enabled = true
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => [{ id: "p", name: "platform-demo", path: root, enabled }],
      enabled: () => true,
      clawApplicable: () => true,
      changed() {
        /* Native counters are asserted directly. */
      },
      publish: async (_workspace, value) => value,
      threadIncarnationKey: () => "native-incarnation"
    },
    () => {
      const owned: FunctionGuestRuntime[] = []
      return {
        async load(code, options) {
          loads++
          const guest = await FunctionGuestRuntime.create(code, options)
          owned.push(guest)
          guests.push(guest)
          return guest
        },
        stop() {
          for (const guest of owned) guest.dispose()
        },
        async stopAndDrain() {
          for (const guest of owned) guest.dispose()
        }
      }
    }
  )
  closes.push(async () => {
    manager.close()
    for (const guest of guests) guest.dispose()
    await new Promise((resolve) => setTimeout(resolve, 20))
    store.close()
    await rm(workspace, { recursive: true, force: true })
  })
  const digest = (hostRevision: string) =>
    createHash("sha256")
      .update(
        JSON.stringify({
          name: compiled.name,
          profile: compiled.profile,
          ...(compiled.modelProtocol === "result-v1"
            ? { modelProtocol: compiled.modelProtocol }
            : {}),
          hostRevision,
          version: modCompiler().version,
          code: compiled.code,
          clients: compiled.clients,
          environment: compiled.environment,
          sources: Object.entries(compiled.authoringSources!).sort(([a], [b]) => a.localeCompare(b))
        })
      )
      .digest("hex")
  return {
    manager,
    compiled,
    store,
    workspace,
    loads: () => loads,
    disable: () => {
      enabled = false
    },
    digest
  }
}

it("cold desktop discovery never loads/registers/starts a guest and reports unknown", async () => {
  const f = await fixture("throw Error('discovery entered register')")
  f.store.grant(f.workspace, "function:platform-demo", f.compiled.digest, true)
  expect(f.manager.platformCapabilities(f.workspace, "t")).toEqual({
    status: "unknown",
    capabilities: []
  })
  expect(f.manager.platformSurfaceList(f.workspace, "t").entries).toEqual([])
  expect(f.manager.platformBehaviorList(f.workspace, "t").bindings).toEqual([])
  expect(f.loads()).toBe(0)
  expect(f.manager.runtimeSessions().sessions).toEqual([])
})

it("does not extend a real v91 package grant with the v92 SDK and keeps old native fallback", async () => {
  const f = await fixture(`on("session.start",async($,e,next)=>{
    await $.command.register({name:"old",description:"old API"});return next(e)
  });on("command.run",{command:"old"},()=>({text:"legacy still works"}));`)
  expect(f.digest("claude-295-tools-v92")).toBe(f.compiled.digest)
  const oldDigest = f.digest("claude-295-tools-v91")
  expect(oldDigest).not.toBe(f.compiled.digest)
  f.store.grant(f.workspace, "function:platform-demo", oldDigest, true)
  expect(await f.manager.runtimeReady(f.workspace, "t")).toBe(false)
  expect(await f.manager.commands(f.workspace, "t")).toEqual([])
  expect(f.loads()).toBe(0)
  f.store.grant(f.workspace, "function:platform-demo", f.compiled.digest, true)
  f.manager.invalidate(f.workspace)
  const [command] = await f.manager.commands(f.workspace, "t")
  expect(command.name).toBe("old API")
  expect(
    await f.manager.runCommand(f.workspace, "t", command, "", new AbortController().signal)
  ).toMatchObject({ text: "legacy still works" })
  f.disable()
  f.manager.invalidate(f.workspace)
  expect(await f.manager.runtimeReady(f.workspace, "plain")).toBe(false)
  expect(await f.manager.commands(f.workspace, "plain")).toEqual([])
})

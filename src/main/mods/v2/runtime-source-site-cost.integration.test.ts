import * as fs from "node:fs"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it, vi } from "vitest"
import type { ModJson } from "../../../shared/mods/types"
import { ModControlStore } from "../control-store"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionModsManager } from "./manager"
import {
  issueRuntimePluginSourceToken,
  withRuntimePluginSource
} from "../../plugins/runtime-source-scope"

vi.mock("node:fs", async (original) => ({ ...(await original<typeof import("node:fs")>()) }))

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
const props = { isWorking: true, bodyColumns: 80, maxRows: 8 }

async function fixture(resourceCount = 0) {
  const root = mkdtempSync(join(tmpdir(), "mods-source-sites-"))
  const workspace = join(root, "workspace"),
    path = join(root, "retained")
  mkdirSync(workspace)
  mkdirSync(join(path, "mods"), { recursive: true })
  writeFileSync(
    join(path, "plugin.json"),
    JSON.stringify({ name: "trial-label", version: "1.0.0", mods: "mods/manifest.json" })
  )
  writeFileSync(
    join(path, "mods/manifest.json"),
    JSON.stringify({
      apiVersion: "cmb.mods/v2",
      id: "trial-label",
      entry: "main.ts"
    })
  )
  const imports = Array.from({ length: resourceCount }, (_, index) => {
    writeFileSync(join(path, `mods/resource-${index}.ts`), `export const marker = ${index}`)
    return `import "./resource-${index}"`
  }).join("\n")
  const code = `${imports}
export function register(on) {
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"label",description:"Actual retained label"});return next(e)
    });
    on("ui.render",{component:"AbovePrompt"},($,e)=>{
      const {Text}=$.ui.resolve(e);return Text({children:"ACTUAL_RETAINED_LABEL"})
    })
  }`
  writeFileSync(join(path, "mods/main.ts"), code)
  const plugin = {
    id: "uninstalled-source-uuid",
    name: "trial-label",
    path,
    enabled: true,
    version: "1.0.0",
    description: "",
    author: "",
    skillCount: 1,
    mcpServerCount: 0,
    hookCount: 0,
    createdAt: "2026-10-18",
    updatedAt: "2026-10-18"
  }
  const store = new ModControlStore(join(root, "control.sqlite"))
  let active = true,
    incarnation = "original",
    enabled = true
  let publish = async (value: ModJson) => value
  const changed = vi.fn(),
    guests: FunctionGuestRuntime[] = []
  const manager = new FunctionModsManager(
    store,
    {
      plugins: () => [], // The candidate is never installed, including after native consent.
      enabled: () => enabled,
      protects: () => true,
      clawApplicable: () => false,
      captureSiteGuard: () => {
        const captured = incarnation
        return () => {
          if (captured !== incarnation) throw Error("THREAD_REPLACED")
        }
      },
      changed,
      publish: async (_workspace, value) => publish(value)
    },
    () => {
      const owned: FunctionGuestRuntime[] = []
      return {
        async load(code, options) {
          const guest = await FunctionGuestRuntime.create(code, options)
          guests.push(guest)
          owned.push(guest)
          return guest
        },
        stop() {
          for (const guest of owned) void guest.dispose()
        },
        async stopAndDrain() {
          await Promise.all(owned.map((guest) => guest.dispose()))
        }
      }
    }
  )
  cleanup.push(async () => {
    manager.close()
    await Promise.all(guests.map((guest) => guest.dispose()))
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const input = { workspace, plugin, scope: { projectId: "trial", packageDigest: "a".repeat(64) } }
  const facts = await manager.prepareRuntimeSourceFacts(input)
  await manager.approveRuntimeSource({ ...input, digest: facts!.digest }, () => {})
  const mint = (operationId: string) => {
    const captured = incarnation
    const assertAuthority = () => {
      if (!active || !enabled || captured !== incarnation) throw Error("SOURCE_REVOKED")
    }
    const assertCurrent = () => {
      assertAuthority()
      if (readFileSync(join(path, "mods/main.ts"), "utf8") !== code) throw Error("SOURCE_CHANGED")
    }
    return issueRuntimePluginSourceToken(
      {
        mode: "legacy",
        capabilitySources: [],
        preserveParentContext: true,
        threadId: "stage",
        incarnationKey: captured,
        projectId: "trial",
        operationId,
        stageId: "prd",
        workspace,
        packageDigest: "a".repeat(64),
        plugin
      },
      assertCurrent,
      assertAuthority
    )
  }
  const token = mint("original")
  const admit = async () =>
    withRuntimePluginSource(token, () => manager.commands(workspace, "stage"))
  const mount = () => manager.siteMountOutcome(workspace, "stage", "AbovePrompt")
  const render = (owner: string) => manager.siteRender(workspace, "stage", owner, props)
  return {
    root,
    workspace,
    path,
    manager,
    store,
    facts,
    token,
    mint,
    changed,
    guests,
    admit,
    mount,
    render,
    activeGuests: () => guests.filter((guest) => !guest.stats.disposed),
    revoke: () => {
      active = false
    },
    rebind: () => {
      incarnation = "replacement"
    },
    disable: () => {
      enabled = false
    },
    setPublish: (next: typeof publish) => {
      publish = next
    }
  }
}

// Diagnostic only: exercise the actual retained manager, guest and source fences.
// Counts describe costs, not a cache TTL or permission to bypass fresh validation.
it.each([0, 24])(
  "measures protected resident drawing with %i imported resources",
  async (resources) => {
    const f = await fixture(resources)
    await f.admit()
    const read = vi.spyOn(fs, "readSync")
    const readFile = vi.spyOn(fs, "readFileSync")
    const stat = vi.spyOn(fs, "lstatSync")
    const realpath = vi.spyOn(fs, "realpathSync")
    const matches = vi.spyOn(f.activeGuests()[0], "matches")
    const invoke = vi.spyOn(f.activeGuests()[0], "invoke")
    const trace: Array<Record<string, number | string>> = []
    const measure = async <T>(phase: string, run: () => Promise<T>): Promise<T> => {
      const before = [
        read.mock.calls.length,
        stat.mock.calls.length,
        realpath.mock.calls.length,
        matches.mock.calls.length,
        invoke.mock.calls.length,
        readFile.mock.calls.length
      ]
      const start = performance.now()
      const result = await run()
      trace.push({
        phase,
        ms: performance.now() - start,
        read: read.mock.calls.length - before[0],
        stat: stat.mock.calls.length - before[1],
        realpath: realpath.mock.calls.length - before[2],
        matches: matches.mock.calls.length - before[3],
        invokes: invoke.mock.calls.length - before[4],
        readFile: readFile.mock.calls.length - before[5]
      })
      return result
    }
    const matched = await measure("matched.mount", () => f.mount())
    if (matched.state !== "mounted") throw Error("actual mounted owner required")
    expect(
      JSON.stringify(await measure("matched.render", () => f.render(matched.owner)))
    ).toContain("ACTUAL_RETAINED_LABEL")
    await measure("matched.unmount", () =>
      f.manager.siteUnmount(f.workspace, "stage", matched.owner)
    )
    const missing = await measure("unmatched.mount", () =>
      f.manager.siteMountOutcome(f.workspace, "stage", "AssistantMessage")
    )
    if (missing.state !== "mounted") throw Error("actual protected native owner required")
    const message = { text: "NATIVE_ASSISTANT_MESSAGE", isFirstOfReply: true }
    const rendered = await measure("unmatched.render", () =>
      f.manager.siteRender(f.workspace, "stage", missing.owner, message)
    )
    expect(JSON.stringify(rendered)).toContain("NATIVE_ASSISTANT_MESSAGE")
    await measure("unmatched.unmount", () =>
      f.manager.siteUnmount(f.workspace, "stage", missing.owner)
    )
    expect(trace.find((item) => item.phase === "unmatched.render")!.invokes).toBe(0)
    // The existing security behavior remains live: a changed import cannot reuse a drawing owner.
    const original = readFileSync(join(f.path, "mods/main.ts"), "utf8")
    writeFileSync(join(f.path, "mods/main.ts"), original + "\n// changed source")
    await expect(f.mount()).rejects.toThrow("SOURCE_CHANGED")
    writeFileSync(join(f.path, "mods/main.ts"), original)
    const output = join(process.cwd(), "output", "runtime-source-site-cost")
    mkdirSync(output, { recursive: true })
    writeFileSync(
      join(output, `resources-${resources}.json`),
      JSON.stringify({ resources, trace }, null, 2)
    )
    console.log("SITE_SOURCE_COST", JSON.stringify({ resources, trace }))
  }
)

it("measures the actual protected host-only fallback without allocating a guest", async () => {
  const f = await fixture()
  const read = vi.spyOn(fs, "readSync")
  const stat = vi.spyOn(fs, "lstatSync")
  const readFile = vi.spyOn(fs, "readFileSync")
  const start = performance.now()
  const owner = await f.manager.siteMountOutcome(f.workspace, "stage", "AssistantMessage")
  if (owner.state !== "mounted") throw Error("actual protected owner required")
  const mounted = performance.now()
  const value = await f.manager.siteRender(f.workspace, "stage", owner.owner, {
    text: "NATIVE_PROTECTED_ONLY",
    isFirstOfReply: true
  })
  expect(JSON.stringify(value)).toContain("NATIVE_PROTECTED_ONLY")
  expect(f.activeGuests()).toHaveLength(0)
  const result = {
    mountMs: mounted - start,
    renderMs: performance.now() - mounted,
    read: read.mock.calls.length,
    stat: stat.mock.calls.length,
    readFile: readFile.mock.calls.length
  }
  const output = join(process.cwd(), "output", "runtime-source-site-cost")
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, "native-only.json"), JSON.stringify(result, null, 2))
  console.log("SITE_NATIVE_COST", JSON.stringify(result))
})

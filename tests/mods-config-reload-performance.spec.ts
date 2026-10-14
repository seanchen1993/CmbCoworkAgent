import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { performance } from "node:perf_hooks"
import { ModControlStore } from "../src/main/mods/control-store"
import { FunctionModsManager } from "../src/main/mods/v2/manager"
import { FunctionGuestRuntime } from "../src/main/mods/v2/guest-runtime"
import { compileFunctionPlugin } from "../src/main/mods/v2/loader"
import { FunctionUserConfigValues } from "../src/main/mods/v2/user-config-values"

async function main() {
  const root = await mkdtemp(join(tmpdir(), "mods-reload-performance-"))
  const path = join(root, "plugin"),
    threadId = randomUUID()
  let manager: FunctionModsManager | undefined
  let store: ModControlStore | undefined
  try {
    await mkdir(join(path, "hooks"), { recursive: true })
    await writeFile(
      join(path, "plugin.json"),
      JSON.stringify({
        name: "reload-performance",
        userConfig: {
          tone: { type: "string", title: "Tone", description: "Tone", default: "warm" }
        }
      })
    )
    await writeFile(join(path, "hooks/hooks.json"), '{"modules":["./register.ts"]}')
    await writeFile(
      join(path, "hooks/register.ts"),
      `export function register(on,options){
      on("session.start",async($,e,next)=>{await $.store.set("tone",options.tone);
        $.clock.every(60000,()=>{});
        await $.command.register({name:"probe",description:options.tone});return next(e)})
    }`
    )
    store = new ModControlStore(join(root, "control.sqlite"))
    const values = new FunctionUserConfigValues(store)
    const compiled = await compileFunctionPlugin(path)
    store.grant(root, "function:" + compiled.name, compiled.digest, true)
    let loads = 0
    manager = new FunctionModsManager(
      store,
      {
        plugins: () => [{ id: "p", name: compiled.name, path, enabled: true }],
        enabled: () => true,
        publish: async (_workspace, value) => value,
        changed: () => {}
      },
      () => {
        const guests: FunctionGuestRuntime[] = []
        return {
          load: async (...args) => {
            loads++
            const guest = await FunctionGuestRuntime.create(...args)
            guests.push(guest)
            return guest
          },
          stop: () => {
            for (const guest of guests) void guest.dispose()
          }
        }
      }
    )
    await manager.commands(root, threadId)
    const samples: number[] = []
    for (let index = 0; index < 12; index++) {
      const next = values.save(
        root,
        compiled.name,
        compiled.userConfig!,
        "tone",
        String(index),
        values.read(root, compiled.name).revision,
        () => {}
      )
      const start = performance.now()
      const view = await manager.reloadUserConfig(
        root,
        threadId,
        "p",
        compiled.digest,
        next.revision,
        new AbortController().signal,
        () => {}
      )
      samples.push(performance.now() - start)
      assert.equal(view.state, "applied")
      assert.equal((await manager.commands(root, threadId))[0].name, String(index))
    }
    assert.equal(
      loads,
      samples.length + 1,
      "Each explicit reload must create exactly one replacement"
    )
    samples.sort((a, b) => a - b)
    const report = {
      scope:
        "Real QuickJS, SQLite, source/grant fences and 60-second timer retirement; no model or desktop render",
      samples: samples.length,
      medianMs: samples[6],
      p95Ms: samples[11],
      maxMs: samples[11],
      loads
    }
    await writeFile("output/mods-config-reload-performance.json", JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
    assert(report.maxMs < 5000, "Explicit reload must not wait for the next 60-second timer tick")
  } finally {
    manager?.close()
    await new Promise((done) => setTimeout(done, 80))
    store?.close()
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert.match(basename(root), /^mods-reload-performance-/)
    await rm(root, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

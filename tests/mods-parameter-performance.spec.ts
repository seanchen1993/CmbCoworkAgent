import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { performance } from "node:perf_hooks"
import { ModControlStore } from "../src/main/mods/control-store"
import { FunctionModsManager } from "../src/main/mods/v2/manager"
import { FunctionGuestRuntime } from "../src/main/mods/v2/guest-runtime"
import { compileFunctionPlugin } from "../src/main/mods/v2/loader"

async function main() {
  const root = await mkdtemp(join(tmpdir(), "mods-parameter-performance-"))
  const path = join(root, "plugin")
  assert(
    dirname(resolve(root)) === resolve(tmpdir()) &&
      basename(root).startsWith("mods-parameter-performance-"),
    "Unexpected cleanup target"
  )
  let manager: FunctionModsManager | undefined
  let store: ModControlStore | undefined
  try {
    await mkdir(join(path, "hooks"), { recursive: true })
    const userConfig = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [
        `field${index}`,
        { type: "string", title: `Field ${index}`, description: "Help", default: "old" }
      ])
    )
    await writeFile(
      join(path, "plugin.json"),
      JSON.stringify({ name: "parameter-performance", userConfig })
    )
    const modules = Array.from({ length: 128 }, (_, index) => `./module${index}.ts`)
    await writeFile(join(path, "hooks/hooks.json"), JSON.stringify({ modules: [modules[0]] }))
    for (const [index, name] of modules.entries()) {
      await writeFile(
        join(path, "hooks", name),
        `${
          index
            ? ""
            : modules
                .slice(1)
                .map((module) => `import ${JSON.stringify(module)};`)
                .join("\n")
        }\n/*${"x".repeat(15000)}*/\nexport function register(on){${
          index
            ? ""
            : `
        on("config.set",{key:"parameter-performance.field0"},async($,e,next)=>{
          const rows=await $.config.list();if(rows.length!==64)throw Error("wrong rows");return next(e)
        })
      `
        }}`
      )
    }
    store = new ModControlStore(join(root, "control.sqlite"))
    const compiled = await compileFunctionPlugin(path)
    store.grant(root, `function:${compiled.name}`, compiled.digest, true)
    manager = new FunctionModsManager(
      store,
      {
        plugins: () => [{ id: "p", name: compiled.name, path, enabled: true }],
        enabled: () => true,
        configurationBusy: () => true,
        publish: async (_workspace, value) => value,
        changed: () => {}
      },
      () => {
        const guests: FunctionGuestRuntime[] = []
        return {
          load: async (...args) => {
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
    await manager.commands(root, "thread")
    const samples: number[] = []
    for (let index = 0; index < 8; index++) {
      const start = performance.now()
      const view = await manager.saveUserConfig(
        root,
        "thread",
        "p",
        compiled.digest,
        "field0",
        String(index),
        index,
        new AbortController().signal,
        () => {}
      )
      samples.push(performance.now() - start)
      assert.equal(view.savedRevision, index + 1)
      assert.equal(view.fields[0].value, String(index))
      assert.equal(view.state, "pending")
    }
    samples.sort((a, b) => a - b)
    const report = {
      scope:
        "Real native save through QuickJS config Hook, one SDK list of 64 rows, 128 sources about 2 MiB, SQLite and source proofs; excludes model/desktop render",
      samples: samples.length,
      medianMs: samples[4],
      p95Ms: samples[7],
      maxMs: samples[7]
    }
    await writeFile("output/mods-parameter-performance.json", JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
    assert(report.maxMs < 5000, "A native parameter save must not exhaust the default Hook budget")
  } finally {
    manager?.close()
    store?.close()
    await rm(root, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

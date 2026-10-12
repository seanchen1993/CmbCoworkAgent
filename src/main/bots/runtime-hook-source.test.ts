import { afterEach, expect, it } from "vitest"
import { mkdtemp, mkdir, writeFile, rm, symlink, rename } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readBotRuntimeHookCatalog, assertBotRuntimeHookCatalog } from "./runtime-hook-source"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cmb-runtime-hooks-"))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const data = join(root, "data"),
    workspace = join(root, "project"),
    plugin = join(root, "plugin")
  await Promise.all(
    [data, workspace, join(plugin, "hooks"), join(workspace, ".cmbdevclaw", "hooks")].map((path) =>
      mkdir(path, { recursive: true })
    )
  )
  const source = { root: data },
    signal = new AbortController().signal
  const read = () => readBotRuntimeHookCatalog(source, workspace, signal)
  return { root, data, workspace, plugin, source, signal, read }
}
it("reuses native and Claude parsing with complete command text, owner identity and scope metadata", async () => {
  const f = await fixture()
  const command = "verify " + "a".repeat(9000)
  await writeFile(
    join(f.data, "hooks.json"),
    JSON.stringify([
      {
        id: "policy",
        event: "PreToolUse",
        matcher: "execute",
        command,
        once: true,
        async: true,
        enabled: true
      },
      { id: "disabled", event: "Stop", command: "unused", enabled: false }
    ])
  )
  await writeFile(
    join(f.data, "plugins.json"),
    JSON.stringify([{ id: "review", name: "Review", path: f.plugin, enabled: true }])
  )
  await writeFile(
    join(f.plugin, "hooks", "hooks.json"),
    JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [{ type: "prompt", prompt: "Verify completion", model: "reviewer", timeout: 5 }]
          }
        ]
      }
    })
  )
  await writeFile(
    join(f.workspace, ".cmbdevclaw", "hooks", "check.json"),
    JSON.stringify({ event: "UserPromptSubmit", prompt: "Check scope", enabled: true })
  )
  const catalog = await f.read()
  expect(catalog.hooks).toHaveLength(3)
  expect(catalog.hooks[0]).toMatchObject({
    id: "policy",
    owner: "global",
    command,
    once: true,
    async: true
  })
  expect(catalog.hooks[1]).toMatchObject({
    owner: "plugin",
    pluginId: "review",
    type: "prompt",
    model: "reviewer",
    timeout: 5000
  })
  expect(catalog.hooks[2]).toMatchObject({
    id: "ws:check",
    owner: "workspace",
    event: "UserPromptSubmit",
    type: "prompt"
  })
  expect(() => assertBotRuntimeHookCatalog(catalog)).not.toThrow()
  await writeFile(join(f.plugin, "hooks", "hooks.json"), "[]")
  expect(() => assertBotRuntimeHookCatalog(catalog)).toThrow(/已变化/)
})
it("detects newly introduced checks, configuration edits, plugin revocation and root replacement", async () => {
  const f = await fixture()
  const empty = await f.read()
  await writeFile(join(f.data, "hooks.json"), "[]")
  expect(() => assertBotRuntimeHookCatalog(empty)).toThrow(/已变化/)
  const saved = await f.read()
  await writeFile(join(f.workspace, ".cmbdevclaw", "hooks", "new.json"), "{}")
  expect(() => assertBotRuntimeHookCatalog(saved)).toThrow(/已变化/)
  const added = await f.read()
  await writeFile(join(f.data, "plugins.json"), "[]")
  expect(() => assertBotRuntimeHookCatalog(added)).toThrow(/已变化/)
  const current = await f.read()
  await rename(f.workspace, join(f.root, "old-project"))
  await mkdir(f.workspace)
  expect(() => assertBotRuntimeHookCatalog(current)).toThrow(/已变化/)
})

it("leaves Function Mod modules to their existing manager while retaining traditional hooks in the same file", async () => {
  const f = await fixture()
  await writeFile(
    join(f.data, "plugins.json"),
    JSON.stringify([{ id: "functions", name: "Functions", enabled: true, path: f.plugin }])
  )
  const path = join(f.plugin, "hooks/hooks.json")
  await writeFile(path, JSON.stringify({ modules: ["./register.ts", "./board.tsx"] }))
  expect((await f.read()).hooks).toEqual([])
  await writeFile(
    path,
    JSON.stringify({
      modules: ["./register.ts"],
      hooks: { Stop: [{ hooks: [{ type: "command", command: "node verify.cjs" }] }] }
    })
  )
  expect((await f.read()).hooks).toMatchObject([
    { owner: "plugin", event: "Stop", command: "node verify.cjs" }
  ])
})
it("rejects malformed, linked, out-of-root and over-limit configurations instead of running a truncated catalog", async () => {
  const f = await fixture()
  const global = join(f.data, "hooks.json")
  await writeFile(global, "{")
  await expect(f.read()).rejects.toThrow(/JSON/)
  await writeFile(global, JSON.stringify([{ id: "missing-handler", event: "PreToolUse" }]))
  await expect(f.read()).rejects.toThrow(/无法执行/)
  await writeFile(
    global,
    JSON.stringify([
      { id: "duplicate", event: "Stop", command: "a" },
      { id: "duplicate", event: "Stop", command: "b" }
    ])
  )
  await expect(f.read()).rejects.toThrow(/标识重复/)
  await writeFile(
    global,
    JSON.stringify({ hooks: { PreCompact: [{ hooks: [{ type: "command", command: "a" }] }] } })
  )
  await expect(f.read()).rejects.toThrow(/暂不支持/)
  await writeFile(
    global,
    JSON.stringify(
      Array.from({ length: 129 }, (_, index) => ({
        id: String(index),
        event: "Stop",
        command: "verify"
      }))
    )
  )
  await expect(f.read()).rejects.toThrow(/128/)
  await rm(global)
  await writeFile(join(f.root, "outside.json"), "[]")
  await symlink(join(f.root, "outside.json"), global)
  await expect(f.read()).rejects.toThrow(/链接/)
  await rm(global)
  await writeFile(
    join(f.data, "plugins.json"),
    JSON.stringify([{ id: "bad", name: "Bad", path: f.plugin, hookPath: "../outside.json" }])
  )
  await expect(f.read()).rejects.toThrow(/路径/)
  const aborted = new AbortController()
  aborted.abort(new Error("cancelled"))
  await expect(readBotRuntimeHookCatalog(f.source, f.workspace, aborted.signal)).rejects.toThrow(
    "cancelled"
  )
})

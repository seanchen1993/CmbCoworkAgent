import { afterEach, expect, it } from "vitest"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { bundledBusinessModExamples, readBundledBusinessModExample } from "./business-mod-examples"
import { compileFunctionPlugin } from "../mods/v2/loader"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "../mods/v2/session"
import { analyzeFunctionSdk } from "../mods/devtools/sdk-usage"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
it("reads shipped knowledge SDK source from the real unpacked ASAR layout and compiles its native extension", async () => {
  const root = await mkdtemp(join(tmpdir(), "business-bundled-example-"))
  roots.push(root)
  const main = join(root, "resources/app.asar/out/main")
  const unpacked = join(root, "resources/app.asar.unpacked/out/resources/mods")
  await mkdir(unpacked, { recursive: true })
  await cp(resolve("resources/mods/autobiz-knowledge"), join(unpacked, "autobiz-knowledge"), {
    recursive: true
  })
  await cp(
    resolve("resources/mods/autobiz-context-provider.py"),
    join(unpacked, "autobiz-context-provider.py")
  )
  const example = await readBundledBusinessModExample("autobiz-knowledge", main)
  expect(example).toMatchObject({
    exampleId: "autobiz-knowledge",
    installed: false,
    kernelRef: { id: "autobiz.python-kernel", version: "1.0.0" }
  })
  expect(example.draft.files).toHaveLength(6)
  expect(example.draft.files.find((file) => file.path.endsWith("/provider.py"))?.text).toBe(
    await readFile(resolve("resources/mods/autobiz-context-provider.py"), "utf8")
  )
  const extension = example.draft.extensions![0]
  expect(extension.skills).toEqual([
    "mods/business/autobiz.knowledge/skills/knowledge-sync/SKILL.md"
  ])
  const config = JSON.parse(await readFile(resolve("package.json"), "utf8"))
  expect(config.build.asarUnpack).toContain("out/resources/mods/**")
  const plugin = join(root, "plugin")
  for (const file of example.draft.files) {
    await mkdir(dirname(join(plugin, file.path)), { recursive: true })
    await writeFile(join(plugin, file.path), file.text)
  }
  await writeFile(
    join(plugin, "plugin.json"),
    JSON.stringify({ name: "knowledge-sdk-compiled", version: "1.0.0", mods: "mods/manifest.json" })
  )
  await writeFile(
    join(plugin, "mods/manifest.json"),
    JSON.stringify({
      apiVersion: "cmb.mods/v2",
      id: "knowledge-sdk-compiled",
      claw: {
        componentsVersion: 1,
        actions: [],
        components: [
          {
            id: extension.id,
            name: extension.title,
            kind: "module",
            entry: extension.entry.slice(5),
            dependsOn: [],
            actionIds: [],
            usage: "project"
          }
        ]
      }
    })
  )
  expect(
    (await compileFunctionPlugin(plugin)).components?.map((component) => component.id)
  ).toEqual(["autobiz.knowledge"])
  expect(bundledBusinessModExamples.map((example) => example.exampleId)).toEqual([
    "autobiz-knowledge",
    "autobiz-state-machine"
  ])
  await expect(readBundledBusinessModExample("../../private", main)).rejects.toThrow(
    "BUSINESS_CREATOR_EXAMPLE_UNAVAILABLE"
  )
})

it("discovers shipped executable state source, preserves all eight resources and registers normalized tools in a renamed plugin", async () => {
  const root = await mkdtemp(join(tmpdir(), "business-bundled-state-example-"))
  roots.push(root)
  const main = join(root, "resources/app.asar/out/main")
  const unpacked = join(root, "resources/app.asar.unpacked/out/resources/mods")
  await mkdir(unpacked, { recursive: true })
  await cp(
    resolve("resources/mods/autobiz-state-machine"),
    join(unpacked, "autobiz-state-machine"),
    { recursive: true }
  )
  const example = await readBundledBusinessModExample("autobiz-state-machine", main)
  expect(example).toMatchObject({
    exampleId: "autobiz-state-machine",
    installed: false,
    kernelRef: { id: "autobiz.original-234-kernel", version: "1.0.3" },
    execution: "requires-native-approved-business-trial"
  })
  expect(example.draft.files).toHaveLength(8)
  const extension = example.draft.extensions![0]
  expect(extension.skills).toEqual([
    "mods/business/autobiz.state-machine/skills/autobiz-mod-state-control/SKILL.md"
  ])
  expect(extension.resources).toEqual(
    expect.arrayContaining([
      "mods/business/autobiz.state-machine/journal.py",
      "mods/business/autobiz.state-machine/hook_checks.py",
      ...extension.skills!
    ])
  )
  const plugin = join(root, "renamed-plugin")
  for (const file of example.draft.files) {
    const originalName = file.path.endsWith("/SKILL.md")
      ? "SKILL.md"
      : file.path.slice(file.path.lastIndexOf("/") + 1)
    expect(file.text).toBe(
      await readFile(resolve("resources/mods/autobiz-state-machine", originalName), "utf8")
    )
    await mkdir(dirname(join(plugin, file.path)), { recursive: true })
    await writeFile(join(plugin, file.path), file.text)
  }
  await writeFile(
    join(plugin, "plugin.json"),
    JSON.stringify({ name: "autobiz.state-renamed", version: "1.0.0", mods: "mods/manifest.json" })
  )
  await mkdir(join(plugin, "mods"), { recursive: true })
  await writeFile(
    join(plugin, "mods/manifest.json"),
    JSON.stringify({
      apiVersion: "cmb.mods/v2",
      id: "autobiz.state-renamed",
      claw: {
        componentsVersion: 1,
        components: [
          {
            id: extension.id,
            name: extension.title,
            kind: "module",
            entry: extension.entry.slice(5),
            dependsOn: [],
            actionIds: [],
            usage: "project"
          }
        ]
      }
    })
  )
  const compiled = await compileFunctionPlugin(plugin, { captureSources: true })
  const sdk = await analyzeFunctionSdk(compiled)
  expect(sdk.diagnostics).toEqual([])
  expect(sdk.strictCompatible).toBe(true)
  expect(sdk.usages.map((usage) => usage.method)).toEqual(
    expect.arrayContaining(["process.run", "tool.register", "command.register"])
  )
  let approvalRequests = 0
  let fallthrough = false
  const guest = await FunctionGuestRuntime.create(compiled.code, compiled.options)
  const session = new FunctionSession(
    [
      {
        name: compiled.name,
        root: compiled.root,
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: root,
      threadId: "state-template",
      assertLive: () => {
        /* Native fixture scope is current. */
      },
      publish: async (value) => value,
      authorizeProcess: async () => {
        approvalRequests++
        throw Error("PROCESS_PERMISSION_REQUIRED")
      }
    }
  )
  try {
    expect(session.plugins[0].guest.registrations.map((item) => item.pattern)).toContain(
      "session.start"
    )
    await session.start()
    const tools = await session.registeredTools()
    expect(tools.map((tool) => tool.name)).toContain("mcp__autobiz_state-renamed__state_read")
    const advance = tools.find((tool) => tool.name.endsWith("__state_advance"))!
    expect(advance.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["feature", "to", "expectedStateDigest", "requestKey"]
    })
    expect(approvalRequests).toBe(0)
    await expect(
      session.interceptTool(
        {
          tool: "mcp__autobiz_state-renamed__state_read",
          tool_use_id: "source-template-read",
          feature: "feature"
        },
        undefined,
        async () => {
          fallthrough = true
          throw Error("TOOL_FELL_THROUGH")
        }
      )
    ).resolves.toMatchObject({
      isError: true,
      result: { ok: false, status: "unknown", errors: ["PROCESS_PERMISSION_REQUIRED"] }
    })
    expect(approvalRequests).toBe(1)
    expect(fallthrough).toBe(false)
  } finally {
    await session.close()
  }
  await writeFile(join(unpacked, "autobiz-state-machine/journal.py"), "x".repeat(64 * 1024 + 1))
  await expect(readBundledBusinessModExample("autobiz-state-machine", main)).rejects.toThrow(
    "BUSINESS_CREATOR_EXAMPLE_RESOURCE_LIMIT"
  )
})

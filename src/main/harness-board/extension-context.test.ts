import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { createProjectTemplate } from "../mods/devtools/project-template"
import { parseProjectRuntimeManifest, wrapProjectRuntimeManifest,
  CONTEXT_HANDOFF_PROTOCOL } from "../../shared/project-runtime"
import {
  prepareExtensionContext,
  readExtensionContextProjection,
  configureExtensionContextDirectoryBinding
} from "./extension-context"

const roots: string[] = []
afterEach(async () => {
  configureExtensionContextDirectoryBinding()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it.each(["composition-legacy:run:unit", "creator-business-trial:trial"])(
  "requires the original exact source owner before preparing context for %s", async projectId => {
    const f = await fixture()
    await expect(prepareExtensionContext({ ...f.input, projectId }))
      .rejects.toThrow("COMPOSITION_CONTEXT_SOURCE_ADMISSION_REQUIRED")
    let checks = 0
    configureExtensionContextDirectoryBinding(undefined, async (source, workspace, owner) => {
      expect([source, workspace, owner]).toEqual([f.source, f.input.workspace, projectId])
      return () => { checks++ }
    })
    const prepared = (await prepareExtensionContext({ ...f.input, projectId }))!
    try {
      expect(checks).toBeGreaterThanOrEqual(3)
      expect(prepared.assertCurrent).toBeTypeOf("function")
    } finally { prepared.release() }
  }
)

it("rejects a creator trial owner revoked while resolving native knowledge configuration", async () => {
  const f = await fixture("knowledgeRoot"), knowledge = join(f.root, "knowledge")
  await mkdir(knowledge)
  let current = true
  configureExtensionContextDirectoryBinding(undefined, async () => () => {
    if (!current) throw Error("ORIGINAL_TRIAL_OWNER_REVOKED")
  })
  await expect(prepareExtensionContext({
    ...f.input,
    projectId: "creator-business-trial:trial",
    operation: "session-context",
    configuration: { directoryBinding: async () => { current = false; return knowledge } }
  })).rejects.toThrow("ORIGINAL_TRIAL_OWNER_REVOKED")
})
async function fixture(binding?: string) {
  const root = await mkdtemp(join(tmpdir(), "cmb-context-binding-"))
  roots.push(root)
  const source = join(root, "source")
  const board = { agentsRepo: { url: "local-test" }, supported_deploy_units: [],
    inspectCommands: { win32: { knowledge_path: "${pluginPath}\\sys", pull_knowledge: "original" } } }
  await mkdir(join(source, "board_core"), { recursive: true })
  await mkdir(join(source, "mods/provider"), { recursive: true })
  await writeFile(join(source, "mods/provider/main.py"), "print('provider')")
  const template = createProjectTemplate({ packageId: "context-sample", name: "Context sample" })
  const v1 = parseProjectRuntimeManifest(JSON.parse(template.files.find(file =>
    file.path === "devclaw.project-runtime.json")!.text))
  const runtime = wrapProjectRuntimeManifest(v1, {
    apiVersion: "devclaw.extension-contract/v1", requires: [CONTEXT_HANDOFF_PROTOCOL],
    context: { sourceAccess: "read-only", mutableData: "host", configuration: "host-resolved",
      knowledge: { required: true, ...(binding ? { binding } : {}) },
      provider: { entry: "mods/provider/main.py", operations: ["session-context", "sync-knowledge"] } }
  })
  await writeFile(join(source, "plugin.json"), JSON.stringify({ name: v1.plugin.id, version: v1.plugin.version }))
  await writeFile(join(source, "devclaw.project-runtime.json"), JSON.stringify(runtime))
  const original = JSON.stringify(board)
  await writeFile(join(source, "board_core/board_config.json"), original)
  const input = { sourceRoot: source, workspace: join(root, "workspace"), dataRoot: join(root, "data"),
    operation: "sync-knowledge" as const,
    invocation: { executable: "python", args: ["-X", "utf8", join(source, "hooks/sync_agents.py"),
      "--prefer-manifest", "--write-board-config"] } }
  return { root, source, input, original }
}

it("keeps the immutable board and original arguments while binding writable data outside the package", async () => {
  const f = await fixture()
  const prepared = (await prepareExtensionContext(f.input))!
  try {
    expect(prepared.invocation.args).toContain(join(f.source, "mods/provider/main.py"))
    expect(prepared.invocation.args.slice(-2)).toEqual(["--prefer-manifest", "--write-board-config"])
    expect(prepared.env.DEVCLAW_KNOWLEDGE_ROOT.startsWith(f.input.dataRoot)).toBe(true)
    const runtime = JSON.parse(await readFile(prepared.env.DEVCLAW_RUNTIME_CONFIG_PATH, "utf8"))
    expect(runtime.inspectCommands.win32.pull_knowledge).toBe("original")
    expect(runtime.inspectCommands.win32.knowledge_path).toBe(prepared.env.DEVCLAW_KNOWLEDGE_ROOT)
    expect(await readFile(join(f.source, "board_core/board_config.json"), "utf8")).toBe(f.original)
    runtime.supported_deploy_units = [{ deployUnitId: "new-unit" }]
    runtime.inspectCommands.win32.pull_knowledge = "untrusted-cache-command"
    await writeFile(prepared.env.DEVCLAW_RUNTIME_CONFIG_PATH, JSON.stringify(runtime))
  } finally { prepared.release() }
  const next = (await prepareExtensionContext(f.input))!
  try {
    const runtime = JSON.parse(await readFile(next.env.DEVCLAW_RUNTIME_CONFIG_PATH, "utf8"))
    expect(runtime.supported_deploy_units).toEqual([{ deployUnitId: "new-unit" }])
    expect(runtime.inspectCommands.win32.pull_knowledge).toBe("original")
  } finally { next.release() }
})

it("uses a host cache by default and treats a saved external directory binding as read-only", async () => {
  const f = await fixture("knowledgeRoot")
  const fallback = (await prepareExtensionContext(f.input))!
  expect(fallback.env.DEVCLAW_KNOWLEDGE_READONLY).toBe("0")
  expect(fallback.env.DEVCLAW_KNOWLEDGE_ROOT.startsWith(f.input.dataRoot)).toBe(true)
  fallback.release()
  await expect(prepareExtensionContext({ ...f.input,
    configuration: { directoryBinding: async () => f.source } }))
    .rejects.toThrow("KNOWLEDGE_INSIDE_SOURCE")
  const knowledge = join(f.root, "bound-knowledge")
  await mkdir(knowledge)
  await expect(prepareExtensionContext({ ...f.input,
    configuration: { directoryBinding: async () => knowledge } }))
    .rejects.toThrow("KNOWLEDGE_READONLY")
  const prepared = (await prepareExtensionContext({ ...f.input, operation: "session-context",
    configuration: { directoryBinding: async () => knowledge } }))!
  expect(prepared.env.DEVCLAW_KNOWLEDGE_ROOT).toBe(knowledge)
  expect(prepared.env.DEVCLAW_KNOWLEDGE_READONLY).toBe("1")
  prepared.release()
})

it("does not redirect legacy packages without the new inline contract", async () => {
  const f = await fixture()
  const wrapped = JSON.parse(await readFile(join(f.source, "devclaw.project-runtime.json"), "utf8"))
  await writeFile(join(f.source, "devclaw.project-runtime.json"), JSON.stringify(wrapped.runtime))
  expect(await prepareExtensionContext(f.input)).toBeUndefined()
})

it("shares default knowledge across worktrees and isolates actual read-only sources instead of chat paths", async () => {
  const f = await fixture("knowledgeRoot")
  const first = (await prepareExtensionContext(f.input))!
  const root = first.env.DEVCLAW_PLUGIN_DATA_ROOT
  const runtime = JSON.parse(await readFile(first.env.DEVCLAW_RUNTIME_CONFIG_PATH, "utf8"))
  runtime.supported_deploy_units = ["new-unit"]
  runtime.inspectCommands.win32.pull_knowledge = "untrusted-cache-command"
  await writeFile(first.env.DEVCLAW_RUNTIME_CONFIG_PATH, JSON.stringify(runtime))
  first.release()
  const second = (await prepareExtensionContext({ ...f.input, workspace: join(f.root, "other-worktree") }))!
  expect(second.env.DEVCLAW_PLUGIN_DATA_ROOT).toBe(root)
  second.release()
  const projection = (await readExtensionContextProjection({ sourceRoot: f.source,
    workspace: f.input.workspace, dataRoot: f.input.dataRoot }))!
  expect(projection.supportedDeployUnits).toEqual(["new-unit"])
  expect(projection).not.toHaveProperty("inspectCommands")
  const roots: string[] = []
  for (const name of ["kb-one", "kb-two", "kb-one"]) {
    const binding = join(f.root, name)
    await mkdir(binding, { recursive: true })
    const prepared = (await prepareExtensionContext({ ...f.input, operation: "session-context",
      workspace: join(f.root, `chat-${roots.length}`),
      configuration: { directoryBinding: async () => binding } }))!
    roots.push(prepared.env.DEVCLAW_PLUGIN_DATA_ROOT)
    expect(prepared.env.DEVCLAW_KNOWLEDGE_READONLY).toBe("1")
    prepared.release()
  }
  expect(roots[0]).not.toBe(roots[1])
  expect(roots[0]).toBe(roots[2])
})

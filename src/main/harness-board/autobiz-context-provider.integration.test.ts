import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { snapshotDerivationSource, writeDerivationFiles } from "../plugins/derivation-source"
import { createProjectTemplate } from "../mods/devtools/project-template"
import { parseProjectRuntimeManifest, wrapProjectRuntimeManifest,
  CONTEXT_HANDOFF_PROTOCOL } from "../../shared/project-runtime"
import { prepareExtensionContext } from "./extension-context"
import { closeRequiredPromptFixtures, createRequiredPromptFixture } from "../agent/required-prompt-context.test-helper"
import { extractErrorDetail } from "../agent/failover"

const execute = promisify(execFile)
const realSource = process.env.AUTOBIZ_CONTEXT_TEST_SOURCE ?? "C:/ai/autobiz_kanban"
const dependencies = resolve(process.env.AUTOBIZ_CONTEXT_TEST_DEPENDENCIES ?? "output/creator-context-fixture-deps/node_modules")
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  await closeRequiredPromptFixtures()
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "autobiz-real-context-"))
  cleanup.push(async () => {
    if (dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("autobiz-real-context-")) throw Error("Unsafe cleanup")
    await rm(root, { recursive: true, force: true })
  })
  const source = join(root, "package")
  const upstream = await snapshotDerivationSource(realSource)
  await writeDerivationFiles(source, upstream.files)
  const providerEntry = "mods/business/context/provider.py"
  await mkdir(dirname(join(source, providerEntry)), { recursive: true })
  await cp(resolve("resources/mods/autobiz-context-provider.py"), join(source, providerEntry))
  const plugin = JSON.parse(await readFile(join(source, "plugin.json"), "utf8"))
  const template = createProjectTemplate({ packageId: "context-fixture", name: "Context fixture" })
  const originalRuntime = parseProjectRuntimeManifest(JSON.parse(template.files.find(file =>
    file.path === "devclaw.project-runtime.json")!.text))
  originalRuntime.plugin = { id: plugin.name, version: plugin.version }
  const runtime = wrapProjectRuntimeManifest(originalRuntime, {
    apiVersion: "devclaw.extension-contract/v1", requires: [CONTEXT_HANDOFF_PROTOCOL],
    context: { sourceAccess: "read-only", mutableData: "host", configuration: "host-resolved",
      knowledge: { required: true, binding: "knowledgeRoot" },
      provider: { entry: providerEntry, operations: ["session-context", "sync-knowledge"] } }
  })
  await writeFile(join(source, "devclaw.project-runtime.json"), JSON.stringify(runtime))
  const repository = join(root, "knowledge-upstream")
  await mkdir(join(repository, "DW"), { recursive: true })
  await writeFile(join(repository, "agents.manifest.json"), JSON.stringify({ schemaVersion: "v1",
    systems: [{ systemId: "DW", systemName: "Warehouse", agentsPath: "DW/AGENTS.md",
      deployUnits: [{ deployUnitId: "DW.ORDER", description: "Orders" }] }] }))
  await writeFile(join(repository, "DW/AGENTS.md"), "# Warehouse\nORIGINAL_WAREHOUSE_RULE_MUST_SURVIVE\n")
  await writeFile(join(repository, "DW/orders.md"),
    "---\ndeploy_unit: DW.ORDER\ntype: Product Knowledge\ntitle: Governed order model\ndescription: MODEL_KNOWLEDGE_MUST_SURVIVE\n---\nOrders facts\n")
  await execute("git", ["init", "-b", "fixture-knowledge", repository])
  await execute("git", ["-C", repository, "add", "."])
  await execute("git", ["-C", repository, "-c", "user.name=Context fixture", "-c",
    "user.email=context@example.invalid", "commit", "-m", "fixture"])
  const boardPath = join(source, "board_core/board_config.json")
  const board = JSON.parse(await readFile(boardPath, "utf8"))
  board.apiVersion = 2
  board.agentsRepo = { url: repository, sshUrl: "", ref: "fixture-knowledge" }
  board.supported_deploy_units = ["OLD_UNIT"]
  await writeFile(boardPath, JSON.stringify(board))
  const workspace = join(root, "workspace")
  await mkdir(workspace)
  await writeFile(join(workspace, "AGENTS.md"), "# Workspace\nWORKSPACE_RULE_MUST_SURVIVE\n")
  const networkFixture = join(root, "network-fixture.cjs")
  // Only the external app-type metadata response is a fixture. The original collector and
  // Python sync/render/manifest loaders execute unmodified; no network socket is opened.
  await writeFile(networkFixture, `const http=require("node:http"),{Readable}=require("node:stream"),{EventEmitter}=require("node:events");
    http.request=(options,callback)=>{if(options.hostname!=="archguardservice.paas.cmbchina.cn")throw Error("NETWORK_BLOCKED");
      const request=new EventEmitter();request.end=()=>queueMicrotask(()=>callback(Readable.from([JSON.stringify({returnCode:"SUC0000",body:{buildEngineName:"java"}})])));request.destroy=()=>{};return request};`)
  const sourceBefore = await snapshotDerivationSource(source)
  const invocation = (script: string, args: string[]) => ({ executable: "python",
    args: ["-X", "utf8", join(source, "hooks", script), ...args] })
  const prepare = (operation: "session-context" | "sync-knowledge", script: string,
    args: string[], binding?: string, scope = workspace) => prepareExtensionContext({
    sourceRoot: source, workspace: scope, dataRoot: join(root, "data"), operation,
    invocation: invocation(script, args), configuration: { directoryBinding: async () => binding }
  })
  const run = async (prepared: NonNullable<Awaited<ReturnType<typeof prepareExtensionContext>>>,
    copyDependencies = false) => {
    try {
      if (copyDependencies) {
        if (!existsSync(join(dependencies, "gray-matter/index.js")))
          throw Error("Prepare fixture deps: npm --prefix output/creator-context-fixture-deps --ignore-scripts install gray-matter@4.0.3")
        await mkdir(join(prepared.env.DEVCLAW_PLUGIN_DATA_ROOT, "collector"), { recursive: true })
        await cp(dependencies, join(prepared.env.DEVCLAW_PLUGIN_DATA_ROOT, "collector/node_modules"),
          { recursive: true })
      }
      const result = await execute(prepared.invocation.executable, prepared.invocation.args, {
        cwd: source, windowsHide: true, timeout: 45000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ...prepared.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1",
          npm_config_offline: "true", NODE_OPTIONS: `--require "${networkFixture.replace(/\\/g, "/")}"` }
      })
      return { parsed: JSON.parse(result.stdout), stderr: result.stderr }
    } finally { prepared.release() }
  }
  return { root, source, sourceBefore, upstream, repository, workspace, plugin, board, prepare, run }
}

describe.runIf(process.env.RUN_AUTOBIZ_COLLECTOR_INTEGRATION === "1")("real AutoBiz context provider", () => {
  beforeAll(() => {
    if (!existsSync(join(realSource, "hooks/sync_agents.py")))
      throw Error("AUTOBIZ_CONTEXT_TEST_SOURCE_REQUIRED")
    if (!existsSync(join(dependencies, "gray-matter/index.js")))
      throw Error("AUTOBIZ_CONTEXT_TEST_DEPENDENCIES_REQUIRED")
  })
  it("syncs a local Git repository and executes original collector/render without changing package bytes", async () => {
    const f = await fixture()
    const sync = (await f.prepare("sync-knowledge", "sync_agents.py",
      ["--prefer-manifest", "--write-board-config"]))!
    const root = sync.env.DEVCLAW_KNOWLEDGE_ROOT
    const data = sync.env.DEVCLAW_PLUGIN_DATA_ROOT
    const pulled = await f.run(sync, true)
    expect(pulled.parsed).toMatchObject({ ok: true, runtimeConfigWritten: true,
      boardConfigWritten: false, supported_deploy_units: ["DW.ORDER"],
      repo: { ref: "fixture-knowledge", url: f.repository } })
    expect(await readFile(join(root, "DW/AGENTS.md"), "utf8")).toContain("ORIGINAL_WAREHOUSE_RULE_MUST_SURVIVE")
    const list = (await f.prepare("session-context", "render_collected_session_context.py",
      ["--list-supported-deploy-ids", "--node-command", process.execPath], undefined,
      join(f.root, "another-worktree")))!
    expect(list.env.DEVCLAW_KNOWLEDGE_ROOT).toBe(root)
    expect((await f.run(list)).parsed).toContain("DW.ORDER")
    const render = (await f.prepare("session-context", "render_collected_session_context.py",
      ["--selected-deployUnit", JSON.stringify([{ deployUnitId: "DW.ORDER" }]),
        "--session-workspace-path", f.workspace, "--node-command", process.execPath]))!
    const rendered = await f.run(render)
    expect(rendered.parsed.ok).toBe(true)
    expect(rendered.parsed.sessionContext).toContain("MODEL_KNOWLEDGE_MUST_SURVIVE")
    expect(rendered.parsed.sessionContext).toContain("WORKSPACE_RULE_MUST_SURVIVE")
    // Use the actual original Python + collector output as protected context at the real
    // guest prompt pipeline and native model seam, not a handwritten substitute marker.
    const actualContext = rendered.parsed.sessionContext as string
    const retained = await createRequiredPromptFixture(`on("prompt.compose",async($,event,next)=>{
      const value=await next(event);return {sections:[...value.sections,
        {id:"custom",text:"CUSTOM_LEGAL_EXTENSION",scope:"session"}]}
    })`, undefined, true, actualContext)
    await retained.invoke()
    expect(retained.stream).toHaveBeenCalledTimes(1)
    const providerInput = retained.stream.mock.calls[0][0] as Array<{ content: unknown }>
    expect(providerInput[0].content).toContain(actualContext)
    expect(providerInput[0].content).toContain("CUSTOM_LEGAL_EXTENSION")
    await closeRequiredPromptFixtures()
    const removed = await createRequiredPromptFixture(
      'on("prompt.compose",async()=>({sections:[]}))', undefined, true, actualContext)
    const error = await removed.invoke().then(() => undefined, error => error)
    expect(extractErrorDetail(error)).toMatchObject({ code: "harness_context_unavailable" })
    expect(removed.stream).not.toHaveBeenCalled()
    expect(rendered.parsed.agentmdLoadStatus).toContainEqual(expect.objectContaining({
      deployUnitId: "DW.ORDER", loaded: true, source: "remote" }))
    const config = JSON.parse(await readFile(join(data, "board_config.json"), "utf8"))
    expect(config.supported_deploy_units).toEqual(["DW.ORDER"])
    expect(config.inspectCommands.win32.pull_knowledge).toBe(f.board.inspectCommands.win32.pull_knowledge)
    expect(existsSync(join(f.source, "hooks/node_modules"))).toBe(false)
    expect(existsSync(join(f.source, "hooks/__pycache__"))).toBe(false)
    expect((await snapshotDerivationSource(f.source)).digest).toBe(f.sourceBefore.digest)
    expect((await snapshotDerivationSource(realSource)).digest).toBe(f.upstream.digest)
  }, 60000)

  it("preserves external bound folders and reports an unknown selected unit as not loaded", async () => {
    const f = await fixture()
    const external = join(f.root, "external-knowledge")
    await mkdir(external)
    await writeFile(join(external, "keep.md"), "MUST_NOT_DELETE")
    await expect(f.prepare("sync-knowledge", "sync_agents.py", ["--prefer-manifest"], external))
      .rejects.toThrow("KNOWLEDGE_READONLY")
    expect(await readFile(join(external, "keep.md"), "utf8")).toBe("MUST_NOT_DELETE")
    const sync = (await f.prepare("sync-knowledge", "sync_agents.py", ["--prefer-manifest"]))!
    const data = sync.env.DEVCLAW_PLUGIN_DATA_ROOT
    await f.run(sync, true)
    const render = (await f.prepare("session-context", "render_collected_session_context.py",
      ["--selected-deployUnit", JSON.stringify([{ deployUnitId: "DOES.NOT.EXIST" }]),
        "--node-command", process.execPath]))!
    const rendered = await f.run(render)
    expect(rendered.parsed.agentmdLoadStatus).toContainEqual(expect.objectContaining({
      deployUnitId: "DOES.NOT.EXIST", loaded: false }))
    expect(rendered.parsed.sessionContext).not.toContain("MODEL_KNOWLEDGE_MUST_SURVIVE")
    await rename(join(data, "collector"), join(data, "collector-saved"))
    await symlink(external, join(data, "collector"), process.platform === "win32" ? "junction" : "dir")
    const redirected = (await f.prepare("session-context", "render_collected_session_context.py",
      ["--list-supported-deploy-ids", "--node-command", process.execPath]))!
    await expect(f.run(redirected)).rejects.toMatchObject({
      stdout: expect.stringContaining("AUTOBIZ_CONTEXT_COLLECTOR_SCOPE_CHANGED") })
    expect(await readFile(join(external, "keep.md"), "utf8")).toBe("MUST_NOT_DELETE")
    expect((await snapshotDerivationSource(f.source)).digest).toBe(f.sourceBefore.digest)
  }, 60000)
})

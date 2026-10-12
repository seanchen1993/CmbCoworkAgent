import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, it } from "vitest"
import { BotFunctionPresentation } from "./function-presentation"
import { BotProjectFiles } from "./project-files"
import { BotStore } from "./store"
import { writeBotModelSnapshot, type BotModelSnapshot } from "./model-config"
import { invalidateBotModelSnapshot } from "./model-config-fence"
import { botModsConfigurationDigest } from "./mods-configuration"
import { DEFAULT_MOD_POLICY } from "../mods/policy-core"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bot-pane-presentation-")))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const workspacePath = join(root, "project")
  await mkdir(workspacePath)
  await writeFile(join(workspacePath, "notes.txt"), "Project notes")
  const store = new BotStore(":memory:")
  cleanup.push(() => store.close())
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "Owner", workspacePath })
  const modelFile = join(root, "models.json")
  const snapshot: BotModelSnapshot = { version: 1, defaultRef: null, models: [] }
  await writeBotModelSnapshot(modelFile, snapshot)
  const surface = new BotFunctionPresentation({
    store,
    botId: bot.id,
    workspacePath,
    modelRef: null,
    connectors: [],
    workspace: workspacePath,
    threadId: conversationId,
    project: await BotProjectFiles.open(workspacePath),
    modelFile,
    digest: botModsConfigurationDigest(snapshot),
    policy: DEFAULT_MOD_POLICY,
    plugins: [],
    policyEntry: join(root, "must-not-launch.cjs")
  })
  cleanup.push(() => surface.close())
  await surface.current()
  return { root, store, bot, conversationId, workspacePath, surface, modelFile, snapshot }
}

it("permits only in-scope project reads and never lends idle input model, tools or command authority", async () => {
  const f = await fixture()
  const scope = f.surface.host.fileScope!(f.workspacePath, f.conversationId)!
  expect(await scope.queryTool("host:read_file", { file_path: "notes.txt" })).toEqual({
    decision: "allow"
  })
  expect(await scope.queryTool("host:ls", { path: f.workspacePath })).toEqual({ decision: "allow" })
  for (const [tool, args] of [
    ["host:write_file", { file_path: "notes.txt", content: "override" }],
    ["host:read_file", { file_path: "../models.json" }],
    ["host:read_file", { file_path: f.modelFile }]
  ] as const)
    expect(await scope.queryTool(tool, args)).toEqual({ decision: "deny" })
  expect(() => f.surface.host.fileScope!(f.workspacePath, "other")).toThrow(
    "MODS_CALL_SCOPE_CHANGED"
  )
  for (const key of [
    "callTool",
    "callMcp",
    "completeModel",
    "registeredTool",
    "scheduleCommand",
    "readSession",
    "compactSession",
    "abortTurn"
  ] as const)
    expect(() => Reflect.apply(f.surface.host[key]!, f.surface.host, [])).toThrow(
      "MODS_UI_ACTION_REQUIRED"
    )
  f.surface.close()
  expect(scope.assertLive).toThrow("MODS_SCOPE_CHANGED")
})

it("allows an equivalent snapshot rewrite but immediately fences a pending or changed configuration", async () => {
  const f = await fixture()
  await writeBotModelSnapshot(f.modelFile, f.snapshot)
  await f.surface.current()
  await writeBotModelSnapshot(f.modelFile, { ...f.snapshot, defaultRef: "new-model" })
  await expect(f.surface.current()).rejects.toThrow("MODS_SCOPE_CHANGED")
  const other = await fixture()
  invalidateBotModelSnapshot(other.modelFile)
  await expect(other.surface.current()).rejects.toThrow("配置正在同步")
})

it("fences project replacement even when the configured path remains the same", async () => {
  const f = await fixture()
  await rename(f.workspacePath, `${f.workspacePath}-old`)
  await mkdir(f.workspacePath)
  await expect(f.surface.current()).rejects.toThrow("MODS_SCOPE_CHANGED")
  const other = await fixture()
  await rename(other.workspacePath, `${other.workspacePath}-old`)
  await symlink(`${other.workspacePath}-old`, other.workspacePath, "junction")
  await expect(other.surface.current()).rejects.toThrow("MODS_SCOPE_CHANGED")
})

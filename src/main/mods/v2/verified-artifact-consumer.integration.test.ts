import { afterEach, expect, it, vi } from "vitest"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { compileFunctionPlugin } from "./loader"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { ProjectFunctionFiles } from "./file-access"
import { withFunctionExecution } from "./execution-context"
import { functionSdkToolInput } from "./tool-sdk"
import { LocalSandbox } from "../../agent/local-sandbox"
import { ModsManager, getModsManager, setModsManager } from "../manager"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"

vi.mock("electron", () => ({ app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] }, dialog: {}, ipcMain: { handle: () => {} } }))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const hash = (text: string) => createHash("sha256").update(text).digest("hex")

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "verified-consumer-sdk-")), workspace = join(root, "workspace")
  mkdirSync(join(workspace, "inputs"), { recursive: true })
  // This fixture validates SDK/file mechanics, not authenticity of business-stage receipts.
  const document = JSON.stringify({ title: "独立文档场景", sections: 3, approval: "pending" })
  const bundle = { apiVersion: "devclaw.autobiz-context/v1", producer: {
    compositionRunId: "actual-binding-fixture", unitId: "documents", engineRunId: "original",
    source: { pluginId: "documents", packageDigest: "a".repeat(64) }, evidenceDigest: "b".repeat(64)
  }, files: [{ id: "document", path: ".autobizdevops/features/feature/document.json",
    digest: hash(document), content: document, outputNodeId: "draft",
    checkedBy: { nodeId: "review", checkId: "document-check", contractDigest: "c".repeat(64) } }] }
  const input = join(workspace, "inputs/verified-context.json"), output = join(workspace, "consumed-report.json")
  writeFileSync(input, JSON.stringify(bundle))
  const compiled = await compileFunctionPlugin(resolve("examples/verified-artifact-consumer"))
  const manager = new ModsManager(join(root, "control.sqlite"), () => [], async () => true, () => {})
  const previous = getModsManager()
  setModsManager(manager)
  manager.configure(workspace, true, false)
  const key = manager.workspaceKey(workspace)
  const grant = manager.store.grant(key, "function:" + compiled.name, compiled.digest, true)
  const threadId = randomUUID(), controller = new AbortController()
  expect(claimLocalThreadRunLease({ threadId, owner: "mods", runId: "run" }).acquired).toBe(true)
  const authority = manager.createRuntimeAuthority({ workspace, threadId, turnId: "turn", signal: controller.signal })
  let release = () => {}
  const sandbox = new LocalSandbox({ rootDir: workspace, modWorkspace: workspace,
    modRuntimeAuthority: authority.authority, runId: threadId, hookTurnId: "turn", windowsSandbox: "none",
    abortSignal: controller.signal, onModBinding: dispose => { release = dispose } })
  const guest = await FunctionGuestRuntime.create(compiled.code)
  const session = new FunctionSession([{ name: compiled.name, root: compiled.root, tier: "user", guest,
    capabilities: [...SESSION_CAPABILITIES] }], {
    workspace: key, threadId, assertLive: () => manager.store.assertGrant(grant), publish: async value => value,
    files: () => new ProjectFunctionFiles(workspace, () => manager.store.assertGrant(grant), async value => value),
    callTool: async (_plugin, input, signal) => {
      const { target, args } = functionSdkToolInput(input)
      return manager.invokeFunctionTool(workspace, threadId, grant, target, args, signal, false, true)
    }
  })
  cleanup.push(async () => {
    controller.abort()
    await session.close()
    await LocalSandbox.cancelBackgroundTasksAndWait(threadId)
    release()
    authority.release()
    releaseLocalThreadRunLease(threadId, "mods", "run")
    manager.close()
    setModsManager(previous)
    rmSync(root, { recursive: true, force: true })
  })
  const run = (requiredIds: string[] = ["document"], extra: Record<string, string> = {}) => withFunctionExecution({
    workspace: key, threadId, turnId: "turn", leased: true, immediate: false, userInitiated: true
  }, () => session.interceptTool({ tool: "mcp__verified-artifact-consumer__inspect", tool_use_id: randomUUID(), requiredIds, ...extra },
    controller.signal, async () => { throw Error("Native fallback must not replace the real Guest") }))
  return { run, bundle, input, output, sandbox }
}

it("reads the original bound file and writes the real deterministic report through the native SDK", async () => {
  const f = await fixture()
  const first = await f.run()
  const report = JSON.parse(readFileSync(f.output, "utf8"))
  expect(first.result).toEqual(report)
  expect(report.bundleDigest).toBe(hash(readFileSync(f.input, "utf8")))
  expect(report.artifacts[0].value).toEqual({ title: "独立文档场景", sections: 3, approval: "pending" })
  expect(await f.run()).toEqual(first)
})
it("rejects changed contents and missing IDs before any report write", async () => {
  const f = await fixture()
  await expect(f.run(["missing"])).rejects.toThrow()
  expect(existsSync(f.output)).toBe(false)
  f.bundle.files[0].content = '{"sections":999}'
  writeFileSync(f.input, JSON.stringify(f.bundle))
  await expect(f.run()).rejects.toThrow()
  expect(existsSync(f.output)).toBe(false)
})
it("does not accept substituted model bundle arguments or overwrite an unrelated report", async () => {
  const f = await fixture()
  await expect(f.run(["document"], { content: "invented bundle" })).rejects.toThrow("REGISTERED_TOOL_INPUT")
  expect(existsSync(f.output)).toBe(false)
  writeFileSync(f.output, "user's existing report")
  await expect(f.run()).rejects.toThrow()
  expect(readFileSync(f.output, "utf8")).toBe("user's existing report")
})

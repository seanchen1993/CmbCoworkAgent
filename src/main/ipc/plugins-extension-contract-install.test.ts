import { afterAll, beforeAll, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  EXTENSION_CONTRACT_API_VERSION,
  REQUIRED_BUSINESS_CHECKS_PROTOCOL
} from "../../shared/project-runtime"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "contract-install", getVersion: () => "0.0.0" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: {}
}))
vi.mock("../mcp/capability-service", () => ({ invalidateGlobalMcpCapabilityService: vi.fn() }))
vi.mock("../hooks/notifications", () => ({ notifyHooksChanged: vi.fn() }))
vi.mock("../mods/manager", () => ({ getModsManager: () => undefined }))
let root: string
let plugins: typeof import("./plugins")
let storage: typeof import("../storage")
const previous = process.env.CMB_COWORK_AGENT_HOME
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "extension-install-"))
  process.env.CMB_COWORK_AGENT_HOME = join(root, "data")
  plugins = await import("./plugins")
  storage = await import("../storage")
}, 30_000)
afterAll(() => {
  if (previous === undefined) delete process.env.CMB_COWORK_AGENT_HOME
  else process.env.CMB_COWORK_AGENT_HOME = previous
  rmSync(root, { recursive: true, force: true })
})
function fixture(name: string, protocol: string) {
  const path = join(root, name)
  mkdirSync(join(path, "skills/review"), { recursive: true })
  writeFileSync(join(path, "plugin.json"), JSON.stringify({ name, version: "1.0.0" }))
  writeFileSync(
    join(path, "skills/review/SKILL.md"),
    "---\nname: review\ndescription: Review\n---\nReview the document."
  )
  writeFileSync(
    join(path, "devclaw.project-runtime.json"),
    JSON.stringify({
      apiVersion: "devclaw.project-runtime/v2",
      runtime: {
        apiVersion: "devclaw.project-runtime/v1",
        plugin: { id: name, version: "1.0.0" },
        mode: "legacy",
        stateOwner: "plugin",
        stages: [],
        actions: [],
        artifacts: [],
        checks: [],
        environment: [],
        capabilities: {
          execution: true,
          conditionalTransition: false,
          idempotency: false,
          reconciliation: false,
          cancellation: true
        }
      },
      extensionContract: { apiVersion: EXTENSION_CONTRACT_API_VERSION, requires: [protocol] }
    })
  )
  return path
}
it("rejects a copied checked-export adapter name before the native install changes catalog", async () => {
  const path = fixture("invented-checked-producer", "devclaw.verified-artifacts/v1")
  const entry = join(path, "devclaw.project-runtime.json")
  const manifest = JSON.parse(readFileSync(entry, "utf8"))
  manifest.extensionContract.verifiedArtifacts = { artifactIds: ["quality"] }
  manifest.runtime.artifacts = [{ id: "verified-context", path: ".devclaw/handoffs/verified-context.json", required: true }]
  writeFileSync(entry, JSON.stringify(manifest))
  writeFileSync(join(path, "devclaw.stage-checks.json"), JSON.stringify({
    apiVersion: "devclaw.stage-check-adapter/v1", adapter: "autobiz-v1"
  }))
  const before = storage.getPlugins()
  await expect(plugins.inspectCompletePluginDirectory(path)).rejects.toThrow("ADAPTER_UNSUPPORTED")
  expect((await plugins.installPluginFromDir(path, "invented-checked-producer", "local")).success).toBe(false)
  expect(storage.getPlugins()).toEqual(before)
})
it("rejects unsupported mandatory semantics before installation mutates the catalog", async () => {
  const path = fixture("unsupported-contract", "future.protocol/v99")
  const before = storage.getPlugins()
  await expect(plugins.inspectCompletePluginDirectory(path)).rejects.toThrow("PROTOCOL_UNSUPPORTED")
  const result = await plugins.installPluginFromDir(
    path,
    "unsupported-contract",
    "local",
    undefined,
    "capabilities"
  )
  expect(result.success).toBe(false)
  expect(storage.getPlugins()).toEqual(before)
})
it("installs a supported v2 package using the original installer and keeps it disabled pending user choice", async () => {
  const path = fixture("supported-contract", REQUIRED_BUSINESS_CHECKS_PROTOCOL)
  await plugins.inspectCompletePluginDirectory(path)
  const result = await plugins.installPluginFromDir(
    path,
    "supported-contract",
    "local",
    undefined,
    "capabilities"
  )
  expect(result.error).toBeUndefined()
  expect(result).toMatchObject({ success: true, enabled: false })
  expect(storage.getPlugins().find((plugin) => plugin.id === result.pluginId)?.enabled).toBe(false)
})

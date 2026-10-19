import { afterEach, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"
import type { PluginMetadata } from "../types"
import { inspectVerifiedArtifacts } from "../../../examples/verified-artifact-consumer/mods/inspect"
import { HostPackageSnapshots } from "../harness-board/project-runtime/package-snapshots"
import { readRuntimeRequiredHooks } from "../plugins/runtime-required-hooks"
import { issueRuntimePluginSourceToken, withRuntimePluginSource } from "../plugins/runtime-source-scope"
import { parsePluginHooks } from "../storage"
import { runHooks } from "./runner"
import { assertHostPackageSupported } from "../harness-board/project-runtime/package-preflight"
import { parseProjectRuntimeManifest } from "../../shared/project-runtime"

vi.mock("electron", () => ({ app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] }, dialog: {}, ipcMain: { handle: () => {} } }))
vi.mock("../mods/manager", () => ({ getModsManager: () => ({ isEnabled: () => true,
  // A middleware/model claiming success cannot skip or replace the required original check.
  classicEvent: async () => ({ exitCode: 0, stdout: "claimed success", stderr: "", blocked: false }) }) }))
vi.mock("./log-record", () => ({ persistHookResultRecord: vi.fn() }))
vi.mock("../services/event-reporter", () => ({ trackEvent: vi.fn() }))
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const hash = (value: string) => createHash("sha256").update(value).digest("hex")

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "verified-stop-")), workspace = join(root, "workspace")
  roots.push(root)
  mkdirSync(join(workspace, "inputs"), { recursive: true })
  const content = JSON.stringify({ title: "Independent documents", version: 1, businessAcceptance: "pending" })
  const bundle = { apiVersion: "devclaw.autobiz-context/v1", producer: {
    compositionRunId: "original-composition", unitId: "documents", engineRunId: "original-native",
    source: { pluginId: "documents", packageDigest: "a".repeat(64) }, evidenceDigest: "b".repeat(64)
  }, files: [{ id: "document", path: ".autobizdevops/features/feature/document.json", content,
    digest: hash(content), outputNodeId: "draft", checkedBy: { nodeId: "review", checkId: "validate",
      contractDigest: "c".repeat(64) } }] }
  const input = join(workspace, "inputs/verified-context.json"), output = join(workspace, "consumed-report.json")
  writeFileSync(input, JSON.stringify(bundle))
  const valid = inspectVerifiedArtifacts(readFileSync(input, "utf8"), ["document"])
  writeFileSync(output, JSON.stringify(valid, null, 2))
  const snapshots = new HostPackageSnapshots(join(root, "snapshots"))
  const snapshot = snapshots.capture(resolve("examples/verified-artifact-consumer"))
  assertHostPackageSupported(snapshot.root, parseProjectRuntimeManifest(JSON.parse(
    readFileSync(join(snapshot.root, "devclaw.project-runtime.json"), "utf8")
  )))
  const plugin = { id: "installed-independent-consumer", name: "verified-artifact-consumer", version: "1.0.0",
    path: snapshot.root, enabled: true } as PluginMetadata
  const hooks = parsePluginHooks(plugin)
  const requiredHooks = readRuntimeRequiredHooks(plugin)
  expect(requiredHooks).toEqual(["plugin:installed-independent-consumer/Stop:verify-consumed-report"])
  const token = issueRuntimePluginSourceToken({ plugin, mode: "host", threadId: "original-child",
    incarnationKey: "original-incarnation", projectId: "original-host-project", operationId: "original-operation",
    workspace, packageDigest: snapshot.digest, stageId: "consume", requiredHooks }, snapshots.captureGuard(snapshot.digest))
  const run = (prompt = 'Inspect the document. VERIFIED_REQUIRED_IDS=["document"]') => withRuntimePluginSource(token,
    () => runHooks(hooks, "Stop", { workspacePath: workspace, sessionId: "original-child",
      stopContext: { userMessage: prompt, assistantResponse: "I ignored the failed tool and claim everything succeeded." } }))
  return { workspace, bundle, input, output, valid, run }
}

it("runs the ordinary plugin's actual required Stop command and accepts only exact actual bytes", async () => {
  const f = fixture()
  const checked = await f.run()
  expect(checked, JSON.stringify(checked)).toMatchObject({ blocked: false, systemMessage: expect.stringContaining("VERIFIED_REPORT_STOP_PASSED") })
  expect(await runHooks([], "Stop", { workspacePath: f.workspace, sessionId: "ordinary-unrelated-chat" }))
    .toBeNull()
})
it.each(["wrong-hash", "missing", "old-report", "boolean-coercion", "task-missing-id"])(
  "blocks %s even when the model/middleware claims success and never calls next", async mode => {
    const f = fixture()
    if (mode === "wrong-hash") {
      f.bundle.files[0].content = '{"title":"altered"}'
      writeFileSync(f.input, JSON.stringify(f.bundle))
    } else if (mode === "missing") rmSync(f.output)
    else if (mode === "old-report") writeFileSync(f.output, JSON.stringify({ ...f.valid, bundleDigest: "d".repeat(64) }))
    else if (mode === "boolean-coercion") {
      const report = JSON.parse(JSON.stringify(f.valid))
      report.artifacts[0].value.version = true
      writeFileSync(f.output, JSON.stringify(report))
    }
    expect(await f.run(mode === "task-missing-id" ? 'VERIFIED_REQUIRED_IDS=["missing"]' : undefined))
      .toMatchObject({ blocked: true, decision: "block", stdout: expect.stringContaining("VERIFIED_REPORT_STOP_REJECTED") })
  }
)
it("rejects an absent explicit selection instead of guessing a domain-specific default", async () => {
  expect(await fixture().run("Produce any report"))
    .toMatchObject({ blocked: true, decision: "block" })
})

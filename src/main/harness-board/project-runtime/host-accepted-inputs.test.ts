import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { HostProjectService } from "./host-service"
import { HostPackageSnapshots } from "./package-snapshots"
import { HostProjectStore } from "./host-store"
import { hostProjectFixture } from "./host-fixtures.test-helper"

const cleanup: Array<() => void> = []
afterEach(() => cleanup.splice(0).reverse().forEach((close) => close()))

async function fixture(revision = false) {
  const root = mkdtempSync(join(tmpdir(), "accepted-project-inputs-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, "workspace"), plugin = join(root, "plugin")
  mkdirSync(workspace)
  mkdirSync(plugin)
  const manifest = hostProjectFixture(workspace).manifest
  manifest.artifacts = [
    { id: "baseline", path: "baseline.txt", required: true },
    { id: "result", path: "result.txt", required: true }
  ]
  manifest.checks = manifest.artifacts.map((artifact) => ({
    id: artifact.id + "-exists", artifactId: artifact.id, kind: "file-exists", sideEffect: "read"
  }))
  manifest.stages = (revision ? ["baseline", "revise", "consume"] : ["baseline", "consume"]).map((id) => {
    const artifact = id === "consume" ? "result" : "baseline"
    return { id, title: id, skill: `skills/${id}/SKILL.md`, actionIds: [],
      artifactIds: [artifact], checkIds: [artifact + "-exists"], approval: "none",
      ...(id === "baseline" ? { resultApproval: "human" as const } : {}) }
  })
  writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ name: "docs", version: "1.0.0" }))
  writeFileSync(join(plugin, "devclaw.project-runtime.json"), JSON.stringify(manifest))
  for (const stage of manifest.stages) {
    mkdirSync(join(plugin, "skills", stage.id), { recursive: true })
    writeFileSync(join(plugin, stage.skill!), "Perform the declared stage.")
  }
  const store = new HostProjectStore(join(root, "host.sqlite"))
  cleanup.push(() => store.close())
  const service = new HostProjectService(store, new HostPackageSnapshots(join(root, "snapshots")), {
    resolveInstalledPlugin: async () => ({ installedPluginId: "docs", root: plugin,
      packageId: "docs", packageVersion: "1.0.0", enabled: true }),
    authorize: async () => {},
    executeSkill: async (context) => {
      const stage = context.operation.stageId
      writeFileSync(join(workspace, stage === "consume" ? "result.txt" : "baseline.txt"),
        stage === "revise" ? "explicitly revised baseline" : "accepted original baseline")
      return "succeeded"
    }
  })
  await service.localCreate({ projectId: "docs", name: "Docs", goal: "Preserve the agreed requirements",
    workspace, installedPluginId: "docs" })
  const prepare = () => {
    const state = service.get("docs")!
    return service.prepare({ projectId: "docs", expectedVersion: state.version,
      idempotencyKey: "stage-" + state.stageIndex })
  }
  const complete = async () => {
    const operation = prepare()
    const result = await service.start(operation.operationId)
    expect(result.status).toBe("succeeded")
    if (operation.stageId === "baseline") service.decideResultApproval(operation.operationId, {
      ...service.resultReview(operation.operationId), decision: "approved", actorId: "desktop-user"
    })
    service.transition(operation.operationId)
  }
  return { service, workspace, prepare, complete }
}

describe("accepted Host input provenance", () => {
  it("rejects an accepted upstream edit before a new downstream operation can adopt its bytes", async () => {
    const f = await fixture()
    await f.complete()
    writeFileSync(join(f.workspace, "baseline.txt"), "silently removed a requirement")
    expect(() => f.prepare()).toThrow("EVIDENCE_STALE")
    writeFileSync(join(f.workspace, "baseline.txt"), "accepted original baseline")
    expect(f.prepare().status).toBe("prepared")
  })

  it("permits declared output revision and checks its newest accepted producer downstream", async () => {
    const f = await fixture(true)
    await f.complete()
    // This stage explicitly owns and checks the same path, so it may revise the output.
    writeFileSync(join(f.workspace, "baseline.txt"), "revision in progress")
    await f.complete()
    expect(f.prepare().status).toBe("prepared")
  })

  it("rejects edits to the latest accepted revision as well as the initial producer", async () => {
    const f = await fixture(true)
    await f.complete()
    await f.complete()
    writeFileSync(join(f.workspace, "baseline.txt"), "accepted original baseline")
    expect(() => f.prepare()).toThrow("EVIDENCE_STALE")
  })
})

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it } from "vitest"
import {
  DEPLOY_UNIT_V2_FILE,
  FEATURE_V2_FILE,
  initializeHarnessConfigV2,
  parseFeatureV2
} from "./config-v2"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "feature-config-v2-"))
  roots.push(root)
  const mapping = {
    deployUnitIdMapping: "stable-id",
    deployUnitId: "backend",
    localRepoPath: "/global/D",
    description: "backend description"
  }
  const feature = {
    projectId: "p",
    featureId: "f",
    selectedDeployUnitMappings: [{ ...mapping, localRepoPath: "/feature/C" }],
    sessionContextInjectionSource: "cmbdevclaw",
    imManagementEnabled: true,
    createdAt: "2026-09-01 10:00:00"
  }
  const globalText = JSON.stringify({ version: 1, mappings: [mapping] }, null, 2)
  const featureText = JSON.stringify({ version: 1, bindings: [feature] }, null, 2)
  await writeFile(join(root, "harness-deployUnitId-mapping.json"), globalText)
  await writeFile(join(root, "harness-board-features.json"), featureText)
  return { root, feature, globalText, featureText }
}
async function read(root: string, name: string) {
  return JSON.parse(await readFile(join(root, name), "utf8"))
}

describe("independent v2 configuration initialization", () => {
  it("preserves v1 bytes, stable mapping IDs, feature snapshots and missing workspace", async () => {
    const { root, feature, globalText, featureText } = await fixture()
    await initializeHarnessConfigV2(root)
    expect(await readFile(join(root, "harness-deployUnitId-mapping.json"), "utf8")).toBe(globalText)
    expect(await readFile(join(root, "harness-board-features.json"), "utf8")).toBe(featureText)
    expect(await read(root, FEATURE_V2_FILE)).toEqual({ version: 2, bindings: [feature] })
    const global = await read(root, DEPLOY_UNIT_V2_FILE)
    expect(global.mappings[0]).toEqual({
      deployUnitIdMapping: "stable-id",
      deployUnitId: "backend",
      description: "backend description",
      repositoryPaths: [{ pathId: expect.any(String), localRepoPath: "/global/D" }]
    })
    const pathId = global.mappings[0].repositoryPaths[0].pathId
    await initializeHarnessConfigV2(root)
    expect((await read(root, DEPLOY_UNIT_V2_FILE)).mappings[0].repositoryPaths[0].pathId).toBe(
      pathId
    )
  })
  it("never imports v1 again when v2 is deliberately empty", async () => {
    const { root } = await fixture()
    await writeFile(join(root, DEPLOY_UNIT_V2_FILE), JSON.stringify({ version: 2, mappings: [] }))
    await writeFile(join(root, FEATURE_V2_FILE), JSON.stringify({ version: 2, bindings: [] }))
    await writeFile(join(root, "harness-board-features.json"), "invalid legacy")
    await initializeHarnessConfigV2(root)
    expect(await read(root, FEATURE_V2_FILE)).toEqual({ version: 2, bindings: [] })
    expect(await read(root, DEPLOY_UNIT_V2_FILE)).toEqual({ version: 2, mappings: [] })
  })
  it.each(["", "null", "{invalid", '{"version":3,"bindings":[]}'])(
    "does not fall back from invalid existing v2: %s",
    async (text) => {
      const { root } = await fixture()
      await writeFile(join(root, FEATURE_V2_FILE), text)
      await expect(initializeHarnessConfigV2(root)).rejects.toThrow()
      expect(await readFile(join(root, FEATURE_V2_FILE), "utf8")).toBe(text)
    }
  )
  it("resumes only the missing store after a conversion failure", async () => {
    const { root, featureText } = await fixture()
    await writeFile(join(root, "harness-board-features.json"), "invalid")
    await expect(initializeHarnessConfigV2(root)).rejects.toThrow()
    const global = await readFile(join(root, DEPLOY_UNIT_V2_FILE), "utf8")
    await expect(readFile(join(root, FEATURE_V2_FILE))).rejects.toMatchObject({ code: "ENOENT" })
    await writeFile(join(root, "harness-board-features.json"), featureText)
    await initializeHarnessConfigV2(root)
    expect(await readFile(join(root, DEPLOY_UNIT_V2_FILE), "utf8")).toBe(global)
  })
})

describe("feature binding parsing", () => {
  it("retains snapshots, workspace references and legacy default source", async () => {
    const { feature } = await fixture()
    const result = parseFeatureV2({
      version: 2,
      bindings: [
        {
          ...feature,
          sessionContextInjectionSource: undefined,
          sessionWorkspace: { source: "deployUnit", deployUnitId: "backend" }
        }
      ]
    })
    expect(result.bindings[0]).toMatchObject({
      ...feature,
      sessionWorkspace: { source: "deployUnit", deployUnitId: "backend" }
    })
  })
  it.each([
    { source: "directory", path: 123 },
    { source: "deployUnit", deployUnitId: "missing" },
    { source: "unknown", path: "/valid" }
  ])("rejects invalid workspace before normalization: %j", async (sessionWorkspace) => {
    const { feature } = await fixture()
    expect(() =>
      parseFeatureV2({ version: 2, bindings: [{ ...feature, sessionWorkspace }] })
    ).toThrow()
  })
})

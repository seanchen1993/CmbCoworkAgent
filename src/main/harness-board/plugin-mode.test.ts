import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { createProjectTemplate } from "../mods/devtools/project-template"
import { BUSINESS_MOD_MANIFEST } from "../../shared/business-mods"
import { isSkillVisibleForProjectMode } from "../../shared/skill-visibility"
import { isLegacyProjectModePluginRoot, isProjectModePluginRoot } from "./plugin-mode"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "project-mode-boundary-"))
  roots.push(root)
  await mkdir(join(root, "board_core"))
  await writeFile(join(root, "board_core/board_config.json"), "ordinary resource, not board JSON")
  return root
}

it("keeps native Host stage Skills project-scoped without publishing an old board UI entry", async () => {
  const root = await fixture()
  const source = createProjectTemplate({ packageId: "native-host", name: "Host" })
  await writeFile(
    join(root, "devclaw.project-runtime.json"),
    source.files.find((file) => file.path === "devclaw.project-runtime.json")!.text
  )
  expect(isProjectModePluginRoot(root)).toBe(true)
  expect(isLegacyProjectModePluginRoot(root)).toBe(false)
  expect(
    isSkillVisibleForProjectMode(
      {
        pluginId: "host",
        isProjectModePlugin: isProjectModePluginRoot(root)
      },
      { projectMode: true, boundPluginId: "another-project-plugin" }
    )
  ).toBe(false)
})

it("classifies an unassembled Host catalog without interpreting its same-named board resource", async () => {
  const root = await fixture()
  await mkdir(join(root, "mods/business"), { recursive: true })
  await writeFile(
    join(root, BUSINESS_MOD_MANIFEST),
    JSON.stringify({
      apiVersion: "devclaw.business-mods/v1",
      kind: "catalog",
      kernel: {
        id: "independent.kernel",
        version: "1.0.0",
        resources: [],
        runtime: { adapter: "host-linear-v1" }
      },
      modules: [
        {
          id: "vendor.intake",
          title: "Intake",
          node: { id: "vendor.intake", skill: "vendor-intake", order: 10 },
          skill: { entry: "skills/vendor-intake/SKILL.md", resources: [] },
          resources: [],
          dependencies: { required: [], advisory: [] },
          checks: { validators: [], guards: [] },
          host: {
            stage: {
              actionIds: [],
              artifactIds: ["vendor.dossier"],
              checkIds: ["vendor.exists"],
              approval: "none"
            },
            actions: [],
            artifacts: [{ id: "vendor.dossier", path: "dossier.json", required: true }],
            checks: [
              {
                id: "vendor.exists",
                kind: "file-exists",
                artifactId: "vendor.dossier",
                sideEffect: "read"
              }
            ],
            environment: []
          }
        }
      ]
    })
  )
  expect(isProjectModePluginRoot(root)).toBe(true)
  expect(isLegacyProjectModePluginRoot(root)).toBe(false)
})

it("preserves the runtime-less historical board flag and fails closed on malformed runtime metadata", async () => {
  const root = await fixture()
  expect(isProjectModePluginRoot(root)).toBe(true)
  expect(isLegacyProjectModePluginRoot(root)).toBe(true)
  await writeFile(join(root, "devclaw.project-runtime.json"), "{")
  expect(isProjectModePluginRoot(root)).toBe(false)
  expect(isLegacyProjectModePluginRoot(root)).toBe(false)
})

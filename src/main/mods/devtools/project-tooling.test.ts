import AdmZip from "adm-zip"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  initProjectPlugin,
  packProjectPlugin,
  prepareProjectDevelopment,
  testProjectPlugin
} from "./project-tooling"
import { doctorProjectPlugin, inspectProjectSource } from "./project-doctor"
import { runProjectCli } from "./project-cli"
import { createProjectTemplate } from "./project-template"
import { bindProjectPublicAction } from "./project-action-reuse"
import { readPluginManifest, getPluginSkillSearchSources } from "../../plugins/manifest"
import { discoverSkills } from "../../skills/discovery"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "project-tooling-test-"))
  roots.push(root)
  const directory = join(root, "docs-plugin")
  await initProjectPlugin(directory, { packageId: "docs-plugin", name: "文档项目" })
  return { root, directory }
}

describe("lightweight project authoring", () => {
  it("generates a package recognized by the real installer metadata and skill discovery", async () => {
    const { directory } = await fixture()
    const result = readPluginManifest(directory)!
    expect(result.manifest.name).toBe("docs-plugin")
    const sources = getPluginSkillSearchSources(directory, result.manifest)
    expect(
      (
        await Promise.all(
          sources.map((source) => discoverSkills(source.sourceDir, source.maxDepth))
        )
      )
        .flat()
        .some((skill) => skill.name === "docs-plugin-draft")
    ).toBe(true)
    expect((await doctorProjectPlugin(directory)).valid).toBe(true)
    await expect(
      initProjectPlugin(directory, { packageId: "docs-plugin", name: "覆盖" })
    ).rejects.toThrow()
    expect(readPluginManifest(directory)?.manifest.description).toBe("文档项目")
  })

  it("runs missing, valid and invalid fixtures through production host validators", async () => {
    const { directory } = await fixture()
    const report = await testProjectPlugin(directory)
    expect(report).toMatchObject({ valid: true, scope: "isolated-host-artifact-checks" })
    if (!("cases" in report)) throw Error("Missing contract results")
    expect(report.cases.map((item) => item.actual)).toEqual([
      "failed",
      "passed",
      "failed",
      "passed"
    ])
    const contractPath = join(directory, "tests", "project-contract.json")
    const contract = JSON.parse(await readFile(contractPath, "utf8"))
    contract.cases[0].expected = "passed"
    await writeFile(contractPath, JSON.stringify(contract))
    expect((await testProjectPlugin(directory)).valid).toBe(false)
  })

  it("reports missing skills, unsupported schemas and package/install identity confusion", async () => {
    const { directory } = await fixture()
    const path = join(directory, "devclaw.project-runtime.json")
    const manifest = JSON.parse(await readFile(path, "utf8"))
    manifest.plugin.id = "incorrect-install-uuid"
    manifest.stages[0].skill = "skills/missing/SKILL.md"
    manifest.checks[1].schema.pattern = "secret-regex"
    await writeFile(path, JSON.stringify(manifest))
    const report = await doctorProjectPlugin(directory)
    expect(report.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "PROJECT_PLUGIN_IDENTITY",
        "PROJECT_SKILL_MISSING",
        "PROJECT_SCHEMA_UNSUPPORTED"
      ])
    )
  })

  it("packs an ordinary plugin ZIP, excludes credentials, and never overwrites an output", async () => {
    const { root, directory } = await fixture()
    await writeFile(join(directory, ".env"), "FAKE_PROJECT_SECRET=never-package-this")
    const output = join(root, "plugin.zip")
    const result = await packProjectPlugin(directory, output)
    const zip = new AdmZip(output)
    expect(zip.getEntry("plugin.json")).toBeTruthy()
    expect(zip.getEntry("skills/draft/SKILL.md")).toBeTruthy()
    expect(zip.getEntry(".env")).toBeNull()
    expect(result.excluded).toContain(".env")
    expect(
      zip.getEntries().some((entry) => entry.getData().toString().includes("FAKE_PROJECT_SECRET"))
    ).toBe(false)
    await expect(packProjectPlugin(directory, output)).rejects.toThrow()
  })

  it("preserves project capability declarations when preparing and packing a project", async () => {
    const { root, directory } = await fixture()
    const text = JSON.stringify({
      apiVersion: "devclaw.capabilities/v1",
      capabilities: [
        {
          id: "complete",
          title: "完整流程",
          kind: "flow",
          usage: "project",
          entry: "devclaw.project-runtime.json"
        }
      ]
    })
    await writeFile(join(directory, "devclaw.capabilities.json"), text)
    const output = join(root, "capabilities.zip")
    const result = await packProjectPlugin(directory, output)
    expect(result.excluded).not.toContain("devclaw.capabilities.json")
    expect(new AdmZip(output).getEntry("devclaw.capabilities.json")?.getData().toString()).toBe(
      text
    )
    const prepared = await prepareProjectDevelopment(directory, join(root, "preview"))
    expect(await readFile(join(prepared.packagePath, "devclaw.capabilities.json"), "utf8")).toBe(
      text
    )
    await writeFile(
      join(directory, "devclaw.capabilities.json"),
      JSON.stringify({ apiVersion: "invalid" })
    )
    expect((await doctorProjectPlugin(directory)).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "PROJECT_CAPABILITIES_INVALID" })])
    )
  })

  it("prepares isolated immutable development files without running or installing them", async () => {
    const { root, directory } = await fixture()
    const result = await prepareProjectDevelopment(directory, join(root, "preview"))
    const prior = await readFile(join(result.packagePath, "plugin.json"), "utf8")
    await writeFile(join(directory, "plugin.json"), "changed-source")
    expect(await readFile(join(result.packagePath, "plugin.json"), "utf8")).toBe(prior)
    expect(result.executed).toBe(false)
    expect(result.status).toBe("prepared")
  })

  it("connects project CLI commands and rejects unrecognized options", async () => {
    const { directory } = await fixture()
    expect(await runProjectCli(["doctor", directory])).toMatchObject({ handled: true, exitCode: 0 })
    expect(await runProjectCli(["test", directory])).toMatchObject({ handled: true, exitCode: 0 })
    expect(await runProjectCli(["check", directory])).toEqual({ handled: false, exitCode: 0 })
    await expect(runProjectCli(["doctor", directory, "--execute", "true"])).rejects.toThrow()
    await expect(runProjectCli(["pack", directory])).rejects.toThrow()
  })

  it("locks real public action identity and schema-checked inputs without inventing dependencies", () => {
    const source = createProjectTemplate({ packageId: "consumer", name: "复用" })
    const action = {
      pluginId: "installed-provider-id",
      plugin: "public-provider",
      digest: "a".repeat(64),
      actionId: "format",
      command: "format",
      name: "Format",
      inputSchema: {
        type: "object",
        required: ["text"],
        properties: { text: { type: "string" } },
        additionalProperties: false
      },
      outputSchema: { type: "object", properties: { text: { type: "string" } } }
    }
    expect(() =>
      bindProjectPublicAction({
        source,
        stageId: "draft",
        localActionId: "format",
        action,
        constants: {}
      })
    ).toThrow()
    const result = bindProjectPublicAction({
      source,
      stageId: "draft",
      localActionId: "format",
      action,
      constants: { text: "输入" }
    })
    const lock = JSON.parse(
      result.files.find((file) => file.path === "devclaw.project-actions.lock.json")!.text
    )
    expect(lock.bindings[0].ref.pluginId).toBe(action.pluginId)
    expect(
      inspectProjectSource(result).report.diagnostics.some(
        (item) => item.code === "PROJECT_ACTION_DEPENDENCY_MISSING"
      )
    ).toBe(true)
    expect(source.files.some((file) => file.path === "devclaw.project-actions.lock.json")).toBe(
      false
    )
  })
})

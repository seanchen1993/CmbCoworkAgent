import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  compileProjectHarness,
  HARNESS_SOURCE_PATH,
  type HarnessDefinition
} from "./project-harness"
import { createProjectTemplate } from "./project-template"
import { createAuthoringSourceBundle, type AuthoringSourceBundle } from "./authoring-bundle"
import { inspectProjectSource } from "./project-doctor"
import { testProjectSource } from "./project-contract"
import { runProjectCli } from "./project-cli"
import { bindProjectPublicAction } from "./project-action-reuse"
import { HostPackageSnapshots } from "../../harness-board/project-runtime/package-snapshots"
import { assertHostPackageSupported } from "../../harness-board/project-runtime/package-preflight"
import { getPluginSkillSearchSources, readPluginManifest } from "../../plugins/manifest"
import { discoverSkillsSync } from "../../skills/discovery"
import { HostProjectStore } from "../../harness-board/project-runtime/host-store"
import { HostProjectService } from "../../harness-board/project-runtime/host-service"
import { validateHostStage } from "../../harness-board/project-runtime/host-validators"
import {
  wrapProjectRuntimeManifest,
  CONTEXT_HANDOFF_PROTOCOL
} from "../../../shared/project-runtime"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const source = () =>
  createProjectTemplate({ packageId: "harness-demo", name: "示例", template: "harness-lite" })
function edit(bundle: AuthoringSourceBundle, change: (value: HarnessDefinition) => void) {
  return createAuthoringSourceBundle(
    bundle.files.map((file) => {
      if (file.path !== HARNESS_SOURCE_PATH) return file
      const value = JSON.parse(file.text)
      change(value)
      return { ...file, text: JSON.stringify(value) }
    })
  )
}

describe("declarative Harness authoring", () => {
  it("compares compiled runtime semantics while preserving an independent extension envelope", () => {
    const base = source()
    const extended = createAuthoringSourceBundle(
      base.files.map((file) =>
        file.path === "devclaw.project-runtime.json"
          ? {
              ...file,
              text: JSON.stringify(
                wrapProjectRuntimeManifest(JSON.parse(file.text), {
                  apiVersion: "devclaw.extension-contract/v1",
                  requires: [CONTEXT_HANDOFF_PROTOCOL],
                  context: {
                    sourceAccess: "read-only",
                    mutableData: "host",
                    configuration: "host-resolved",
                    knowledge: { required: false },
                    provider: { entry: "hooks/provider.py", operations: ["session-context"] }
                  }
                })
              )
            }
          : file
      )
    )
    expect(inspectProjectSource(extended).report.diagnostics).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "PROJECT_HARNESS_STALE" })])
    )
    const stale = edit(extended, (harness) => {
      harness.nodes[0].title = "Actual node change"
    })
    expect(inspectProjectSource(stale).report.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "PROJECT_HARNESS_STALE" })])
    )
  })
  it("requires both review outputs and rejects changing the preserved draft", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-review-copy-"))
    roots.push(root)
    const plugin = join(root, "plugin"),
      workspace = join(root, "workspace")
    await mkdir(workspace)
    const bundle = source()
    const skill = bundle.files.find((file) => file.path === "skills/review/SKILL.md")!.text
    expect(skill).toContain("不修改前序草稿")
    expect(skill).toContain("reviewed.md")
    for (const file of bundle.files) {
      await mkdir(dirname(join(plugin, file.path)), { recursive: true })
      await writeFile(join(plugin, file.path), file.text)
    }
    const store = new HostProjectStore(join(root, "projects.sqlite"))
    let executions = 0
    const service = new HostProjectService(
      store,
      new HostPackageSnapshots(join(root, "snapshots")),
      {
        resolveInstalledPlugin: async () => ({
          installedPluginId: "harness-test",
          root: plugin,
          packageId: "harness-demo",
          packageVersion: "0.1.0",
          enabled: true
        }),
        authorize: async () => {},
        executeSkill: async () => {
          executions++
          await writeFile(join(workspace, "draft.md"), "original draft")
          return "succeeded"
        }
      }
    )
    try {
      await service.localCreate({
        projectId: "review-copy",
        name: "Review",
        workspace,
        installedPluginId: "harness-test",
        goal: "Review without rewriting prior input"
      })
      const draft = service.prepare({
        projectId: "review-copy",
        expectedVersion: 1,
        idempotencyKey: "draft"
      })
      expect((await service.start(draft.operationId)).status).toBe("succeeded")
      const project = service.transition(draft.operationId)
      const review = service.prepare({
        projectId: "review-copy",
        expectedVersion: 2,
        idempotencyKey: "review"
      })
      service.approve(review.operationId, {
        expectedVersion: 2,
        inputFingerprint: review.inputFingerprint,
        decision: "approved",
        actorId: "user"
      })
      await writeFile(join(workspace, "review.json"), '{"summary":"checked","checked":true}')
      expect(validateHostStage(project, review).map((receipt) => receipt.result)).toEqual([
        "passed",
        "failed"
      ])
      await rm(join(workspace, "review.json"))
      await writeFile(join(workspace, "reviewed.md"), "reviewed copy")
      expect(validateHostStage(project, review).map((receipt) => receipt.result)).toEqual([
        "failed",
        "passed"
      ])
      await writeFile(join(workspace, "review.json"), '{"summary":"checked","checked":true}')
      expect(
        validateHostStage(project, review).every((receipt) => receipt.result === "passed")
      ).toBe(true)
      await writeFile(join(workspace, "draft.md"), "changed after approval")
      await expect(service.start(review.operationId)).rejects.toThrow("INPUT_CHANGED")
      expect(store.getOperation(review.operationId)?.status).toBe("failed")
      expect(executions).toBe(1)
      expect(await readFile(join(workspace, "reviewed.md"), "utf8")).toBe("reviewed copy")
    } finally {
      store.close()
    }
  })
  it.each(["harness-lite", "harness-fullstack", "harness-data"] as const)(
    "%s compiles into production manifest and checks missing and passing real files",
    async (template) => {
      const bundle = createProjectTemplate({ packageId: "harness-demo", name: "示例", template })
      const { report, manifest } = inspectProjectSource(bundle)
      expect(report.valid).toBe(true)
      const result = await testProjectSource(bundle, manifest!)
      expect(result.valid).toBe(true)
      expect(result.cases.filter((item) => item.actual === "failed")).toHaveLength(
        manifest!.artifacts.length
      )
      expect(result.cases.filter((item) => item.actual === "passed")).toHaveLength(
        manifest!.stages.length
      )
      expect(manifest!.stages.at(-1)?.approval).toBe("human")
      expect(manifest!.actions).toEqual([])
      const root = await mkdtemp(join(tmpdir(), "harness-package-test-"))
      roots.push(root)
      const directory = join(root, "source")
      for (const file of bundle.files) {
        const path = join(directory, file.path)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, file.text)
      }
      const snapshots = new HostPackageSnapshots(join(root, "snapshots"))
      const snapshot = snapshots.capture(directory)
      expect(snapshots.read(snapshot.digest).manifest).toEqual(manifest)
      expect(assertHostPackageSupported(snapshot.root, snapshot.manifest).name).toBe("harness-demo")
      const metadata = readPluginManifest(snapshot.root)!.manifest
      const skills = getPluginSkillSearchSources(snapshot.root, metadata).flatMap((source) =>
        discoverSkillsSync(source.sourceDir, source.maxDepth)
      )
      expect(skills).toHaveLength(manifest!.stages.length)
    }
  )

  it.each(["../escape", "/absolute", "C:/escape", "dir\\escape", "NUL", "file./data"])(
    "rejects unsafe artifact path %s",
    (path) => {
      expect(() =>
        compileProjectHarness(
          edit(source(), (value) => {
            value.nodes[0].artifacts[0].path = path
          })
        )
      ).toThrow()
    }
  )

  it("rejects duplicate nodes, artifacts, path aliases, unknown executable fields and missing skills", () => {
    const base = source()
    const mutations: Array<(value: HarnessDefinition) => void> = [
      (value) => {
        value.nodes[1].id = value.nodes[0].id
      },
      (value) => {
        value.nodes[1].artifacts[0].id = value.nodes[0].artifacts[0].id
      },
      (value) => {
        value.nodes[1].artifacts[0].path = "DRAFT.MD"
      },
      (value) => {
        value.nodes[1].artifacts[0].path = "draft.md/child.json"
      },
      (value) => {
        value.nodes[0].skill = "skills/absent/SKILL.md"
      },
      (value) => {
        Object.assign(value.nodes[0], { command: "execute-me" })
      },
      (value) => {
        value.nodes[1].artifacts[0].schema = { type: "object", pattern: "unsupported" }
      },
      (value) => {
        value.nodes[1].artifacts[0].example = '{"checked":false}'
      }
    ]
    for (const mutate of mutations)
      expect(() => compileProjectHarness(edit(base, mutate))).toThrow()
  })

  it("detects stale compiled manifests and explicitly recompiles to a new CLI directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "harness-cli-test-"))
    roots.push(root)
    const directory = join(root, "source")
    expect(
      await runProjectCli(["init", directory, "--id", "demo", "--template", "harness-data"])
    ).toMatchObject({ handled: true, exitCode: 0 })
    const harnessPath = join(directory, HARNESS_SOURCE_PATH)
    const definition = JSON.parse(await readFile(harnessPath, "utf8"))
    definition.nodes[0].title = "新的数据口径"
    await writeFile(harnessPath, JSON.stringify(definition))
    expect(await runProjectCli(["doctor", directory])).toMatchObject({
      exitCode: 1,
      result: {
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: "PROJECT_HARNESS_STALE" })
        ])
      }
    })
    const output = join(root, "compiled")
    expect(await runProjectCli(["compile", directory, "--out", output])).toMatchObject({
      handled: true,
      exitCode: 0,
      result: { tests: { valid: true }, executed: false }
    })
    expect(await runProjectCli(["doctor", output])).toMatchObject({ exitCode: 0 })
    expect(await runProjectCli(["test", output])).toMatchObject({ exitCode: 0 })
    await expect(runProjectCli(["compile", directory, "--out", directory])).rejects.toThrow()
    expect(
      JSON.parse(await readFile(join(directory, "devclaw.project-runtime.json"), "utf8")).stages[0]
        .title
    ).toBe("数据口径")
  })

  it("retains public action locks and rejects removing their bound node", () => {
    const action = {
      pluginId: "installed-provider-id",
      plugin: "public-provider",
      digest: "a".repeat(64),
      actionId: "format",
      command: "format",
      name: "Format",
      inputSchema: { type: "object" }
    }
    const bound = bindProjectPublicAction({
      source: source(),
      stageId: "draft",
      localActionId: "format",
      action,
      constants: {}
    })
    const compiled = compileProjectHarness(
      edit(bound, (value) => {
        value.nodes[0].title = "新标题"
      })
    )
    expect(inspectProjectSource(compiled, [], [action]).report.valid).toBe(true)
    expect(
      compiled.files.find((file) => file.path === "devclaw.project-actions.lock.json")
    ).toEqual(bound.files.find((file) => file.path === "devclaw.project-actions.lock.json"))
    expect(inspectProjectSource(compiled, [], [action]).manifest!.stages[0].actionIds).toEqual([
      "format"
    ])
    const updated = compileProjectHarness(
      createAuthoringSourceBundle(
        bound.files.map((file) => {
          if (file.path !== "plugin.json") return file
          return { ...file, text: JSON.stringify({ ...JSON.parse(file.text), version: "0.2.0" }) }
        })
      )
    )
    const updatedReport = inspectProjectSource(updated, [], [action])
    expect(updatedReport.report.valid).toBe(true)
    expect(updatedReport.manifest!.plugin.version).toBe("0.2.0")
    expect(updatedReport.manifest!.stages[0].actionIds).toEqual(["format"])
    expect(updated.files.find((file) => file.path === "devclaw.project-actions.lock.json")).toEqual(
      bound.files.find((file) => file.path === "devclaw.project-actions.lock.json")
    )
    expect(() =>
      compileProjectHarness(
        createAuthoringSourceBundle(
          bound.files.map((file) => {
            if (file.path !== "plugin.json") return file
            return {
              ...file,
              text: JSON.stringify({ ...JSON.parse(file.text), name: "other-package" })
            }
          })
        )
      )
    ).toThrow("PROJECT_HARNESS_IDENTITY_CHANGED")
    expect(() =>
      compileProjectHarness(
        edit(bound, (value) => {
          value.nodes.shift()
        })
      )
    ).toThrow("PROJECT_HARNESS_BOUND_NODE_REMOVED")
  })
})

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { expect, it } from "vitest"
import { CreatorBusinessService } from "./creator-business"
import { businessCreatorScopeKey } from "./creator-business-draft"
import { BusinessModAssemblyService } from "../../plugins/business-mod-assembly-service"
import { parseBusinessModCatalog } from "../../plugins/business-mod-manifest"
import { parseProjectRuntimeManifest } from "../../../shared/project-runtime"
import { assertHostPackageSupported } from "../../harness-board/project-runtime/package-preflight"
import type { PluginMetadata } from "../../types"

it("edits a Skill while retaining large original knowledge and validator resources outside the author document budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "creator-large-retained-"))
  let service: CreatorBusinessService | undefined
  try {
    const original = join(directory, "original")
    await cp(resolve("examples/vendor-onboarding-mods"), original, { recursive: true })
    const manifestPath = join(original, "mods/business/manifest.json")
    const catalog = parseBusinessModCatalog(JSON.parse(await readFile(manifestPath, "utf8")))
    const knowledgePath = "skills/vendor-dossier/large-reference.md"
    const validatorPath = "skills/vendor-dossier/retained-validator.py"
    const resources = {
      [knowledgePath]: "Required knowledge and context.\n".repeat(6000),
      [validatorPath]: "# Required original validator implementation.\n".repeat(6500)
    }
    catalog.modules[0].skill.resources.push(knowledgePath, validatorPath)
    for (const [path, text] of Object.entries(resources)) {
      await mkdir(dirname(join(original, path)), { recursive: true })
      await writeFile(join(original, path), text)
    }
    await writeFile(manifestPath, JSON.stringify(catalog))
    expect(Buffer.byteLength(resources[validatorPath])).toBeGreaterThan(256 * 1024)
    expect(
      Object.values(resources).reduce((sum, text) => sum + Buffer.byteLength(text), 0)
    ).toBeGreaterThan(400 * 1024)
    const plugins = [
      {
        id: "independent-source",
        name: "vendor-onboarding-mods",
        version: "1.0.0",
        path: original,
        enabled: true,
        updatedAt: "unchanged"
      }
    ] as PluginMetadata[]
    const values = new Map<string, string>()
    const assembly = new BusinessModAssemblyService(join(directory, "assembly"), {
      plugins: () => plugins,
      validatePackage: async (root) => {
        const runtime = parseProjectRuntimeManifest(
          JSON.parse(await readFile(join(root, "devclaw.project-runtime.json"), "utf8"))
        )
        assertHostPackageSupported(root, runtime)
      },
      install: async () => {
        throw Error("NO_INSTALL_AUTHORIZATION")
      },
      invalidate: () => {}
    })
    const scope = {
      workspace: directory,
      threadId: "large-retained-workflow",
      incarnation: { token: "native-source-generation", legacyCreatedAt: 1 }
    }
    let notifications = 0
    const context = () => ({
      scope,
      assertCurrent() {
        expect(scope.threadId).toBe("large-retained-workflow")
      }
    })
    service = new CreatorBusinessService({
      root: join(directory, "drafts"),
      assembly,
      plugins: () => plugins,
      settings: {
        getSetting: (key, fallback = "") => values.get(key) ?? fallback,
        compareAndSetSetting: (key, before, value) => {
          if (values.get(key) !== before) return false
          values.set(key, value)
          return true
        }
      },
      context,
      readContext: context,
      busy: () => false,
      changed() {
        notifications++
      }
    })
    const source = await service.inspect(scope.threadId, plugins[0].id)
    const workflow = await service.readWorkflow(scope.threadId, source.id)
    const skill = { entry: "skills/vendor-dossier-improved/SKILL.md", resources: [] }
    const transformed = await service.transformWorkflow(scope.threadId, {
      id: "large-skill-edit",
      name: "改进资料技能",
      revision: 0,
      inspectionId: source.id,
      sourceDigest: workflow.sourceDigest,
      expectedWorkflowDigest: workflow.digest,
      changes: [
        { kind: "replace_skill", id: "vendor.dossier", skillName: "vendor-dossier-improved", skill }
      ],
      files: [
        {
          path: skill.entry,
          text: "---\nname: vendor-dossier-improved\ndescription: Retain original rules and improve the dossier.\n---\nVENDOR_DOSSIER_IMPROVED. Read retained original policy and use every required original check.\n"
        }
      ]
    })
    const draft = service.read(scope.threadId, transformed.draft.id)
    // Original immutable package resources are not new author-supplied code. Keeping them
    // by exact source-bound references avoids increasing the 64KB/256KB authoring budgets.
    expect(draft.files.map((file) => file.path)).toEqual([skill.entry])
    expect(Buffer.byteLength(JSON.stringify(draft))).toBeLessThan(16 * 1024)
    const preview = await service.preview(scope.threadId, {
      name: "vendor-large-resource-variant",
      version: "1.0.0",
      sources: [{ inspectionId: source.id, modIds: ["vendor.decision"] }],
      drafts: [{ id: draft.id, revision: draft.revision, modIds: ["vendor.dossier"] }]
    })
    expect(preview.valid).toBe(true)
    for (const [path, bytes] of Object.entries(resources))
      expect(preview.files.find((file) => file.path === path)?.bytes).toBe(Buffer.byteLength(bytes))
    const review = await service.requestReview(
      scope.threadId,
      preview.previewId,
      "author-turn",
      () => {}
    )
    expect(review.review?.phase).toBe("needs-approval")
    expect(notifications).toBeGreaterThan(0)
    const checked = await assembly.readCheckedSource(
      `creator-business:${businessCreatorScopeKey(scope)}`,
      review.review!.copyId,
      review.review!.digest,
      () => {}
    )
    for (const [path, bytes] of Object.entries(resources))
      expect(checked.files.find((file) => file.path === path)?.bytes).toEqual(Buffer.from(bytes))
    expect(checked.files.find((file) => file.path === skill.entry)).toBeDefined()
    await writeFile(join(original, validatorPath), "# Changed after authoring approval\n")
    await expect(service.previewDetails(scope.threadId, preview.previewId)).rejects.toThrow(
      "BUSINESS_CREATOR_SOURCE_CHANGED"
    )
  } finally {
    service?.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 15000)

it("retains declared subagent files when a legacy module's Skill is changed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "creator-retained-agent-"))
  let service: CreatorBusinessService | undefined
  try {
    const original = join(directory, "original")
    const node = {
      id: "delivery.review",
      skill: "delivery-review",
      order: 10,
      checkpoints: ["review_in_progress", "review_done"],
      validators: [],
      guards: [],
      runtimePolicy: { subagentConfig: { customSubagentFiles: ["agents/reviewer.md"] } },
      artifacts: { inputs: [], outputs: [{ id: "review", path: "review.json", required: true }] }
    }
    const files = {
      "plugin.json": JSON.stringify({ name: "independent-agent-resource", version: "1.0.0" }),
      "board_core/board_config.json": JSON.stringify({ workflow: { nodes: [node] } }),
      "agents/reviewer.md":
        "---\nname: independent-reviewer\ndescription: Review the actual business evidence.\n---\nKeep all mandatory quality checks.\n",
      "skills/delivery-review/SKILL.md":
        "---\nname: delivery-review\ndescription: Original review\n---\nUse the declared reviewer.\n",
      "mods/business/manifest.json": JSON.stringify({
        apiVersion: "devclaw.business-mods/v1",
        kind: "catalog",
        kernel: {
          id: "independent.agent-closure",
          version: "1.0.0",
          boardConfigPath: "board_core/board_config.json",
          resources: ["board_core/board_config.json", "agents/reviewer.md"]
        },
        modules: [
          {
            id: node.id,
            title: "Review",
            node,
            skill: { entry: "skills/delivery-review/SKILL.md", resources: [] },
            resources: [],
            dependencies: { required: [], advisory: [] },
            checks: { validators: [], guards: [] }
          }
        ]
      })
    }
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(original, path)), { recursive: true })
      await writeFile(join(original, path), text)
    }
    const plugins = [
      {
        id: "independent-source",
        name: "independent-agent-resource",
        path: original,
        version: "1.0.0",
        enabled: true,
        updatedAt: "original"
      }
    ] as PluginMetadata[]
    const values = new Map<string, string>()
    const assembly = new BusinessModAssemblyService(join(directory, "assembly"), {
      plugins: () => plugins,
      install: async () => {
        throw Error("NO_INSTALL_AUTHORIZATION")
      },
      invalidate: () => {}
    })
    const scope = {
      workspace: directory,
      threadId: "retained-agent-closure",
      incarnation: { token: "original", legacyCreatedAt: 1 }
    }
    const context = () => ({
      scope,
      assertCurrent() {
        expect(scope.threadId).toBe("retained-agent-closure")
      }
    })
    let changes = 0
    service = new CreatorBusinessService({
      root: join(directory, "drafts"),
      assembly,
      plugins: () => plugins,
      settings: {
        getSetting: (key, fallback = "") => values.get(key) ?? fallback,
        compareAndSetSetting: (key, before, value) => {
          if (values.get(key) !== before) return false
          values.set(key, value)
          return true
        }
      },
      context,
      readContext: context,
      busy: () => false,
      changed() {
        changes++
      }
    })
    const source = await service.inspect(scope.threadId, plugins[0].id)
    const workflow = await service.readWorkflow(scope.threadId, source.id)
    const entry = "skills/delivery-review-v2/SKILL.md"
    const transformed = await service.transformWorkflow(scope.threadId, {
      id: "agent-skill-edit",
      name: "Reviewer retained",
      revision: 0,
      inspectionId: source.id,
      sourceDigest: workflow.sourceDigest,
      expectedWorkflowDigest: workflow.digest,
      changes: [
        {
          kind: "replace_skill",
          id: node.id,
          skillName: "delivery-review-v2",
          skill: { entry, resources: [] }
        }
      ],
      files: [
        {
          path: entry,
          text: "---\nname: delivery-review-v2\ndescription: Improved review\n---\nUse the original declared reviewer and checks.\n"
        }
      ]
    })
    const draft = service.read(scope.threadId, transformed.draft.id)
    expect(draft.retainedResources?.map((file) => file.path)).toContain("agents/reviewer.md")
    const preview = await service.preview(scope.threadId, {
      name: "independent-agent-resource-variant",
      version: "1.0.0",
      sources: [{ inspectionId: source.id, modIds: [node.id] }],
      drafts: [{ id: draft.id, revision: draft.revision, modIds: [node.id] }]
    })
    expect(preview.valid).toBe(true)
    expect(preview.files.find((file) => file.path === "agents/reviewer.md")?.bytes).toBe(
      Buffer.byteLength(files["agents/reviewer.md"])
    )
    expect(changes).toBeGreaterThan(0)
    // This case checks generic source closure, not admission as a reviewed legacy adapter.
    // The actual AutoBiz source is checked separately through the real adapter's admission.
  } finally {
    service?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

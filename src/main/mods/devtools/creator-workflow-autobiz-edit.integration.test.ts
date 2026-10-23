import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { expect, it } from "vitest"
import { CreatorBusinessService } from "./creator-business"
import { businessCreatorScopeKey } from "./creator-business-draft"
import { BusinessModAssemblyService } from "../../plugins/business-mod-assembly-service"
import { assertPackageExtensionCompatibility } from "../../plugins/extension-contract"
import { parseBusinessModCatalog } from "../../plugins/business-mod-manifest"
import type { PluginMetadata } from "../../types"

// Optional original-source verification. Ordinary CI never depends on a developer's ignored
// delivery directory. Supply an inspected complete AutoBiz source explicitly to run this case.
it.runIf(!!process.env.AUTOBIZ_WORKFLOW_EDIT_SOURCE)(
  "edits the actual AutoBiz Code Skill through creator services and retains its large source closure through native admission",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "creator-real-autobiz-edit-"))
    let service: CreatorBusinessService | undefined
    try {
      const original = resolve(process.env.AUTOBIZ_WORKFLOW_EDIT_SOURCE!)
      const metadata = JSON.parse(await readFile(join(original, "plugin.json"), "utf8"))
      const catalog = parseBusinessModCatalog(
        JSON.parse(await readFile(join(original, "mods/business/manifest.json"), "utf8"))
      )
      const code = catalog.modules.find((mod) => mod.id === "dev.code")!
      expect(code).toBeDefined()
      const preserved = await Promise.all(
        code.skill.resources.map(async (path) => ({
          path,
          bytes: await readFile(join(original, path))
        }))
      )
      expect(preserved.reduce((sum, file) => sum + file.bytes.length, 0)).toBeGreaterThan(
        256 * 1024
      )
      const plugins = [
        {
          id: "actual-autobiz-source",
          path: original,
          name: metadata.name,
          version: metadata.version,
          enabled: true,
          updatedAt: "frozen-source"
        }
      ] as PluginMetadata[]
      const values = new Map<string, string>()
      const assembly = new BusinessModAssemblyService(join(directory, "assembly"), {
        plugins: () => plugins,
        validatePackage: async (candidate) => {
          assertPackageExtensionCompatibility(candidate)
        },
        install: async () => {
          throw Error("NO_INSTALL_AUTHORIZATION")
        },
        invalidate: () => {}
      })
      const scope = {
        workspace: directory,
        threadId: "actual-autobiz-code-edit",
        incarnation: { token: "retained-original-source", legacyCreatedAt: 1 }
      }
      const context = () => ({
        scope,
        assertCurrent() {
          expect(scope.threadId).toBe("actual-autobiz-code-edit")
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
      const order = [
        "biz.prd",
        "dev.specs",
        "dev.design",
        "dev.plan",
        "dev.code",
        "ops.cicd",
        "ops.archive"
      ]
      const workflow = await service.readWorkflow(scope.threadId, source.id, undefined, order)
      const originalSkill = await readFile(join(original, code.skill.entry), "utf8")
      const edited = await service.transformWorkflow(scope.threadId, {
        id: "actual-code-edit",
        name: "AutoBiz Code Skill改进验证",
        revision: 0,
        inspectionId: source.id,
        sourceDigest: workflow.sourceDigest,
        expectedWorkflowDigest: workflow.digest,
        modIds: order,
        changes: [
          {
            kind: "replace_skill",
            id: code.id,
            skillName: String(code.node.skill),
            skill: { entry: code.skill.entry, resources: [] }
          }
        ],
        files: [
          {
            path: code.skill.entry,
            text:
              originalSkill +
              "\n继续使用原知识、Hooks、产物契约和受控状态动作，禁止伪造检查回执。\n"
          }
        ]
      })
      const draft = service.read(scope.threadId, edited.draft.id)
      expect(draft.files).toHaveLength(1)
      expect(draft.retainedResources!.length).toBeGreaterThanOrEqual(preserved.length)
      const preview = await service.preview(scope.threadId, {
        name: "autobiz-code-edit-native-checked",
        version: "1.0.0",
        sources: [
          {
            inspectionId: source.id,
            modIds: [...order, ...(catalog.extensions ?? []).map((mod) => mod.id)]
          }
        ],
        drafts: [{ id: draft.id, revision: draft.revision, modIds: [code.id] }]
      })
      expect(preview.valid, preview.diagnostics.join("\n")).toBe(true)
      const review = await service.requestReview(
        scope.threadId,
        preview.previewId,
        "verification-turn",
        () => {}
      )
      expect(review.review?.phase).toBe("needs-approval")
      const checked = await assembly.readCheckedSource(
        `creator-business:${businessCreatorScopeKey(scope)}`,
        review.review!.copyId,
        review.review!.digest,
        () => {}
      )
      for (const file of preserved)
        expect(checked.files.find((item) => item.path === file.path)?.bytes).toEqual(file.bytes)
      for (const path of ["hooks/hooks.json", "board_core/board_config.json"])
        expect(checked.files.some((item) => item.path === path)).toBe(true)
      expect(changes).toBeGreaterThan(0)
      // Native package checks and preserved bytes are verified. No remote model, business
      // stage execution, installation or configuration rebinding is implied by this test.
    } finally {
      service?.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
  15000
)

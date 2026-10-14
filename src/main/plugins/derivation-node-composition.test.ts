import { randomUUID } from "node:crypto"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { expect, it, vi } from "vitest"
import {
  appendNodeCompositionConfig,
  prepareNodeCompositionFiles,
  COMPOSITION_CONFIG,
  COMPOSITION_TEMPLATE
} from "./derivation-node-composition"
import { PluginDerivationService } from "./derivation-service"
import { DerivationProposalService } from "./derivation-proposal"
import { snapshotDerivationSource } from "./derivation-source"
import type { PluginMetadata } from "../types"

const original = {
  workflow: {
    nodes: [{ id: "dev.code" }, { id: "ops.archive" }],
    templates: { standard: { kind: "profile" }, lean: { kind: "nodeSubset", nodes: ["dev.code"] } }
  },
  hooks: { unchanged: [1, true, "guard"] }
}
it("only inserts one template and preserves every other JSON value and source spelling", () => {
  const before = JSON.stringify(original, null, 2)
  const change = appendNodeCompositionConfig(before).files[0]
  const value = JSON.parse(change.after)
  expect(value.workflow.templates[COMPOSITION_TEMPLATE]).toMatchObject({
    kind: "custom",
    requiredNodes: ["dev.code", "ops.archive"]
  })
  delete value.workflow.templates[COMPOSITION_TEMPLATE]
  expect(value).toStrictEqual(original)
  expect(change.path).toBe(COMPOSITION_CONFIG)
  expect(change.before).toBe(before)
  expect(() => appendNodeCompositionConfig(change.after)).toThrow("已启用")
})
it.each([
  '{"workflow":{"templates":{},"templates":{},"nodes":[]}}',
  '{"workflow":{"templates":{"lean":{},"le\\u0061n":{}},"nodes":[]}}'
])("rejects duplicate JSON keys", (value) => {
  expect(() => appendNodeCompositionConfig(value)).toThrow("重复字段")
})
it("rejects conflicting names, missing required nodes, and unknown protocol sources", () => {
  const conflict: {
    workflow: { templates: Record<string, unknown>; nodes: Array<{ id: string }> }
  } = structuredClone(original)
  conflict.workflow.templates[COMPOSITION_TEMPLATE] = { kind: "profile" }
  expect(() => appendNodeCompositionConfig(JSON.stringify(conflict))).toThrow("占用")
  conflict.workflow.templates = {}
  conflict.workflow.nodes = []
  expect(() => appendNodeCompositionConfig(JSON.stringify(conflict))).toThrow("缺少")
  expect(() =>
    prepareNodeCompositionFiles({
      files: [],
      root: "",
      excluded: [],
      digest: "",
      name: "",
      totalBytes: 0,
      manifests: []
    })
  ).toThrow("尚不支持")
})

// Explicit local compatibility verification; portable suites do not require the external repository.
it.skipIf(!process.env.CMB_AUTOBIZ_TEST_SOURCE)(
  "publishes a real AutoBiz candidate atomically without model calls or protocol changes",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "composition-candidate-"))
    try {
      const deps = { plugins: () => [] as PluginMetadata[], install: vi.fn(), invalidate: vi.fn() }
      const service = new PluginDerivationService(join(root, "copies"), deps)
      const inspection = await service.inspect(
        process.env.CMB_AUTOBIZ_TEST_SOURCE!,
        "owner",
        () => {}
      )
      const copy = await service.create(
        "owner",
        inspection.inspectionId,
        "composition-test-copy",
        randomUUID(),
        () => {}
      )
      const source = service.sourcePath(copy.copyId, "owner")
      const before = await snapshotDerivationSource(source)
      const model = vi.fn()
      const proposals = new DerivationProposalService({
        snapshot: (owner, id, digest, guard) => service.proposalSnapshot(owner, id, digest, guard),
        model,
        apply: (owner, proposal, guard, kind) => service.applyProposal(owner, proposal, guard, kind)
      })
      const context = { owner: "owner", identity: "scope-1", guard: () => {} }
      const input = { copyId: copy.copyId, expectedDigest: copy.digest, requestId: randomUUID() }
      const cancelled = await proposals.prepareNodeComposition(context, input)
      proposals.cancel(context, { proposalId: cancelled.proposalId })
      await expect(proposals.apply(context, cancelled.proposalId)).rejects.toThrow("失效")
      expect((await snapshotDerivationSource(source)).digest).toBe(before.digest)
      const candidate = await proposals.prepareNodeComposition(context, {
        ...input,
        requestId: randomUUID()
      })
      await expect(
        proposals.apply({ ...context, identity: "different" }, candidate.proposalId)
      ).rejects.toThrow("失效")
      const forged = structuredClone(candidate)
      forged.files[0].after = forged.files[0].after.replace('"kind": "custom"', '"kind": "profile"')
      await expect(
        service.applyProposal("owner", forged, () => {}, "node-composition")
      ).rejects.toThrow("确定性")
      await expect(service.applyProposal("owner", candidate, () => {})).rejects.toThrow("技能")
      const saved = await proposals.apply(context, candidate.proposalId)
      expect(await proposals.apply(context, candidate.proposalId)).toEqual(saved)
      expect(model).not.toHaveBeenCalled()
      const after = await snapshotDerivationSource(source)
      expect(after.files).toHaveLength(before.files.length)
      for (const file of before.files) {
        const current = after.files.find((item) => item.path === file.path)!
        expect(current.mode).toBe(file.mode)
        if (file.path !== COMPOSITION_CONFIG) expect(current.bytes).toEqual(file.bytes)
      }
      const prior = JSON.parse(
        before.files.find((file) => file.path === COMPOSITION_CONFIG)!.bytes.toString()
      )
      const restored = JSON.parse(await readFile(join(source, COMPOSITION_CONFIG), "utf8"))
      delete restored.workflow.templates[COMPOSITION_TEMPLATE]
      expect(restored).toStrictEqual(prior)
      const inspect = (args: string[]) => {
        const result = spawnSync(
          "python",
          ["-B", "-X", "utf8", join(source, "hooks/inspect_workflow_templates.py"), ...args],
          { encoding: "utf8", windowsHide: true, timeout: 10000 }
        )
        expect(result.error).toBeUndefined()
        expect(result.status, result.stderr).toBe(0)
        return JSON.parse(result.stdout)
      }
      const catalog = inspect(["--mode", "templates"])
      expect(
        catalog.templates.find((item: { id: string }) => item.id === COMPOSITION_TEMPLATE)
      ).toMatchObject({
        templateType: "custom",
        requiredNodes: ["dev.code", "ops.archive"]
      })
      const closed = inspect([
        "--mode",
        "closure",
        "--template",
        COMPOSITION_TEMPLATE,
        "--nodes",
        "dev.code",
        "--auto-include"
      ])
      expect(closed.ok).toBe(true)
      expect(closed.closure.nodes).toEqual(expect.arrayContaining(["dev.code", "ops.archive"]))
      await expect(
        proposals.prepareNodeComposition(context, {
          ...input,
          expectedDigest: saved.digest,
          requestId: randomUUID()
        })
      ).rejects.toThrow("已启用")
      const checked = await service.check("owner", copy.copyId, () => {})
      deps.install.mockImplementation(async (_directory, _name, pluginId) => {
        deps.plugins = () => [{ id: pluginId } as PluginMetadata]
        return { success: true }
      })
      const installed = await service.install("owner", copy.copyId, checked.digest, () => {})
      await expect(
        proposals.prepareNodeComposition(context, {
          ...input,
          expectedDigest: installed.digest,
          requestId: randomUUID()
        })
      ).rejects.toThrow("已安装")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  30000
)

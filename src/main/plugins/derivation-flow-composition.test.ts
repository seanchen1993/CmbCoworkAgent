import { randomUUID } from "node:crypto"
import { mkdtemp, cp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, describe, expect, it, vi } from "vitest"
import { withPinnedAutobiz } from "../mods/v2/autobiz-source"
import { PluginDerivationService } from "./derivation-service"
import { DerivationProposalService } from "./derivation-proposal"
import { snapshotDerivationSource } from "./derivation-source"
import {
  isReviewedAutobizProtocol,
  prepareFlowCompositionFiles
} from "./derivation-flow-composition"
import { parseProjectRuntimeManifest } from "../../shared/project-runtime"
import { parsePluginCapabilitiesJson } from "../../shared/plugin-capabilities"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "flow-proposal-"))
  roots.push(root)
  const source = join(root, "original")
  await cp(resolve("examples/project-docs-lite"), source, { recursive: true })
  await rm(join(source, "devclaw.capabilities.json"))
  const service = new PluginDerivationService(join(root, "copies"), {
    plugins: () => [],
    install: vi.fn(),
    invalidate: vi.fn()
  })
  const inspected = await service.inspect(source, "workspace", () => {})
  const copy = await service.create(
    "workspace",
    inspected.inspectionId,
    "docs-copy",
    randomUUID(),
    () => {}
  )
  const model = vi.fn()
  const proposals = new DerivationProposalService({
    snapshot: (...args) => service.proposalSnapshot(...args),
    model,
    apply: (...args) => service.applyProposal(...args)
  })
  const context = { owner: "workspace", identity: "window:thread", guard: () => {} }
  return {
    root,
    source,
    service,
    copy,
    model,
    proposals,
    context,
    input: { copyId: copy.copyId, expectedDigest: copy.digest, requestId: randomUUID() }
  }
}

describe("reviewed full-flow preparation", () => {
  it("previews without writing or calling a model, then atomically adds only the reviewed declaration", async () => {
    const f = await fixture()
    const source = f.service.sourcePath(f.copy.copyId, "workspace")
    const before = await snapshotDerivationSource(source)
    const proposal = await f.proposals.prepareFlowComposition(f.context, f.input)
    expect(proposal.files.map((file) => file.path)).toEqual(["devclaw.capabilities.json"])
    expect((await snapshotDerivationSource(source)).digest).toBe(before.digest)
    expect(f.model).not.toHaveBeenCalled()
    const updated = await f.proposals.apply(f.context, proposal.proposalId)
    expect(updated.digest).not.toBe(before.digest)
    const after = await snapshotDerivationSource(source)
    for (const original of before.files)
      expect(after.files.find((file) => file.path === original.path)?.bytes).toEqual(original.bytes)
    const declaration = parsePluginCapabilitiesJson(
      await readFile(join(source, "devclaw.capabilities.json"), "utf8")
    )
    expect(declaration.capabilities[0]).toMatchObject({ kind: "flow", usage: "project" })
    expect(await f.proposals.apply(f.context, proposal.proposalId)).toEqual(updated)
    expect(() => prepareFlowCompositionFiles(after)).toThrow("不能重复覆盖")
  })

  it("rejects arbitrary additions, stale previews, and cancelled confirmation", async () => {
    const f = await fixture()
    const proposal = await f.proposals.prepareFlowComposition(f.context, f.input)
    await expect(
      f.service.applyProposal(
        "workspace",
        {
          ...proposal,
          files: [...proposal.files, { path: "hooks/evil.py", before: "", after: "bad" }]
        },
        () => {},
        "flow-composition"
      )
    ).rejects.toThrow("确定性配置")
    f.proposals.cancel(f.context, { proposalId: proposal.proposalId })
    await expect(f.proposals.apply(f.context, proposal.proposalId)).rejects.toThrow("失效")
    const next = await f.proposals.prepareFlowComposition(f.context, {
      ...f.input,
      requestId: randomUUID()
    })
    await writeFile(join(f.service.sourcePath(f.copy.copyId, "workspace"), "README.md"), "changed")
    await expect(f.proposals.apply(f.context, next.proposalId)).rejects.toThrow("源码已变化")
  })

  it("prepares the pinned AutoBiz protocol without mutating Hooks, stages or skills; extra code fails closed", async () => {
    await withPinnedAutobiz(undefined, async (source) => {
      const snapshot = await snapshotDerivationSource(source)
      expect(isReviewedAutobizProtocol(snapshot)).toBe(true)
      expect(
        isReviewedAutobizProtocol({
          files: [
            ...snapshot.files,
            { path: "board_core/contracts.pyd", bytes: Buffer.from("unreviewed native import") }
          ]
        })
      ).toBe(false)
      const proposal = prepareFlowCompositionFiles(snapshot)
      expect(proposal.files.map((file) => file.path)).toEqual([
        "devclaw.project-runtime.json",
        "devclaw.stage-checks.json",
        "devclaw.source-handoff.json",
        "devclaw.capabilities.json"
      ])
      expect(parseProjectRuntimeManifest(JSON.parse(proposal.files[0].after)).mode).toBe("legacy")
      expect(parseProjectRuntimeManifest(JSON.parse(proposal.files[0].after)).artifacts).toEqual([
        { id: "verified-context", path: ".devclaw/handoffs/verified-context.json", required: true }
      ])
      expect((await snapshotDerivationSource(source)).digest).toBe(snapshot.digest)
      expect(
        isReviewedAutobizProtocol({
          ...snapshot,
          files: snapshot.files.map((file) => {
            if (file.path !== "board_core/board_config.json") return file
            const board = JSON.parse(file.bytes.toString("utf8"))
            board.inspectCommands.win32.create_feature = "python unreviewed.py"
            return { ...file, bytes: Buffer.from(JSON.stringify(board)) }
          })
        })
      ).toBe(false)
      await writeFile(join(source, "helper.py"), "print('unreviewed')")
      expect(() =>
        prepareFlowCompositionFiles({
          ...snapshot,
          files: [
            ...snapshot.files,
            { path: "helper.py", bytes: Buffer.from("changed"), mode: 0o644, digest: "" }
          ]
        })
      ).toThrow("尚未通过")
      expect(() =>
        prepareFlowCompositionFiles({
          ...snapshot,
          files: snapshot.files.map((file) =>
            file.path === "board_core/workflow_compiler.py"
              ? { ...file, bytes: Buffer.from("changed") }
              : file
          )
        })
      ).toThrow("尚未通过")
    })
  }, 60000)
})

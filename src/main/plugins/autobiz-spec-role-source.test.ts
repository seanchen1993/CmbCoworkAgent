import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, it } from "vitest"
import { prepareAutobizSpecRoleSource } from "../../../scripts/prepare-autobiz-spec-role-source"
import { snapshotDerivationSource } from "./derivation-source"
import { isReviewedAutobizProtocol } from "./autobiz-composition-protocol"
import { verifyReviewedBusinessAssembly } from "./autobiz-business-assembly-protocol"
import { isReviewedAutobizKernelIdentity } from "./autobiz-required-hooks"
import previous from "./autobiz-business-kernel-wakeup-reviewed.json"
import reviewed from "./autobiz-business-kernel-spec-role-reviewed.json"

const source = resolve("output/deliveries/mods-creator-workflow-wakeup-20261017-v102-v2/Mods来源/AutoBiz")
const delivered = resolve("output/deliveries/mods-creator-spec-role-20261017-v103/autobiz-complete-spec-role")
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex")

it("adds only the exact specs definition and two original role pins to a separate complete profile", () => {
  const restored = {
    ...structuredClone(reviewed),
    version: previous.version,
    modules: {
      ...structuredClone(reviewed.modules),
      "dev.specs": structuredClone(previous.modules["dev.specs"])
    }
  }
  expect(restored).toEqual(previous)
  expect(isReviewedAutobizKernelIdentity({ id: reviewed.id, version: "1.0.3" })).toBe(true)
  expect(isReviewedAutobizKernelIdentity({ id: reviewed.id, version: "1.0.99" })).toBe(false)
  expect(sha(readFileSync("src/main/plugins/autobiz-business-kernel-reviewed.json")))
    .toBe("cfa60099de35bd8901c8a251e9747cab0e71fa868cfd13cec84d07067e156a27")
  expect(sha(readFileSync("src/main/plugins/autobiz-business-kernel-merge-reviewed.json")))
    .toBe("d5b8d48176388921c3f6e4e80ae00399b4e9f3efdfa0abd72f022dbeaba9cfc2")
})

it("creates a separate no-overwrite source with only four declared metadata changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "autobiz-spec-role-"))
  try {
    const before = await snapshotDerivationSource(source)
    const output = join(root, "new-source")
    const receipt = await prepareAutobizSpecRoleSource(output, source)
    expect(receipt.changedFiles.sort()).toEqual(["board_core/board_config.json",
      "devclaw.project-runtime.json", "mods/business/manifest.json", "plugin.json"])
    expect(receipt.workflowUnchangedSha256).toBe("7a49595b62bc1b8498ab3413be9304eed4de8ada37a8e43f906e43be51874667")
    expect((await snapshotDerivationSource(source)).digest).toBe(before.digest)
    await expect(prepareAutobizSpecRoleSource(output, source)).rejects.toThrow(/EEXIST/)
    await expect(prepareAutobizSpecRoleSource(join(source, "invalid-output"), source)).rejects.toThrow("outside")
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60000)

it("admits the actual full package with the Skill-required exact specs role and unchanged critic", async () => {
  const snapshot = await snapshotDerivationSource(delivered)
  expect(isReviewedAutobizProtocol(snapshot)).toBe(true)
  expect(verifyReviewedBusinessAssembly(snapshot, reviewed)).toBe(true)
  expect(verifyReviewedBusinessAssembly(snapshot, previous)).toBe(false)
  const files = new Map(snapshot.files.map(file => [file.path, file.bytes]))
  const board = JSON.parse(files.get("board_core/board_config.json")!.toString("utf8"))
  expect(board.workflow.nodes.find((node: { id: string }) => node.id === "dev.specs")
    .runtimePolicy.subagentConfig.customSubagentFiles).toEqual(["agents/explore_spec.md", "agents/critic.md"])
  expect(files.get("agents/explore_spec.md")!.toString("utf8")).toMatch(/name: Explore-autodev-spec/)
  expect(files.get("agents/critic.md")!.toString("utf8")).toMatch(/name: critic-autodev/)
  expect(files.get("skills/autodev/autodev-specs/SKILL.md")!.toString("utf8"))
    .toContain("指定 Explore-autodev-spec 角色")
})

it("rejects rehashed role, required Hook, workflow and unknown version changes", async () => {
  const snapshot = await snapshotDerivationSource(delivered)
  for (const changed of ["agents/explore_spec.md", "hooks/state_checkpoint.py",
    "workflows/code-batched-execution.workflow.js", "mods/business/manifest.json"]) {
    const files = snapshot.files.map(file => ({ ...file, bytes: Buffer.from(file.bytes) }))
    const file = files.find(row => row.path === changed)!
    if (changed.endsWith("manifest.json")) {
      const value = JSON.parse(file.bytes.toString("utf8")); value.kernel.version = "1.0.99"
      file.bytes = Buffer.from(JSON.stringify(value))
    } else file.bytes = Buffer.concat([file.bytes, Buffer.from("\n# unreviewed-byte-change")])
    const lockFile = files.find(row => row.path === "devclaw.business-assembly.json")!
    const lock = JSON.parse(lockFile.bytes.toString("utf8"))
    lock.files.find((row: { path: string }) => row.path === changed).digest = sha(file.bytes)
    const kernelFile = lock.kernel.files.find((row: { path: string }) => row.path === changed)
    if (kernelFile) kernelFile.digest = sha(file.bytes)
    lockFile.bytes = Buffer.from(JSON.stringify(lock))
    expect(isReviewedAutobizProtocol({ files }), changed).toBe(false)
  }
})

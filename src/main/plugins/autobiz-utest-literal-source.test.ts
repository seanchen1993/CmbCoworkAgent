import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { cp, lstat, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { beforeAll, expect, it } from "vitest"
import {
  prepareAutobizUtestLiteralSource,
  AUTOBIZ_UTEST_LITERAL_FROM_SHA256,
  AUTOBIZ_UTEST_LITERAL_TO_SHA256,
  AUTOBIZ_UTEST_LITERAL_PATH,
  AUTOBIZ_UTEST_LITERAL_WORKFLOW_SHA256
} from "../../../scripts/prepare-autobiz-utest-literal-source"
import { snapshotDerivationSource } from "./derivation-source"
import { businessModCatalog } from "./business-mod-manifest"
import { assembleBusinessMods } from "./business-mod-assembler"
import { isReviewedAutobizProtocol } from "./autobiz-composition-protocol"
import { isReviewedAutobizKernelIdentity } from "./autobiz-required-hooks"
import previous from "./autobiz-business-kernel-spec-role-reviewed.json"
import reviewed from "./autobiz-business-kernel-utest-literal-reviewed.json"

const source = resolve("output/deliveries/mods-creator-spec-role-20261017-v103/Mods来源/AutoBiz")
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")
let root: string, output: string, description: string
let receipt: Awaited<ReturnType<typeof prepareAutobizUtestLiteralSource>>
function hook(input: unknown, directory = output) {
  return spawnSync(
    "python",
    ["-I", "-B", "-X", "utf8", join(directory, AUTOBIZ_UTEST_LITERAL_PATH)],
    {
      input: JSON.stringify(input),
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000
    }
  )
}
const payload = (description: string, subagent = "test-engineer-autodev") => ({
  tool_name: "task",
  tool_input: { description, subagent_type: subagent }
})

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "autobiz-utest-literal-"))
  output = join(root, "source-1.0.4")
  receipt = await prepareAutobizUtestLiteralSource(output, source)
  const feature = join(root, "feature"),
    plan = join(feature, "plans/B001")
  await mkdir(plan, { recursive: true })
  await writeFile(
    join(feature, "plan.json"),
    JSON.stringify({ batches: [{ batchId: "B001", path: "plans/B001/plan.json" }] })
  )
  await writeFile(
    join(plan, "plan.json"),
    JSON.stringify({
      batchId: "B001",
      executionLane: "backend",
      tasks: [
        {
          id: "T001",
          title: "Integer addition",
          goal: "Add integers",
          workspaceRef: "default",
          implementationPoints: ["Preserve integer addition"],
          testPoints: ["Negative integer behavior"],
          nonGoals: ["No API"],
          validationBoundary: "public function",
          specRefs: ["REQ-001", "SCN-001"],
          acceptanceCriteria: [
            { id: "AC-T001-01", text: "Adds integers", scenarioRefs: ["SCN-001"] }
          ]
        }
      ]
    })
  )
  const router = spawnSync(
    "python",
    [
      "-I",
      "-B",
      "-X",
      "utf8",
      "-c",
      "import json,sys;from pathlib import Path;sys.path.insert(0,sys.argv[1]);from hooks.utest_assignment_router import build_assignments;print(json.dumps(build_assignments(Path(sys.argv[2]))[0]['promptContent']))",
      output,
      feature
    ],
    { encoding: "utf8", windowsHide: true, timeout: 10000 }
  )
  expect(router.status, router.stderr).toBe(0)
  description = JSON.parse(router.stdout)
}, 120000)

it("pins the complete old profile with only the reviewed Hook SHA and version delta", () => {
  const restored = structuredClone(reviewed)
  restored.version = previous.version
  restored.files.find((file) => file.path === AUTOBIZ_UTEST_LITERAL_PATH)!.digest =
    AUTOBIZ_UTEST_LITERAL_FROM_SHA256
  expect(restored).toEqual(previous)
  expect(reviewed.files.find((file) => file.path === AUTOBIZ_UTEST_LITERAL_PATH)!.digest).toBe(
    AUTOBIZ_UTEST_LITERAL_TO_SHA256
  )
  expect(isReviewedAutobizKernelIdentity({ id: reviewed.id, version: "1.0.4" })).toBe(true)
  expect(isReviewedAutobizKernelIdentity({ id: reviewed.id, version: "1.0.5" })).toBe(false)
  expect(receipt.changedFiles.sort()).toEqual(
    [
      AUTOBIZ_UTEST_LITERAL_PATH,
      "devclaw.project-runtime.json",
      "mods/business/manifest.json",
      "plugin.json"
    ].sort()
  )
  expect(receipt.workflowUnchangedSha256).toBe(AUTOBIZ_UTEST_LITERAL_WORKFLOW_SHA256)
  expect(hash(readFileSync(join(output, "workflows/code-batched-execution.workflow.js")))).toBe(
    AUTOBIZ_UTEST_LITERAL_WORKFLOW_SHA256
  )
})

it("proves the old module fails before target filtering while the repaired non-target stays unchanged", () => {
  const old = hook(payload("ordinary review", "verification-autodev"), source)
  expect(old.status).not.toBe(0)
  expect(old.stderr).toContain("KeyError: 'PIPESTATUS'")
  const actual = hook(payload("ordinary review", "verification-autodev"))
  expect(actual.status, actual.stderr).toBe(0)
  expect(actual.stdout).toBe("")
  expect(actual.stderr).toContain("skipped; subagent_type must be test-engineer-autodev")
})

it("uses the original real router validation and appends the original Bash literal exactly once", () => {
  const actual = hook(payload(description))
  expect(actual.status, actual.stderr).toBe(0)
  const updated = JSON.parse(actual.stdout).updatedInput.description as string
  expect(updated.startsWith(description)).toBe(true)
  expect(updated).toContain("${PIPESTATUS[0]}")
  expect(updated).not.toContain("${{PIPESTATUS[0]}}")
  for (const marker of [
    "post_implementation=true",
    "tdd_rebuild=false",
    "source_bug_attestation",
    "non-zero Evidence",
    "run_utest_command.py --kind test --record-only",
    "<AGENTS_INSTRUCTIONS>"
  ])
    expect(updated).toContain(marker)
  expect(actual.stderr).toContain("appended")
  const repeated = hook(payload(updated))
  expect(repeated.status).toBe(0)
  expect(repeated.stdout).toBe("")
  expect(repeated.stderr).toContain("already present")
})

it("preserves original rejection of missing and mismatched authoritative assignments", () => {
  for (const input of [
    "unbound summary",
    "<UTEST_ASSIGNMENT>{bad}</UTEST_ASSIGNMENT>",
    description.replace("Add integers", "Unapproved rewrite")
  ]) {
    const actual = hook(payload(input))
    // Original Hook emits no updatedInput for invalid assignments; its exit remains zero.
    expect(actual.status, actual.stderr).toBe(0)
    expect(actual.stdout).toBe("")
    expect(actual.stderr).toMatch(/missing|invalid UTEST_ASSIGNMENT/)
  }
})

it("rejects existing outputs and unknown original bytes without creating a transformed source", async () => {
  await expect(prepareAutobizUtestLiteralSource(output, source)).rejects.toThrow("OUTPUT_EXISTS")
  const reserved = join(root, "reserved")
  await writeFile(reserved + ".receipt.json", "existing-receipt")
  await expect(prepareAutobizUtestLiteralSource(reserved, source)).rejects.toThrow("OUTPUT_EXISTS")
  expect(readFileSync(reserved + ".receipt.json", "utf8")).toBe("existing-receipt")
  await expect(lstat(reserved)).rejects.toMatchObject({ code: "ENOENT" })
  await expect(prepareAutobizUtestLiteralSource(join(source, "invalid"), source)).rejects.toThrow(
    "outside"
  )
  const unknown = join(root, "unknown-source")
  await cp(source, unknown, { recursive: true })
  await writeFile(
    join(unknown, AUTOBIZ_UTEST_LITERAL_PATH),
    Buffer.concat([
      readFileSync(join(source, AUTOBIZ_UTEST_LITERAL_PATH)),
      Buffer.from("\n# unknown original byte\n")
    ])
  )
  await expect(
    prepareAutobizUtestLiteralSource(join(root, "rejected-source"), unknown)
  ).rejects.toThrow("Exact reviewed 1.0.3 source bytes required")
  await expect(lstat(join(root, "rejected-source"))).rejects.toMatchObject({ code: "ENOENT" })
}, 30000)

it("admits actual assembly under the new exact profile and rejects self-rehashed Hook tampering", async () => {
  const snapshot = await snapshotDerivationSource(output),
    catalog = businessModCatalog(snapshot)
  const assembled = assembleBusinessMods(
    [{ snapshot, catalog, modIds: catalog.modules.map((mod) => mod.id) }],
    {
      name: "utest-literal-regression",
      version: "1.0.4",
      sources: []
    }
  )
  expect(isReviewedAutobizProtocol(assembled)).toBe(true)
  const files = assembled.files.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) }))
  const changed = files.find((file) => file.path === AUTOBIZ_UTEST_LITERAL_PATH)!
  changed.bytes = Buffer.concat([changed.bytes, Buffer.from("\n# unknown modification\n")])
  const lockFile = files.find((file) => file.path === "devclaw.business-assembly.json")!
  const lock = JSON.parse(lockFile.bytes.toString("utf8"))
  for (const list of [lock.files, lock.kernel.files])
    list.find((file: { path: string }) => file.path === AUTOBIZ_UTEST_LITERAL_PATH).digest = hash(
      changed.bytes
    )
  lockFile.bytes = Buffer.from(JSON.stringify(lock))
  expect(isReviewedAutobizProtocol({ files })).toBe(false)
}, 30000)

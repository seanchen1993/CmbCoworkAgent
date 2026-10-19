import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import ts from "typescript"
import { afterEach, expect, it } from "vitest"
import { prepareAutobizWorkflowWakeupSource, transformAutobizWorkflowWakeup,
  AUTOBIZ_WORKFLOW_TARGET_SHA256 } from "../../../scripts/prepare-autobiz-workflow-wakeup-source"
import { snapshotDerivationSource } from "./derivation-source"
import { isReviewedAutobizProtocol } from "./autobiz-composition-protocol"
import { verifyReviewedBusinessAssembly } from "./autobiz-business-assembly-protocol"
import { isReviewedAutobizKernelIdentity } from "./autobiz-required-hooks"
import reviewed from "./autobiz-business-kernel-reviewed.json"
import mergeReviewed from "./autobiz-business-kernel-merge-reviewed.json"
import wakeupReviewed from "./autobiz-business-kernel-wakeup-reviewed.json"

const source = resolve("output/mods-s2-s5-20261017/autobiz-plan-merge-compatible-v3")
const delivered = resolve("output/deliveries/mods-creator-workflow-wakeup-20261017-v102-v2/autobiz-complete-wakeup")
const roots: string[] = []
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
afterEach(async () => {
  for (const root of roots.splice(0)) {
    expect(dirname(root)).toBe(tmpdir())
    expect(root.split(/[\\/]/).at(-1)).toMatch(/^autobiz-wakeup-/)
    await rm(root, { recursive: true, force: true })
  }
})

it("adds only an explicit version and one exact module byte pin, preserving both historical profiles", () => {
  expect(sha(readFileSync(resolve("src/main/plugins/autobiz-business-kernel-reviewed.json"))))
    .toBe("cfa60099de35bd8901c8a251e9747cab0e71fa868cfd13cec84d07067e156a27")
  expect(sha(readFileSync(resolve("src/main/plugins/autobiz-business-kernel-merge-reviewed.json"))))
    .toBe("d5b8d48176388921c3f6e4e80ae00399b4e9f3efdfa0abd72f022dbeaba9cfc2")
  const restored = structuredClone(wakeupReviewed)
  restored.version = mergeReviewed.version
  restored.modules["dev.code"].files["workflows/code-batched-execution.workflow.js"] =
    mergeReviewed.modules["dev.code"].files["workflows/code-batched-execution.workflow.js"]
  expect(restored).toEqual(mergeReviewed)
  expect(isReviewedAutobizKernelIdentity({ id: wakeupReviewed.id, version: "1.0.2" })).toBe(true)
  expect(isReviewedAutobizKernelIdentity({ id: wakeupReviewed.id, version: "1.0.99" })).toBe(false)
  expect(isReviewedAutobizKernelIdentity({ id: "someone-else", version: "1.0.2" })).toBe(false)
})

it.skipIf(!existsSync(source))("changes only dispatcher coordination, never original stages/gates/journal or fallback time", async () => {
  const before = await readFile(join(source, "workflows/code-batched-execution.workflow.js"))
  const after = await transformAutobizWorkflowWakeup(before)
  expect(sha(after)).toBe(AUTOBIZ_WORKFLOW_TARGET_SHA256)
  await expect(transformAutobizWorkflowWakeup(Buffer.concat([before, Buffer.from("\n// unknown")]))).rejects.toThrow("Exact reviewed")
  const helper = (await readFile(resolve("resources/mods/autobiz-workflow-wakeup/dispatcher-wakeup.js.inc"), "utf8"))
    .replaceAll("\r\n", "\n").replaceAll("\n", "\r\n")
  const strip = (text: string) => {
    const parsed = ts.createSourceFile("workflow.js", text, ts.ScriptTarget.ESNext, true)
    const spans = parsed.statements.filter(node => ts.isFunctionDeclaration(node) &&
      ["runDispatchWorker", "drainRunnableLifecycles"].includes(node.name?.text ?? ""))
      .map(node => [node.getStart(parsed), node.end])
    for (const [start, end] of spans.reverse()) text = text.slice(0, start) + text.slice(end)
    return text
  }
  expect(strip(after.toString("utf8").replace(helper, ""))).toBe(strip(before.toString("utf8")))
  expect(after.toString("utf8")).toContain("const DISPATCH_POLL_INTERVAL_MS = 30 * 60 * 1000;")
})

it.skipIf(!existsSync(source))("creates an independent no-overwrite 1.0.2 source with exactly four declared changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "autobiz-wakeup-"))
  roots.push(root)
  const before = await snapshotDerivationSource(source)
  const output = join(root, "new-source")
  const receipt = await prepareAutobizWorkflowWakeupSource(output, source)
  expect(receipt.changedFiles.sort()).toEqual(["devclaw.project-runtime.json",
    "mods/business/manifest.json", "plugin.json", "workflows/code-batched-execution.workflow.js"])
  expect(receipt.kernelVersion).toBe("1.0.2")
  const after = await snapshotDerivationSource(output)
  for (const file of before.files) if (!receipt.changedFiles.includes(file.path))
    expect(after.files.find(item => item.path === file.path)?.digest, file.path).toBe(file.digest)
  await expect(prepareAutobizWorkflowWakeupSource(output, source)).rejects.toThrow(/EEXIST/)
  await expect(prepareAutobizWorkflowWakeupSource(join(source, "must-not-write"), source)).rejects.toThrow("outside")
  expect((await snapshotDerivationSource(source)).digest).toBe(before.digest)
}, 60000)

it.skipIf(!existsSync(delivered))("admits actual new native assembly and rejects rehashed Workflow/Hook/version tampering", async () => {
  const snapshot = await snapshotDerivationSource(delivered)
  expect(isReviewedAutobizProtocol(snapshot)).toBe(true)
  expect(verifyReviewedBusinessAssembly(snapshot, wakeupReviewed)).toBe(true)
  expect(verifyReviewedBusinessAssembly(snapshot, reviewed)).toBe(false)
  expect(verifyReviewedBusinessAssembly(snapshot, mergeReviewed)).toBe(false)
  const capabilities = JSON.parse(snapshot.files.find(file => file.path === "devclaw.capabilities.json")!.bytes.toString())
  expect(capabilities.capabilities.find((item: { id: string }) => item.id === "project-flow").requiredHooks).toHaveLength(12)
  for (const changed of ["workflows/code-batched-execution.workflow.js", "hooks/state_checkpoint.py",
    "mods/business/manifest.json"]) {
    const files = snapshot.files.map(file => ({ ...file, bytes: Buffer.from(file.bytes) }))
    const file = files.find(item => item.path === changed)!
    if (changed.endsWith("manifest.json")) {
      const value = JSON.parse(file.bytes.toString("utf8")); value.kernel.version = "1.0.99"
      file.bytes = Buffer.from(JSON.stringify(value))
    } else file.bytes = Buffer.concat([file.bytes, Buffer.from("\n// unreviewed-byte-change")])
    const lockFile = files.find(file => file.path === "devclaw.business-assembly.json")!
    const lock = JSON.parse(lockFile.bytes.toString("utf8"))
    lock.files.find((row: { path: string }) => row.path === changed).digest = sha(file.bytes)
    if (lock.kernel.files.some((row: { path: string }) => row.path === changed))
      lock.kernel.files.find((row: { path: string }) => row.path === changed).digest = sha(file.bytes)
    lockFile.bytes = Buffer.from(JSON.stringify(lock))
    expect(isReviewedAutobizProtocol({ files }), changed).toBe(false)
  }
}, 30000)

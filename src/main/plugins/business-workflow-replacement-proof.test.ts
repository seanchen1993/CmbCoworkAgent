import { createHash } from "node:crypto"
import { expect, it } from "vitest"
import { parseBusinessModCatalog } from "./business-mod-manifest"
import { verifyWorkflowReplacementProof } from "./business-workflow-replacement-proof"

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
        )
      : value

function fixture() {
  const previous = parseBusinessModCatalog({
    apiVersion: "devclaw.business-mods/v1",
    kind: "catalog",
    kernelRef: { id: "reviewed-base", version: "1.0.0" },
    modules: [
      {
        id: "delivery.review",
        title: "审核",
        node: {
          id: "delivery.review",
          skill: "review",
          validators: ["review_contract"],
          guards: [],
          artifacts: { outputs: [{ id: "review", path: "review.json", required: true }] }
        },
        skill: { entry: "skills/review/SKILL.md", resources: ["skills/review/check.py"] },
        resources: ["knowledge/policy.md"],
        dependencies: { required: [], advisory: [] },
        checks: { validators: ["review_contract"], guards: [] }
      }
    ]
  }).modules[0]
  const files = new Map([
    [previous.skill.entry, Buffer.from("# 原技能")],
    [previous.skill.resources[0], Buffer.from("raise ValueError('required-check')")],
    [previous.resources[0], Buffer.from("knowledge-policy")]
  ])
  const reviewed = {
    definitionDigest: sha(JSON.stringify(canonical(previous))),
    files: Object.fromEntries([...files].map(([path, bytes]) => [path, sha(bytes)]))
  }
  const sourceDigest = "a".repeat(64),
    replacementSourceDigest = "b".repeat(64)
  const proof = {
    id: previous.id,
    sourceDigest,
    replacementSourceDigest,
    originalDefinition: previous,
    originalFiles: Object.entries(reviewed.files).map(([path, digest]) => ({ path, digest }))
  }
  const next = structuredClone(previous)
  next.title = "审核（改进）"
  files.set(previous.skill.entry, Buffer.from("# 新技能：仍执行原检查"))
  return {
    proof,
    next,
    files,
    reviewed,
    sourceDigest: replacementSourceDigest,
    sources: [{ digest: sourceDigest }, { digest: replacementSourceDigest }],
    hasDeclaredHooks: true
  }
}

it("admits an authored Skill prompt replacement while retaining all original executable and knowledge pins", () => {
  expect(verifyWorkflowReplacementProof(fixture())).toBe(true)
})

it.each([
  "check-bytes",
  "knowledge-bytes",
  "missing-file",
  "forged-definition",
  "forged-files",
  "stale-source",
  "removed-check",
  "removed-output",
  "extra-field",
  "renamed-hook-skill"
])("rejects a replacement proof with %s", (mutation) => {
  const value = fixture()
  if (mutation === "check-bytes") value.files.set("skills/review/check.py", Buffer.from("pass"))
  if (mutation === "knowledge-bytes") value.files.set("knowledge/policy.md", Buffer.from("changed"))
  if (mutation === "missing-file") value.files.delete("skills/review/check.py")
  if (mutation === "forged-definition") value.proof.originalDefinition.title = "forged"
  if (mutation === "forged-files") value.proof.originalFiles[0].digest = "c".repeat(64)
  if (mutation === "stale-source") value.sourceDigest = "c".repeat(64)
  if (mutation === "removed-check") value.next.checks.validators = []
  if (mutation === "removed-output") value.next.node.artifacts = { outputs: [] }
  if (mutation === "extra-field") Object.assign(value.proof, { approved: true })
  if (mutation === "renamed-hook-skill") {
    value.next.node.skill = "review-improved"
    value.next.skill.entry = "skills/review-improved/SKILL.md"
  }
  expect(verifyWorkflowReplacementProof(value)).toBe(false)
})

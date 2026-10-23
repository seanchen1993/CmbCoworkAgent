import { createHash } from "node:crypto"
import type { BusinessModDefinition } from "../../shared/business-mods"
import { parseBusinessModCatalog } from "./business-mod-manifest"
import {
  assertWorkflowReplacementPreservesChecks,
  assertWorkflowSkillHookIdentity
} from "./business-workflow-transform"

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
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex")

/** A reviewed base remains pinned. Replacement Skills are author code, never reviewed checks. */
export function verifyWorkflowReplacementProof(input: {
  proof: unknown
  next: BusinessModDefinition
  sourceDigest: string
  sources: unknown[]
  files: ReadonlyMap<string, Buffer>
  reviewed: { definitionDigest: string; files: Record<string, string> }
  hasDeclaredHooks: boolean
}): boolean {
  try {
    const proof = input.proof as Record<string, unknown>
    if (
      !proof ||
      typeof proof !== "object" ||
      Array.isArray(proof) ||
      Object.keys(proof).some(
        (key) =>
          ![
            "id",
            "sourceDigest",
            "replacementSourceDigest",
            "originalDefinition",
            "originalFiles"
          ].includes(key)
      ) ||
      proof.id !== input.next.id ||
      proof.replacementSourceDigest !== input.sourceDigest ||
      typeof proof.sourceDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(proof.sourceDigest) ||
      proof.sourceDigest === proof.replacementSourceDigest ||
      !input.sources.some(
        (source) =>
          !!source &&
          typeof source === "object" &&
          (source as Record<string, unknown>).digest === proof.sourceDigest
      )
    )
      return false
    const previous = parseBusinessModCatalog({
      apiVersion: "devclaw.business-mods/v1",
      kind: "catalog",
      kernelRef: { id: "reviewed-base", version: "1.0.0" },
      modules: [proof.originalDefinition]
    }).modules[0]
    if (digest(JSON.stringify(canonical(previous))) !== input.reviewed.definitionDigest)
      return false
    assertWorkflowReplacementPreservesChecks(previous, input.next)
    assertWorkflowSkillHookIdentity(previous, input.next, input.hasDeclaredHooks)
    if (
      !Array.isArray(proof.originalFiles) ||
      proof.originalFiles.length !== Object.keys(input.reviewed.files).length
    )
      return false
    const seen = new Set<string>()
    for (const value of proof.originalFiles) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false
      const row = value as Record<string, unknown>
      if (
        Object.keys(row).some((key) => !["path", "digest"].includes(key)) ||
        typeof row.path !== "string" ||
        typeof row.digest !== "string" ||
        seen.has(row.path) ||
        input.reviewed.files[row.path] !== row.digest
      )
        return false
      seen.add(row.path)
      // Only the original Skill prompt can be replaced. Every original executable check,
      // context/knowledge resource and helper stays byte-identical to the reviewed base.
      if (row.path === previous.skill.entry && row.path.endsWith("/SKILL.md")) continue
      const bytes = input.files.get(row.path)
      if (!bytes || digest(bytes) !== row.digest) return false
    }
    return true
  } catch {
    return false
  }
}

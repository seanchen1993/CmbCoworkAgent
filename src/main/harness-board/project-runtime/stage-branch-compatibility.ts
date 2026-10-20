import { isDeepStrictEqual } from "node:util"
import { isMap, parseDocument } from "yaml"
import type { ProjectRuntimeManifest } from "../../../shared/project-runtime"
import { parseSkillFrontmatter } from "../../skills/frontmatter"
import { readPackageProtocolFiles } from "./package-snapshots"
import { hostStateError } from "./host-state-protocol"

/** The runtime parser tolerates malformed YAML. Debug admission must never reuse that fallback. */
function skillDeclaration(bytes: Buffer): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
    const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/.exec(text)
    const parsed = parseSkillFrontmatter(text)
    if (!header) {
      if (text.startsWith("---")) hostStateError("BRANCH_SKILL_DECLARATION_INVALID")
      return ""
    }
    const document = parseDocument(header[1], { uniqueKeys: true })
    if (document.errors.length || document.warnings.length || !isMap(document.contents))
      hostStateError("BRANCH_SKILL_DECLARATION_INVALID")
    if (!isDeepStrictEqual(document.toJS({ maxAliasCount: 32 }), parsed.frontmatter))
      hostStateError("BRANCH_SKILL_DECLARATION_INVALID")
    // Preserve the exact original declaration, including unknown fields, comments and identity.
    // The existing runtime parser still defines which bytes are the body.
    return text.slice(0, text.length - parsed.body.length)
  } catch {
    return hostStateError("BRANCH_SKILL_DECLARATION_INVALID")
  }
}

/** A conservative reusable boundary, not inferred semantic equivalence or execution authority. */
export function assertStageBranchSourceCompatible(
  originalRoot: string,
  candidateRoot: string,
  original: ProjectRuntimeManifest,
  candidate: ProjectRuntimeManifest,
  stageId: string
): void {
  const index = original.stages.findIndex((stage) => stage.id === stageId)
  if (index < 0) hostStateError("BRANCH_STAGE_MISSING")
  if (JSON.stringify(candidate) !== JSON.stringify(original))
    hostStateError("BRANCH_CONTRACT_CHANGED")
  const mutable = new Set(original.stages.slice(index).map((stage) => stage.skill!))
  for (const stage of original.stages.slice(0, index)) mutable.delete(stage.skill!)
  const files = new Map(
    readPackageProtocolFiles(originalRoot).map((file) => [file.path, file.bytes])
  )
  const revised = readPackageProtocolFiles(candidateRoot)
  if (
    revised.length !== files.size ||
    revised.some(
      (file) =>
        !files.has(file.path) ||
        (mutable.has(file.path)
          ? skillDeclaration(files.get(file.path)!) !== skillDeclaration(file.bytes)
          : !files.get(file.path)!.equals(file.bytes))
    )
  )
    hostStateError("BRANCH_INPUT_SOURCE_CHANGED")
}

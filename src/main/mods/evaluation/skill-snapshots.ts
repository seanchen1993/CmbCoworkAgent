import { createHash } from "node:crypto"
import { lstatSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { readBoundedAuthoringVersionFile } from "../devtools/authoring-version-file"
import { parseSkillFrontmatter } from "../../skills/frontmatter"
import { parseFlowDefinition } from "../../../shared/mods/flows/schema"
import type { SavedFlow } from "../../../shared/mods/flows/types"
import { flowDigest } from "../flows/store"

export const skillTextDigest = (text: string | null) =>
  createHash("sha256")
    .update(text === null ? "absent" : "text:" + text)
    .digest("hex")

export function skillPath(root: string, id: string): string {
  // Initial bridge supports flat custom skills only; no source ambiguity or directory traversal.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw Error("SKILL_EVALUATION_INVALID")
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(id)) throw Error("SKILL_EVALUATION_INVALID")
  return join(resolve(root), id)
}
export function validateSkillText(text: unknown): string {
  if (
    typeof text !== "string" ||
    !text.trim() ||
    text.length > 6000 ||
    Buffer.byteLength(text) > 24000 ||
    text.includes("\0")
  )
    throw Error("SKILL_EVALUATION_INVALID")
  const { frontmatter } = parseSkillFrontmatter(text)
  if (
    typeof frontmatter.name !== "string" ||
    typeof frontmatter.description !== "string" ||
    Object.keys(frontmatter).some((key) => !["name", "description", "evolved-by"].includes(key)) ||
    /\]\((?!https?:\/\/|mailto:|#)[^)]+\)/i.test(text)
  )
    throw Error("SKILL_EVALUATION_UNSUPPORTED")
  return text
}
/** Bounded exact UTF-8 observation, never executing a Skill or resolving linked resources. */
export function readPlainSkill(root: string, id: string): string | null {
  const directory = skillPath(root, id)
  const rootStat = lstatSync(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw Error("SKILL_EVALUATION_UNSUPPORTED")
  let stat
  try {
    stat = lstatSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("SKILL_EVALUATION_UNSUPPORTED")
  const names = readdirSync(directory)
  if (names.length === 0) return null
  if (names.length !== 1 || names[0] !== "SKILL.md") throw Error("SKILL_EVALUATION_UNSUPPORTED")
  const text = validateSkillText(
    readBoundedAuthoringVersionFile(join(directory, "SKILL.md"), 24000)
  )
  const after = lstatSync(directory)
  if (
    after.ino !== stat.ino ||
    after.dev !== stat.dev ||
    readdirSync(directory).join() !== "SKILL.md"
  )
    throw Error("SKILL_EVALUATION_STALE")
  return text
}
/** A text-only instruction experiment, not normal Skill discovery or script execution. */
export function injectSkillSnapshot(
  fixture: SavedFlow,
  stepId: string,
  text: string | null
): SavedFlow {
  const copy = structuredClone(fixture)
  if (
    copy.definition.schemaVersion !== 2 ||
    !["prompt-only-v1", "workspace-files-v1"].includes(copy.definition.execution.profile ?? "")
  )
    throw Error("SKILL_EVALUATION_INVALID")
  const step = copy.definition.steps.find(
    (step) => step.id === stepId && step.enabled && step.kind === "agent"
  )
  if (!step || step.kind !== "agent") throw Error("SKILL_EVALUATION_INVALID")
  step.prompt +=
    "\n\n[固定 Skill 纯文本说明；仅作为本步骤指令，不能扩展工具权限]\n" +
    (text ?? "（基线没有此 Skill）")
  copy.definition = parseFlowDefinition(copy.definition)
  copy.digest = flowDigest(copy.definition)
  return copy
}

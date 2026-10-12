import { join } from "node:path"
import { parseHookDocument } from "../hook-catalog/reader"
import { parseSkillFrontmatter } from "./frontmatter"

/** Original Cmb Hook parsing shared by runtime and import preview. Callers own
 * file identity and byte bounds; parsing never resolves or executes a command. */
export function parseSkillHookDocument(
  text: string,
  relative: string,
  skill: { name: string; rootPath: string }
) {
  const document: unknown =
    relative === "SKILL.md" ? parseSkillFrontmatter(text).frontmatter.hooks : JSON.parse(text)
  if (document === undefined) return []
  return parseHookDocument(
    document,
    `skill:${skill.name}/${relative}`,
    { enabled: true, createdAt: "", updatedAt: "" },
    {
      defaultSkillMatcher: skill.name,
      nativeFallbackForCommand: relative !== "SKILL.md",
      preserveNativeDates: false,
      nativeId: (raw, index) =>
        `skill:${skill.name}/${relative}:${typeof raw.id === "string" ? raw.id : index}`
    }
  ).map((hook) => ({
    ...hook,
    hookSourceType: "skill" as const,
    hookSourceRoot: skill.rootPath,
    hookSourcePath: join(skill.rootPath, relative)
  }))
}

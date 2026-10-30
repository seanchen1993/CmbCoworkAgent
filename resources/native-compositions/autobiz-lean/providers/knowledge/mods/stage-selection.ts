import matter from "./frontmatter.cjs"
import { selectKnowledge, type KnowledgeDocument, type SelectedDeployment } from "./selector"

export function stageMapping(value: unknown, stageId: string): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("AUTOBIZ_KNOWLEDGE_STAGE_MAPPING_REQUIRED:" + stageId)
  const groups = value as Record<string, string[]>
  const entries = Object.entries(groups)
  const valid = (tag: unknown) => typeof tag === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(tag)
  if (
    !entries.length ||
    entries.length > 64 ||
    entries.some(
      ([stage, tags]) =>
        !valid(stage) ||
        !Array.isArray(tags) ||
        !tags.length ||
        tags.length > 32 ||
        tags.some((tag) => !valid(tag)) ||
        new Set(tags).size !== tags.length
    )
  )
    throw Error("AUTOBIZ_KNOWLEDGE_STAGE_MAPPING_INVALID")
  if (!Object.hasOwn(groups, stageId))
    throw Error("AUTOBIZ_KNOWLEDGE_STAGE_MAPPING_REQUIRED:" + stageId)
  return groups
}

/** An absent stage annotation keeps all original selected knowledge. No inferred relevance filter. */
export function selectStageKnowledge(
  documents: KnowledgeDocument[],
  selected: SelectedDeployment[],
  stageId: string,
  stageTags: unknown
) {
  const groups = stageMapping(stageTags, stageId)
  const stages = Object.values(groups).flat()
  const scoped = selectKnowledge(documents, selected)
  const included = new Map<string, KnowledgeDocument>()
  const omitted: string[] = []
  for (const document of scoped) {
    const annotation = matter(document.text).data.autobiz_stages
    if (
      annotation !== undefined &&
      (!Array.isArray(annotation) ||
        !annotation.length ||
        new Set(annotation).size !== annotation.length ||
        annotation.some((stage) => typeof stage !== "string" || !stages.includes(stage)))
    )
      throw Error("AUTOBIZ_KNOWLEDGE_STAGE_ANNOTATION_INVALID:" + document.path)
    if (
      annotation === undefined ||
      (groups[stageId] ?? [stageId]).some((stage) => annotation.includes(stage))
    )
      included.set(document.path, document)
    else omitted.push(document.path)
    // The original selector uses AGENTS as the deployment boundary. Retain that instruction
    // material explicitly, even when every annotated document is for another stage.
    let directory = document.path.includes("/")
      ? document.path.slice(0, document.path.lastIndexOf("/"))
      : ""
    while (true) {
      const path = (directory ? directory + "/" : "") + "AGENTS.md"
      const ancestor = documents.find((item) => item.path === path)
      if (ancestor) {
        included.set(path, ancestor)
        break
      }
      if (!directory) throw Error("AUTOBIZ_KNOWLEDGE_ANCESTOR_AGENTS_MISSING")
      directory = directory.includes("/") ? directory.slice(0, directory.lastIndexOf("/")) : ""
    }
  }
  return { documents: [...included.values()], omitted }
}

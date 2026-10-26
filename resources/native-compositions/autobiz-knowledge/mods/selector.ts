import matter from "./frontmatter.cjs"

export interface KnowledgeDocument {
  path: string
  text: string
}
export interface SelectedDeployment {
  deployUnitId: string
  appType: "frontend" | "backend"
}
export interface SelectedKnowledge extends KnowledgeDocument {
  type: string
  title: string
  description: string
  tags: string[]
  deployUnitIds: string[]
}
function relative(path: string) {
  if (
    !path ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path
      .split("/")
      .some(
        (part) =>
          !part || part === "." || part === ".." || part.startsWith(".") || part === "node_modules"
      ) ||
    !path.endsWith(".md")
  )
    throw Error("AUTOBIZ_KNOWLEDGE_DOCUMENT_PATH_INVALID")
  return path
}
function header(text: string) {
  // The original collector uses YAML frontmatter. Never enable gray-matter JS engines.
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return {}
  if (/!!js(?:\/|:)/i.test(text.slice(0, text.indexOf("\n---", 4))))
    throw Error("AUTOBIZ_KNOWLEDGE_FRONTMATTER_TAG_DENIED")
  const value = matter(text).data
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("AUTOBIZ_KNOWLEDGE_FRONTMATTER_INVALID")
  return value as Record<string, unknown>
}
function titleOf(name: string) {
  name = name
    .replace(/\.md$/i, "")
    .replace(/^local_/i, "")
    .replace(/^local-/i, "")
  return name.match(/[\u4e00-\u9fa5]+/)?.[0] ?? name.replace(/[-_]/g, " ")
}
/** The original deploy-unit/type/nearest-AGENTS selection over Host-owned document bytes. */
export function selectKnowledge(documents: KnowledgeDocument[], selected: SelectedDeployment[]) {
  if (
    !Array.isArray(selected) ||
    !selected.length ||
    selected.length > 32 ||
    selected.some(
      (item) =>
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        Object.keys(item).some((key) => !["deployUnitId", "appType"].includes(key)) ||
        typeof item.deployUnitId !== "string" ||
        !item.deployUnitId.trim() ||
        item.deployUnitId.length > 256 ||
        !["frontend", "backend"].includes(item.appType)
    ) ||
    new Set(selected.map((item) => item.deployUnitId)).size !== selected.length
  )
    throw Error("AUTOBIZ_KNOWLEDGE_SELECTION_INVALID")
  if (documents.length > 512) throw Error("AUTOBIZ_KNOWLEDGE_DOCUMENT_LIMIT")
  const parsed = documents
    .map((document) => ({
      ...document,
      path: relative(document.path),
      header: header(document.text)
    }))
    .sort((a, b) => a.path.localeCompare(b.path, "en"))
  if (new Set(parsed.map((item) => item.path.toLowerCase())).size !== parsed.length)
    throw Error("AUTOBIZ_KNOWLEDGE_PATH_COLLISION")
  const output = new Map<string, SelectedKnowledge>()
  for (const selection of selected) {
    const match = parsed.find((item) => item.header.deploy_unit === selection.deployUnitId)
    if (!match) throw Error("AUTOBIZ_KNOWLEDGE_DEPLOYMENT_MISSING:" + selection.deployUnitId)
    let directory = match.path.includes("/") ? match.path.slice(0, match.path.lastIndexOf("/")) : ""
    let agents: typeof match | undefined
    while (true) {
      agents = parsed.find((item) => item.path === (directory ? directory + "/" : "") + "AGENTS.md")
      if (agents || !directory) break
      directory = directory.includes("/") ? directory.slice(0, directory.lastIndexOf("/")) : ""
    }
    if (!agents) throw Error("AUTOBIZ_KNOWLEDGE_ANCESTOR_AGENTS_MISSING:" + selection.deployUnitId)
    const types = [
      "Product Knowledge",
      "Service Knowledge",
      selection.appType === "frontend" ? "Component Reference" : "Reference"
    ]
    let selectedCount = 0
    for (const document of parsed) {
      if (directory && !document.path.startsWith(directory + "/")) continue
      const info = document.header
      if (
        !types.includes(String(info.type)) ||
        (info.type !== "Product Knowledge" && info.deploy_unit !== selection.deployUnitId)
      )
        continue
      selectedCount++
      const prior = output.get(document.path)
      if (prior) {
        prior.deployUnitIds.push(selection.deployUnitId)
        continue
      }
      output.set(document.path, {
        path: document.path,
        text: document.text,
        type: String(info.type),
        title:
          typeof info.title === "string" ? info.title : titleOf(document.path.split("/").at(-1)!),
        description: typeof info.description === "string" ? info.description : "",
        tags: Array.isArray(info.tags)
          ? info.tags.map(String)
          : typeof info.tags === "string"
            ? info.tags
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean)
            : [],
        deployUnitIds: [selection.deployUnitId]
      })
    }
    if (!selectedCount)
      throw Error("AUTOBIZ_KNOWLEDGE_SELECTED_CONTENT_MISSING:" + selection.deployUnitId)
  }
  return [...output.values()]
}

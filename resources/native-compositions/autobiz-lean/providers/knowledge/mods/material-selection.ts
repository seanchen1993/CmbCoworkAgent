import type { JsonObject, SDK } from "devclaw-mods"

export type MaterialSDK = Pick<SDK, "platform">
// Explicit relative subroots define coverage, never a cached inventory of file names.
// Every call lists the selected subtrees again, so new unannotated files cannot be lost to a stale index.
export function knowledgeRoots(value: unknown): string[] {
  if (value === undefined) return [""]
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 32 ||
    value.some(
      (path) =>
        typeof path !== "string" ||
        path.length > 256 ||
        path.includes("\\") ||
        (path !== "" &&
          path
            .split("/")
            .some(
              (part) =>
                !part || part.startsWith(".") || part === "node_modules" || /[:<>"|?*]/.test(part)
            ))
    )
  )
    throw Error("AUTOBIZ_KNOWLEDGE_ROOTS_INVALID")
  if (
    value.some((left, index) =>
      value.some(
        (right, other) =>
          index !== other &&
          (left.toLowerCase() === right.toLowerCase() ||
            left === "" ||
            right.toLowerCase().startsWith(left.toLowerCase() + "/"))
      )
    )
  )
    throw Error("AUTOBIZ_KNOWLEDGE_ROOTS_OVERLAP")
  return value
}

export interface MaterialResult {
  path?: string
  text?: string
  digest?: string
  entries?: Array<{ kind: string; path: string }>
  nextOffset?: number | null
}
export type MaterialInput = { rootId: string; path?: string; offset?: number; limit?: number }

export async function readMaterial(
  sdk: MaterialSDK,
  requestKey: string,
  action: string,
  input: MaterialInput
): Promise<MaterialResult> {
  const receipt = await sdk.platform.act({
    ref: { provider: "native.project-context", id: "materials", version: "1.0.0" },
    target: { kind: "current" },
    action,
    input: input as JsonObject,
    requestKey
  })
  if (receipt.status !== "succeeded") throw Error("AUTOBIZ_KNOWLEDGE_MATERIAL_UNAVAILABLE")
  if (!receipt.value || typeof receipt.value !== "object" || Array.isArray(receipt.value))
    throw Error("AUTOBIZ_KNOWLEDGE_MATERIAL_INVALID")
  return receipt.value
}

export async function readKnowledge(sdk: MaterialSDK, roots: string[], executionId: string) {
  let sequence = 0
  const documents = new Map<string, { path: string; text: string; digest: string }>()
  const directories = new Map<string, Array<{ kind: string; path: string }>>()
  const read = async (sdk: MaterialSDK, path: string) => {
    if (documents.has(path)) return
    if (documents.size >= 512) throw Error("AUTOBIZ_KNOWLEDGE_DOCUMENT_LIMIT")
    const document = await readMaterial(sdk, executionId + ":materials:" + sequence++, "read", {
      rootId: "knowledge",
      path
    })
    if (
      document.path !== path ||
      typeof document.text !== "string" ||
      typeof document.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(document.digest)
    )
      throw Error("AUTOBIZ_KNOWLEDGE_READ_INVALID")
    documents.set(path, { path, text: document.text, digest: document.digest })
  }
  const list = async (sdk: MaterialSDK, path: string) => {
    if (directories.has(path)) return directories.get(path)!
    if (directories.size >= 512) throw Error("AUTOBIZ_KNOWLEDGE_DIRECTORY_LIMIT")
    const entries: Array<{ kind: string; path: string }> = []
    let offset = 0
    while (true) {
      const page = await readMaterial(sdk, executionId + ":materials:" + sequence++, "list", {
        rootId: "knowledge",
        ...(path ? { path } : {}),
        offset,
        limit: 32
      })
      if (!Array.isArray(page.entries)) throw Error("AUTOBIZ_KNOWLEDGE_LIST_INVALID")
      for (const entry of page.entries) {
        const prefix = path ? path + "/" : ""
        if (
          typeof entry.path !== "string" ||
          !entry.path.startsWith(prefix) ||
          !entry.path.slice(prefix.length) ||
          entry.path.slice(prefix.length).includes("/") ||
          entry.path.includes("\\") ||
          entry.path.split("/").some((part) => part === "." || part === "..") ||
          entries.some((previous) => previous.path.toLowerCase() === entry.path.toLowerCase())
        )
          throw Error("AUTOBIZ_KNOWLEDGE_LIST_INVALID")
        entries.push(entry)
      }
      if (page.nextOffset === null) break
      if (
        typeof page.nextOffset !== "number" ||
        !Number.isInteger(page.nextOffset) ||
        page.nextOffset <= offset ||
        page.nextOffset > 512
      )
        throw Error("AUTOBIZ_KNOWLEDGE_PAGE_INVALID")
      offset = page.nextOffset
    }
    directories.set(path, entries)
    return entries
  }
  for (const root of roots) {
    // Read only ancestor instruction files outside explicit coverage, not sibling document bodies.
    const parts = root.split("/").filter(Boolean)
    for (let depth = 0; depth < parts.length; depth++) {
      const ancestor = parts.slice(0, depth).join("/")
      const agents = (ancestor ? ancestor + "/" : "") + "AGENTS.md"
      if (
        (await list(sdk, ancestor)).some((entry) => entry.kind === "file" && entry.path === agents)
      )
        await read(sdk, agents)
    }
    const pending = [{ path: root, depth: 0 }]
    while (pending.length) {
      const current = pending.pop()!
      if (current.depth > 12) throw Error("AUTOBIZ_KNOWLEDGE_DEPTH_LIMIT")
      // Keep await outside for-of: the supported QuickJS compiler rejects the lowered form.
      const entries = await list(sdk, current.path)
      for (const entry of entries) {
        if (entry.kind === "directory") pending.push({ path: entry.path, depth: current.depth + 1 })
        else if (entry.kind === "file" && entry.path.endsWith(".md")) await read(sdk, entry.path)
      }
    }
  }
  return [...documents.values()]
}

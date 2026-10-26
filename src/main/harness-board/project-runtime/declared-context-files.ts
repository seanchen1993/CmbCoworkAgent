import type { ExtensionContextContract } from "../../../shared/project-runtime"
import { runtimeDigest } from "./safe-files"
import { readScopedContextContent } from "./package-context-content"

/** Host reads only declared, scoped text. This is task data, never executable authority. */
export function readDeclaredContextFiles(input: {
  context: ExtensionContextContract
  snapshotRoot: string
  knowledgeRoot?: string
  stageId?: string
  assertCurrent(): void
}): string {
  input.assertCurrent()
  const files = input.context.provider?.files
  if (!files) throw Error("PROJECT_DECLARED_CONTEXT_REQUIRED")
  let bytes = 0
  const documents = files.filter(file => input.stageId === undefined || !file.stages ||
    file.stages.includes(input.stageId)).map(file => {
    input.assertCurrent()
    const root = file.source === "package" ? input.snapshotRoot : input.knowledgeRoot
    if (!root) throw Error("PROJECT_KNOWLEDGE_REQUIRED")
    const resource = readScopedContextContent(root, file.path, 28_000, file.source === "package")
    if (!resource.bytes?.length || !resource.content?.length) throw Error("PROJECT_DECLARED_CONTEXT_FILE_MISSING")
    bytes += resource.content.length
    if (bytes > 24_000) throw Error("PROJECT_DECLARED_CONTEXT_LIMIT")
    const text = new TextDecoder("utf-8", { fatal: true }).decode(resource.content)
    if (text.includes("\0")) throw Error("PROJECT_DECLARED_CONTEXT_TEXT_INVALID")
    return { source: file.source, path: file.path, digest: runtimeDigest(resource.bytes), text }
  })
  input.assertCurrent()
  const text = JSON.stringify({ protocol: "devclaw.declared-context-files/v1", documents })
  if (Buffer.byteLength(text) > 28_000) throw Error("PROJECT_DECLARED_CONTEXT_LIMIT")
  return text
}

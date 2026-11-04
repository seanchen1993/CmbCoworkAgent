import rehypeHighlight from "rehype-highlight"
import { visit } from "unist-util-visit"
import type { ElementContent, Properties } from "hast"

// The language registry is independent of the document. ReactMarkdown creates a
// processor for each mounted fragment; registering every language there repeats
// substantial work when virtual history rows are recycled. Keep the default
// configuration and per-document tree/file processing, sharing only the registry.
let transform: ReturnType<typeof rehypeHighlight> | undefined

const cache = new Map<string, { serialized: string; bytes: number }>()
const MAX_BYTES = 4 * 1024 * 1024
let bytes = 0

// Only inert syntax tokens are cached. No links, actions, display permission, React
// elements or message identity survive here. Trees are copied before downstream edits.
function createTransform(): ReturnType<typeof rehypeHighlight> {
  const highlight = rehypeHighlight()
  return (tree, file) => {
    visit(tree, "element", (node, _index, parent) => {
      if (node.tagName !== "code" || parent?.type !== "element" || parent.tagName !== "pre")
        return
      const key = JSON.stringify([node.properties.className, node.children])
      const cached = cache.get(key)
      if (cached) {
        cache.delete(key)
        cache.set(key, cached)
        const result = JSON.parse(cached.serialized) as {
          className: Properties["className"]; children: ElementContent[]
        }
        node.properties.className = result.className
        node.children = result.children
        return
      }
      const messages = file.messages.length
      highlight({ type: "root", children: [{ ...parent, children: [node] }] }, file)
      // Diagnostics belong to the current file and source position, so always regenerate them.
      if (file.messages.length !== messages || key.length > 64 * 1024) return
      const serialized = JSON.stringify({ className: node.properties.className, children: node.children })
      const size = (key.length + serialized.length) * 2 + 256
      if (size > 512 * 1024) return
      while (cache.size >= 128 || bytes + size > MAX_BYTES) {
        const oldest = cache.entries().next().value
        if (!oldest) break
        cache.delete(oldest[0])
        bytes -= oldest[1].bytes
      }
      cache.set(key, { serialized, bytes: size })
      bytes += size
    })
  }
}

export function rehypeChatHighlight(): ReturnType<typeof rehypeHighlight> {
  return (transform ??= createTransform())
}

import rehypeHighlight from "rehype-highlight"

// The language registry is independent of the document. ReactMarkdown creates a
// processor for each mounted fragment; registering every language there repeats
// substantial work when virtual history rows are recycled. Keep the default
// configuration and per-document tree/file processing, sharing only the registry.
let transform: ReturnType<typeof rehypeHighlight> | undefined

export function rehypeChatHighlight(): ReturnType<typeof rehypeHighlight> {
  return (transform ??= rehypeHighlight())
}

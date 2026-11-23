import type { Root, RootContent, Text } from "mdast"
import type { VFile } from "vfile"
import type { BotGroupMention } from "../../../shared/bots/contracts"

/** Annotate only bound source ranges. Never turn arbitrary @names or URLs into identities. */
export function remarkBotMentions(options: {
  mentions: readonly BotGroupMention[]
  start: number
}) {
  return (tree: Root, file: VFile) => {
    const source = file.toString()
    const visit = (parent: Root | RootContent): void => {
      if (!("children" in parent) || parent.type === "link" || parent.type === "linkReference")
        return
      for (let index = 0; index < parent.children.length; index++) {
        const child = parent.children[index]
        if (child.type !== "text") {
          visit(child)
          continue
        }
        const sourceStart = child.position?.start.offset
        const sourceEnd = child.position?.end.offset
        if (sourceStart == null || sourceEnd == null) continue
        // Normalization later in a paragraph cannot invalidate an earlier bound name.
        // Compare the prefix once; offsets after an escape/entity still remain untrusted.
        let unchanged = 0
        while (
          unchanged < child.value.length &&
          sourceStart + unchanged < sourceEnd &&
          source[sourceStart + unchanged] === child.value[unchanged]
        )
          unchanged++
        const parts: Text[] = []
        let cursor = 0
        options.mentions.forEach((mention, mentionIndex) => {
          const from = mention.start - options.start - sourceStart
          const to = mention.end - options.start - sourceStart
          if (
            from < cursor ||
            to > unchanged ||
            to <= from ||
            child.value.slice(from, to) !== `@${mention.label}`
          )
            return
          if (from > cursor) parts.push({ type: "text", value: child.value.slice(cursor, from) })
          parts.push({
            type: "text",
            value: child.value.slice(from, to),
            data: {
              hName: "span",
              hProperties: { "data-bot-mention": String(mentionIndex) }
            }
          })
          cursor = to
        })
        if (!parts.length) continue
        if (cursor < child.value.length)
          parts.push({ type: "text", value: child.value.slice(cursor) })
        parent.children.splice(index, 1, ...parts)
        index += parts.length - 1
      }
    }
    visit(tree)
  }
}

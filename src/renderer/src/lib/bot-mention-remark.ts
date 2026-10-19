import type { Root, RootContent, Text } from "mdast"
import type { BotGroupMention } from "../../../shared/bots/contracts"

/** Annotate only bound source ranges. Never turn arbitrary @names or URLs into identities. */
export function remarkBotMentions(options: {
  mentions: readonly BotGroupMention[]
  start: number
}) {
  return (tree: Root) => {
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
        // Escapes/entities change parsed offsets; leave those as text instead of binding the wrong word.
        if (
          sourceStart == null ||
          sourceEnd == null ||
          sourceEnd - sourceStart !== child.value.length
        )
          continue
        const parts: Text[] = []
        let cursor = 0
        options.mentions.forEach((mention, mentionIndex) => {
          const from = mention.start - options.start - sourceStart
          const to = mention.end - options.start - sourceStart
          if (
            from < cursor ||
            to > child.value.length ||
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

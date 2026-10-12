import { memo, type ComponentProps } from "react"
import { StreamingMarkdown } from "../chat/StreamingMarkdown"
import { botMarkdownUrlTransform, remarkBotLiteralLinks } from "@/lib/bot-markdown-links"
import remarkGfm from "remark-gfm"

const BOT_REMARK_PLUGINS = [remarkGfm, remarkBotLiteralLinks]

/** Own the Bot URL policy without widening links in ordinary desktop conversations. */
export const BotMessageMarkdown = memo(function BotMessageMarkdown(
  props: Omit<ComponentProps<typeof StreamingMarkdown>, "urlTransform" | "remarkPlugins">
) {
  return (
    <StreamingMarkdown
      {...props}
      urlTransform={botMarkdownUrlTransform}
      remarkPlugins={BOT_REMARK_PLUGINS}
    />
  )
})

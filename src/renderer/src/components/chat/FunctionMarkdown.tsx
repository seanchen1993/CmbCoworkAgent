import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import remarkGfm from "remark-gfm"
import rehypeHighlight from "rehype-highlight"
import type { Components } from "react-markdown"
import type { FunctionMarkdownLeafProps } from "../../../../shared/mods/v2/markdown"
import {
  functionMarkdownRemark,
  functionMarkdownRehype,
  functionMarkdownUrlTransform
} from "../../../../shared/mods/v2/markdown"
import type {
  FunctionMarkdownLinkAddress,
  FunctionMarkdownLinkSidecar
} from "../../../../shared/mods/v2/markdown-links"
import { functionMarkdownLinkAddressKey } from "../../../../shared/mods/v2/markdown-links"
import {
  closeProtectedFunctionPreviewOwner,
  emitProtectedFunctionPreview
} from "../../lib/protected-function-preview"
import { StaticMarkdownFormatting } from "./StreamingMarkdown"
import { flowDraftId } from "../../lib/flow-draft-id"
import { remarkCompletedMarkdownParseCache } from "../../lib/markdown-parse-cache"

export interface FunctionMarkdownContext {
  threadId: string
  address: FunctionMarkdownLinkAddress
  links: readonly FunctionMarkdownLinkSidecar[]
  refresh?(): void
  isCurrent?(): boolean
}

// Cache only the shared GFM parser. Limits and protected-HTML/link transforms
// still run for every publication, with fresh frame-bound native link handlers.
const REMARK_PLUGINS = [remarkGfm, remarkCompletedMarkdownParseCache, functionMarkdownRemark]
const REHYPE_PLUGINS = [rehypeHighlight, functionMarkdownRehype]

/** Format safe data; the native publication decides which links can cause an action. */
export function FunctionMarkdown({ props: markdown, context, nodePath, busy = false }: {
  props: {
    text: FunctionMarkdownLeafProps["text"]
    key?: FunctionMarkdownLeafProps["key"]
    dimColor?: FunctionMarkdownLeafProps["dimColor"]
    pressableLinks?: FunctionMarkdownLeafProps["pressableLinks"]
  }
  context?: FunctionMarkdownContext
  nodePath: readonly number[]
  busy?: boolean
}): React.JSX.Element {
  const path = JSON.stringify(nodePath)
  const nonce = context?.links.find((item) => JSON.stringify(item.nodePath) === path)?.nonce
  const frame = JSON.stringify([context?.threadId,
    context ? functionMarkdownLinkAddressKey(context.address) : undefined, nonce, markdown.text])
  const current = useRef(frame)
  const mounted = useRef(true)
  const pending = useRef<{ frame: string } | null>(null)
  const deferredRefresh = useRef<string | null>(null)
  const [error, setError] = useState<{ frame: string; message: string } | null>(null)
  const owner = useRef(context)
  useLayoutEffect(() => {
    current.current = frame
    owner.current = context
  }, [frame, context])
  useEffect(() => {
    mounted.current = true
    const visibility = (): void => {
      if (document.hidden) return
      const pending = deferredRefresh.current
      deferredRefresh.current = null
      if (pending === current.current && owner.current?.isCurrent?.() !== false)
        owner.current?.refresh?.()
    }
    document.addEventListener("visibilitychange", visibility)
    return () => {
      mounted.current = false
      document.removeEventListener("visibilitychange", visibility)
    }
  }, [])
  useEffect(() => {
    const captured = owner.current
    return () => {
      if (captured) closeProtectedFunctionPreviewOwner(captured.threadId, captured.address)
    }
  }, [frame])
  const components = useMemo<Components>(() => ({
    a({ href, children }) {
      if (!href || !nonce || !context) return <span>{children}</span>
      return <a href={href} className="text-primary underline underline-offset-2"
        aria-disabled={busy || undefined}
        onClick={(event) => {
          // No browser navigation, modified click or double click bypasses native receipts.
          event.preventDefault()
          if (document.hidden || context.isCurrent?.() === false || busy || pending.current?.frame === frame || event.detail > 1 || event.ctrlKey || event.metaKey ||
            event.altKey || event.shiftKey || window.getSelection()?.toString()) return
          const request = { frame }
          pending.current = request
          setError(null)
          void Promise.resolve().then(() => {
            if (!mounted.current || document.hidden || owner.current?.isCurrent?.() === false || current.current !== frame) return { state: "ignored" } as const
            return window.api.mods.markdownLink(context.threadId, {
              // This cryptographic ID is only a dedup address, never a capability receipt.
              address: context.address, nonce, intentId: flowDraftId("claw"), href
            })
          }).then((outcome) => {
            if (!mounted.current || owner.current?.isCurrent?.() === false || current.current !== frame) return
            if (document.hidden) {
              if (outcome.state === "handled") deferredRefresh.current = frame
              return
            }
            if (outcome.state === "preview") emitProtectedFunctionPreview({
              threadId: context.threadId, preview: outcome.preview, address: context.address
            })
            if (outcome.state === "handled") context.refresh?.()
          }).catch(() => {
            if (mounted.current && !document.hidden && owner.current?.isCurrent?.() !== false && current.current === frame)
              setError({ frame, message: "链接所属的组件已更新或停止，请在当前画面重试。" })
          }).finally(() => { if (pending.current === request) pending.current = null })
        }}
        onAuxClick={(event) => event.preventDefault()}
        onContextMenu={(event) => event.preventDefault()}
        onDragStart={(event) => event.preventDefault()}
      >{children}</a>
    },
    img({ alt }) { return <span>{alt ?? ""}</span> }
  }), [busy, nonce, context, frame])
  return <div data-function-markdown className={markdown.dimColor ? "min-w-0 opacity-65" : "min-w-0"}>
    <StaticMarkdownFormatting text={markdown.text} components={components}
      remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}
      urlTransform={functionMarkdownUrlTransform} />
    {error?.frame === frame && <p role="alert" className="mt-2 text-xs text-destructive">
      {error.message}
    </p>}
  </div>
}

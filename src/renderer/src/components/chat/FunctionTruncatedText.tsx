import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import type { FunctionUiElement } from "../../../../shared/mods/v2/ui"
import { functionTextContent } from "../../lib/function-text-content"

type TextChild = FunctionUiElement | string

/** Preserve text runs and their styles; no HTML slicing or direction tricks. */
function sliceText(children: readonly TextChild[], start: number, end: number): TextChild[] {
  let offset = 0
  const visit = (child: TextChild): TextChild | undefined => {
    if (typeof child === "string") {
      const from = Math.max(0, start - offset),
        to = Math.max(0, end - offset)
      offset += child.length
      return child.slice(from, to)
    }
    if (child.type !== "Text") return undefined
    const props = { ...child.props }
    delete props.wrap
    return {
      ...child,
      props,
      children: (child.children ?? []).flatMap((value) => {
        const sliced = visit(value)
        return sliced === undefined ? [] : [sliced]
      })
    }
  }
  return children.flatMap((child) => {
    const result = visit(child)
    return result === undefined ? [] : [result]
  })
}

export function FunctionTruncatedText({
  runs: children,
  mode,
  render
}: {
  runs: readonly TextChild[]
  mode: string
  render(child: TextChild, index: number): ReactNode
}): React.JSX.Element {
  const host = useRef<HTMLSpanElement>(null)
  const meter = useRef<HTMLSpanElement>(null)
  const ellipsis = useRef<HTMLSpanElement>(null)
  const visible = useRef<HTMLSpanElement>(null)
  const text = functionTextContent(children) ?? ""
  const [bounds, setBounds] = useState({ text, prefix: text.length, suffix: text.length })
  const selected =
    bounds.text === text ? bounds : { text, prefix: text.length, suffix: text.length }
  useLayoutEffect(() => {
    let stopped = false
    const measure = (): void => {
      if (stopped || !host.current || !meter.current || !ellipsis.current) return
      const available = host.current.clientWidth
      if (available <= 0) return
      const walker = document.createTreeWalker(meter.current, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
          node.parentElement?.closest("style") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
      })
      const leaves: Array<{ node: Node; start: number; end: number }> = []
      let length = 0,
        leaf: Node | null
      while ((leaf = walker.nextNode())) {
        const start = length
        length += leaf.textContent?.length ?? 0
        leaves.push({ node: leaf, start, end: length })
      }
      if (length !== text.length) return
      const width = (start: number, end: number): number => {
        if (start >= end) return 0
        const first = leaves.find((value) => value.end > start)
        const last = leaves.find((value) => value.end >= end)
        if (!first || !last) return Infinity
        const range = document.createRange()
        range.setStart(first.node, start - first.start)
        range.setEnd(last.node, end - last.start)
        return range.getBoundingClientRect().width
      }
      const points = [0]
      for (const part of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text))
        points.push(part.index + part.segment.length)
      let prefix = text.length,
        suffix = text.length
      if (width(0, text.length) > available) {
        const mark = ellipsis.current.getBoundingClientRect().width
        let low = 0,
          high = points.length - 1
        const positions = (count: number): [number, number] => {
          if (mode === "truncate-start") return [0, points[points.length - 1 - count]]
          if (mode === "middle" || mode === "truncate-middle")
            return [points[Math.ceil(count / 2)], points[points.length - 1 - Math.floor(count / 2)]]
          return [points[count], text.length]
        }
        while (low < high) {
          const kept = Math.ceil((low + high) / 2)
          const [from, to] = positions(kept)
          if (width(0, from) + mark + width(to, text.length) <= available) low = kept
          else high = kept - 1
        }
        const result = positions(low)
        prefix = result[0]
        suffix = result[1]
      }
      setBounds((prior) =>
        prior.text === text && prior.prefix === prefix && prior.suffix === suffix
          ? prior
          : { text, prefix, suffix }
      )
    }
    const observer = new ResizeObserver(measure)
    if (host.current) observer.observe(host.current)
    if (meter.current) observer.observe(meter.current)
    measure()
    void document.fonts.ready.then(measure)
    return () => {
      stopped = true
      observer.disconnect()
    }
  }, [children, mode, text])
  const complete = sliceText(children, 0, text.length)
  useEffect(() => {
    if (selected.prefix >= selected.suffix) return
    // Native copy may target body. Only expand a complete selection of this one text;
    // leave other elements and partial selections under the browser's normal behavior.
    const copy = (event: ClipboardEvent): void => {
      const node = visible.current,
        owner = host.current,
        selection = window.getSelection()
      if (
        !node ||
        !owner ||
        !selection ||
        selection.rangeCount !== 1 ||
        !event.clipboardData ||
        !owner.contains(selection.anchorNode) ||
        !owner.contains(selection.focusNode)
      )
        return
      const displayed = document.createRange()
      displayed.selectNodeContents(node)
      const range = selection.getRangeAt(0)
      if (
        range.compareBoundaryPoints(Range.START_TO_START, displayed) > 0 ||
        range.compareBoundaryPoints(Range.END_TO_END, displayed) < 0
      )
        return
      event.clipboardData.setData("text/plain", text)
      event.preventDefault()
    }
    document.addEventListener("copy", copy)
    return () => document.removeEventListener("copy", copy)
  }, [text, selected.prefix, selected.suffix])
  return (
    <span
      ref={host}
      data-function-text-truncate={mode}
      aria-label={text}
      style={{ display: "block", position: "relative", minWidth: 0, width: "100%" }}
    >
      <span
        ref={meter}
        aria-hidden
        style={{
          position: "absolute",
          visibility: "hidden",
          whiteSpace: "pre",
          width: "max-content",
          maxWidth: "none",
          pointerEvents: "none",
          userSelect: "none"
        }}
      >
        {complete.map((child, index) => (
          <Fragment key={index}>{render(child, index)}</Fragment>
        ))}
      </span>
      <span ref={ellipsis} aria-hidden style={{ position: "absolute", visibility: "hidden" }}>
        …
      </span>
      {selected.prefix < selected.suffix && (
        <span className="sr-only" style={{ userSelect: "none" }} data-function-text-accessible>
          {text}
        </span>
      )}
      <span
        ref={visible}
        data-function-text-visible
        aria-hidden={selected.prefix < selected.suffix || undefined}
      >
        {sliceText(children, 0, selected.prefix).map((child, index) => (
          <Fragment key={`start-${index}`}>{render(child, index)}</Fragment>
        ))}
        {selected.prefix < selected.suffix && "…"}
        {sliceText(children, selected.suffix, text.length).map((child, index) => (
          <Fragment key={`end-${index}`}>{render(child, index)}</Fragment>
        ))}
      </span>
    </span>
  )
}

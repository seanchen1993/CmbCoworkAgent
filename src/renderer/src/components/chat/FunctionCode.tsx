import { useEffect, useMemo, useRef, useState } from "react"
import type { ModObject } from "../../../../shared/mods/types"
import { functionCodeLanguage, functionCodeRows } from "../../../../shared/mods/v2/code"
import { functionCodeHighlighter } from "../../lib/function-code-highlight"

/** Source is escaped by React or the host's Shiki worker, never treated as plugin HTML. */
export function FunctionCode({ props: values }: { props: ModObject }): React.JSX.Element {
  const source = String(values.source)
  const rows = useMemo(() => functionCodeRows(values), [values])
  const language = functionCodeLanguage(values)
  const highlightOwner = useRef({})
  const [highlighted, setHighlighted] = useState<{ key: string; html: string }>()
  const key = values.format !== "diff" && language ? `${language}\u0000${source}` : undefined
  useEffect(() => {
    if (!key || !language) return
    let live = true
    const request = functionCodeHighlighter.request(highlightOwner.current, source, language)
    void request.promise
      .then((html) => {
        if (live) setHighlighted({ key, html })
      })
      .catch(() => {})
    return () => {
      live = false
      request.cancel()
    }
  }, [highlightOwner, key, language, source])
  const truncate = values.wrap === "truncate-end"
  const numbered = values.format !== "diff" && typeof values.startLine === "number"
  const html = highlighted?.key === key ? highlighted?.html : undefined
  if (html)
    return (
      <div
        className={`shiki-wrapper rounded bg-muted p-2 text-xs font-mono overflow-hidden [&_pre]:!bg-transparent [&_.line]:block ${
          truncate ? "[&_.line]:truncate" : "[&_.line]:whitespace-pre-wrap [&_.line]:break-words"
        } ${numbered ? "[&_.line]:[counter-increment:mod-line] [&_.line]:before:content-[counter(mod-line)] [&_.line]:before:inline-block [&_.line]:before:w-12 [&_.line]:before:pr-3 [&_.line]:before:text-right [&_.line]:before:text-muted-foreground [&_.line]:before:select-none" : ""}`}
        style={numbered ? { counterReset: `mod-line ${Number(values.startLine) - 1}` } : undefined}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  return (
    <div className="overflow-hidden rounded bg-muted p-2 font-mono text-xs">
      {rows.map((row, index) => (
        <div
          key={index}
          data-code-kind={row.kind}
          className={`flex min-w-0 ${row.kind === "add" ? "bg-green-500/10 text-green-700 dark:text-green-300" : row.kind === "remove" ? "bg-red-500/10 text-red-700 dark:text-red-300" : row.kind === "header" ? "text-muted-foreground" : ""}`}
        >
          {values.format === "diff" && row.kind !== "header" && (
            <span
              aria-hidden="true"
              className="w-10 shrink-0 select-none pr-2 text-right text-muted-foreground"
            >
              {row.oldLine}
            </span>
          )}
          {(numbered || (values.format === "diff" && row.kind !== "header")) && (
            <span
              aria-hidden="true"
              className="w-10 shrink-0 select-none pr-2 text-right text-muted-foreground"
            >
              {row.newLine}
            </span>
          )}
          {values.format === "diff" && row.kind !== "header" && (
            <span aria-hidden="true" className="w-4 shrink-0 select-none">
              {row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "}
            </span>
          )}
          <code
            className={`min-w-0 flex-1 ${truncate ? "truncate" : "whitespace-pre-wrap break-words"}`}
          >
            {row.text || " "}
          </code>
        </div>
      ))}
    </div>
  )
}

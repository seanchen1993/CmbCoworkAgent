import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react"
import { Button } from "@/components/ui/button"
import {
  validateFunctionTree,
  validFunctionLink,
  type FunctionPaneSnapshot,
  type FunctionUiElement,
  type FunctionUiAction
} from "../../../../shared/mods/v2/ui"
import type { ModObject } from "../../../../shared/mods/types"

type Act = (
  node: FunctionUiElement | undefined,
  kind: FunctionUiAction["kind"],
  value?: string
) => Promise<void>

function Field({ node, busy, act }: { node: FunctionUiElement; busy: boolean; act: Act }) {
  const [value, setValue] = useState(String(node.props.value ?? ""))
  const label = String(node.props.label ?? node.props.key)
  if (node.type === "Select")
    return (
      <label className="flex items-center gap-2 text-sm">
        {label}
        <select
          aria-label={label}
          value={value}
          disabled={busy}
          className="rounded border bg-background p-1"
          onChange={(event) => {
            setValue(event.target.value)
            void act(node, "select", event.target.value)
          }}
        >
          {(node.props.options as ModObject[]).map((option) => (
            <option key={String(option.value)} value={String(option.value)}>
              {String(option.label)}
            </option>
          ))}
        </select>
      </label>
    )
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        void act(node, "submit", value)
      }}
    >
      <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
        {label}
        <input
          aria-label={label}
          value={value}
          maxLength={10000}
          disabled={busy}
          placeholder={String(node.props.placeholder ?? "")}
          className="min-w-0 flex-1 rounded border bg-background px-2 py-1"
          onChange={(event) => {
            setValue(event.target.value)
            void act(node, "change", event.target.value)
          }}
        />
      </label>
      <Button type="submit" variant="outline" size="sm" disabled={busy}>
        {String(node.props.submitLabel ?? "提交")}
      </Button>
    </form>
  )
}

function style(node: FunctionUiElement): CSSProperties {
  const p = node.props
  if (node.type === "Text")
    return {
      color: typeof p.color === "string" ? p.color : undefined,
      backgroundColor: typeof p.backgroundColor === "string" ? p.backgroundColor : undefined,
      fontWeight: p.bold ? "bold" : undefined,
      fontStyle: p.italic ? "italic" : undefined,
      textDecoration: [p.underline && "underline", p.strikethrough && "line-through"]
        .filter(Boolean)
        .join(" "),
      opacity: p.dimColor ? 0.65 : undefined,
      whiteSpace: p.wrap === "truncate-end" ? "nowrap" : "pre-wrap",
      textOverflow: p.wrap === "truncate-end" ? "ellipsis" : undefined,
      overflow: p.wrap === "truncate-end" ? "hidden" : undefined,
      overflowWrap: "anywhere"
    }
  const dimension = (key: string): number | undefined =>
    typeof p[key] === "number" ? (p[key] as number) * 8 : undefined
  return {
    display: "flex",
    flexDirection: p.flexDirection === "column" ? "column" : "row",
    flexWrap: "wrap",
    gap: dimension("gap"),
    padding: dimension("padding"),
    paddingInline: dimension("paddingX"),
    paddingBlock: dimension("paddingY"),
    margin: dimension("margin"),
    marginInline: dimension("marginX"),
    marginBlock: dimension("marginY"),
    alignItems: ["flex-start", "center", "flex-end", "stretch"].includes(String(p.alignItems))
      ? String(p.alignItems)
      : undefined,
    justifyContent: ["flex-start", "center", "flex-end", "space-between", "space-around"].includes(
      String(p.justifyContent)
    )
      ? String(p.justifyContent)
      : undefined,
    border: p.borderStyle ? "1px solid var(--border)" : undefined,
    width:
      typeof p.width === "number"
        ? `${p.width}ch`
        : typeof p.width === "string"
          ? p.width
          : undefined,
    height:
      typeof p.height === "number"
        ? `${p.height}lh`
        : typeof p.height === "string"
          ? p.height
          : undefined
  }
}

function Element({
  node,
  busy,
  act
}: {
  node: FunctionUiElement | string
  busy: boolean
  act: Act
}): React.ReactNode {
  if (typeof node === "string") return node
  const p = node.props
  if (node.type === "Box" || node.type === "Text") {
    const Tag = node.type === "Box" ? "div" : "span"
    return (
      <Tag style={style(node)}>
        {node.children?.map((child, index) => (
          <Element key={index} node={child} busy={busy} act={act} />
        ))}
      </Tag>
    )
  }
  if (node.type === "Button")
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        className={p.dimColor ? "opacity-65" : undefined}
        onClick={() => void act(node, "press")}
      >
        {String(p.label)}
      </Button>
    )
  if (node.type === "Input" || node.type === "Select")
    return <Field node={node} busy={busy} act={act} />
  if (node.type === "Link")
    return (
      <a
        href={String(p.href)}
        className="underline text-primary"
        onClick={(event) => {
          event.preventDefault()
          if (validFunctionLink(p.href)) void window.electron.openExternal(p.href)
        }}
      >
        {node.children?.length
          ? node.children.map((child, index) => (
              <Element key={index} node={child} busy={busy} act={act} />
            ))
          : String(p.label ?? p.href)}
      </a>
    )
  if (node.type === "Code")
    return (
      <pre className="overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
        <code>{String(p.source)}</code>
      </pre>
    )
  return null
}

export function FunctionPanes({ threadId }: { threadId: string }): React.JSX.Element | null {
  const [panes, setPanes] = useState<FunctionPaneSnapshot[]>([])
  const [busy, setBusy] = useState(false)
  const pending = useRef(0)
  const [error, setError] = useState("")
  const refreshRef = useRef<() => void>(() => {})
  useEffect(() => {
    let live = true
    let sequence = 0
    const refresh = (): void => {
      const request = ++sequence
      void window.api.mods
        .panes(threadId)
        .then((rows) => {
          if (!live || request !== sequence) return
          for (const row of rows) validateFunctionTree(row.tree)
          setPanes(rows)
        })
        .catch(() => {
          if (live && request === sequence) setPanes([])
        })
    }
    refreshRef.current = refresh
    const stop = window.api.mods.onCardsChanged((event) => {
      if (event.threadId === threadId) refresh()
    })
    window.addEventListener("mods:configuration-changed", refresh)
    refresh()
    return () => {
      live = false
      stop()
      window.removeEventListener("mods:configuration-changed", refresh)
    }
  }, [threadId])
  const act = useCallback(
    async (
      pane: FunctionPaneSnapshot,
      node: FunctionUiElement | undefined,
      kind: FunctionUiAction["kind"],
      value?: string
    ) => {
      pending.current++
      if (kind !== "change") setBusy(true)
      setError("")
      try {
        await window.api.mods.paneAct(threadId, {
          pane: pane.key,
          generation: pane.generation,
          intentId: crypto.randomUUID(),
          plugin: node?.press?.plugin ?? pane.plugin,
          handle: node?.press?.handle ?? 0,
          kind,
          ...(value === undefined ? {} : { value })
        })
        if (kind !== "change") refreshRef.current()
      } catch (cause) {
        setError(
          String(cause).includes("MODS_UI_STALE_ACTION")
            ? "面板已更新，请在当前面板重新操作。"
            : "面板操作未完成，请检查插件或重新打开面板。"
        )
        refreshRef.current()
      } finally {
        pending.current--
        if (pending.current === 0) setBusy(false)
      }
    },
    [threadId]
  )
  if (!panes.length && !error) return null
  return (
    <div className="mx-auto my-2 w-full max-w-3xl space-y-2" data-function-panes>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {panes.map((pane) => (
        <section
          key={pane.key}
          data-function-pane={pane.id}
          className="rounded-lg border bg-background p-3"
          onKeyDown={(event) => {
            if (event.key === "Escape" && pane.closeOnEscape) {
              event.stopPropagation()
              void act(pane, undefined, "close")
            }
          }}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">{pane.title}</h3>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-label={`关闭 ${pane.title}`}
              onClick={() => void act(pane, undefined, "close")}
            >
              关闭
            </Button>
          </div>
          <div
            className="overflow-auto text-sm"
            style={{ maxHeight: Math.min(pane.rows * 24, 480) }}
          >
            <Element
              key={pane.generation}
              node={pane.tree}
              busy={busy}
              act={(node, kind, value) => act(pane, node, kind, value)}
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">由 {pane.plugin} 提供</p>
        </section>
      ))}
    </div>
  )
}

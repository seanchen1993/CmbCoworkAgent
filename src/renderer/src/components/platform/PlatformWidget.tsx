import { useState } from "react"
import type { FunctionUiNode } from "../../../../shared/mods/v2/ui"
import type { ModObject } from "../../../../shared/mods/types"
import {
  platformFormValues,
  validatePlatformWidget,
  type PlatformWidget as WidgetType
} from "../../../../shared/mods/v2/platform-surfaces-widgets"

export function PlatformWidget({
  node,
  busy,
  keepFormDraftEditable,
  submit
}: {
  node: FunctionUiNode
  busy: boolean
  keepFormDraftEditable?: boolean
  submit(value: string): Promise<void>
}): React.JSX.Element {
  const type = node.type as WidgetType,
    p = node.props
  validatePlatformWidget(type, p)
  if (type === "Form")
    return (
      <PlatformForm
        node={node}
        busy={busy}
        keepFormDraftEditable={keepFormDraftEditable}
        submit={submit}
      />
    )
  const title = p.label ? <h3 className="mb-2 font-medium">{String(p.label)}</h3> : null
  if (type === "List")
    return (
      <section>
        {title}
        <ul className="divide-y rounded border">
          {(p.items as ModObject[]).map((item, i) => (
            <li key={`${String(item.id)}:${i}`} className="p-2">
              <div>{String(item.label)}</div>
              {item.detail && (
                <small className="text-muted-foreground">{String(item.detail)}</small>
              )}
            </li>
          ))}
        </ul>
      </section>
    )
  if (type === "Table")
    return (
      <section className="overflow-x-auto">
        {title}
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr>
              {(p.columns as ModObject[]).map((column) => (
                <th className="border-b p-2" key={String(column.key)}>
                  {String(column.label)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(p.rows as ModObject[]).map((row, i) => (
              <tr key={i}>
                {(p.columns as ModObject[]).map((column) => (
                  <td className="border-b p-2" key={String(column.key)}>
                    {String(row[String(column.key)] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    )
  if (type === "Tree") {
    const tree = (items: ModObject[]): React.ReactNode => (
      <ul className="ml-3 space-y-1 border-l pl-3">
        {items.map((item, i) => (
          <li key={`${String(item.id)}:${i}`}>
            {Array.isArray(item.children) && item.children.length ? (
              <details>
                <summary>{String(item.label)}</summary>
                {tree(item.children as ModObject[])}
              </details>
            ) : (
              String(item.label)
            )}
          </li>
        ))}
      </ul>
    )
    return (
      <section>
        {title}
        {tree(p.items as ModObject[])}
      </section>
    )
  }
  if (type === "Chart") {
    const points = p.series as ModObject[],
      max = Math.max(1, ...points.map((point) => Math.abs(Number(point.value))))
    return (
      <section aria-label={String(p.label ?? "图表")}>
        {title}
        <ul className="space-y-2">
          {points.map((point, i) => (
            <li key={i}>
              <div className="flex justify-between text-sm">
                <span>{String(point.label)}</span>
                <span>{Number(point.value)}</span>
              </div>
              <div className="h-2 rounded bg-muted">
                <div
                  className="h-full rounded bg-primary"
                  style={{ width: `${(Math.abs(Number(point.value)) / max) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      </section>
    )
  }
  return (
    <section>
      {title}
      <div role="log" className="max-h-80 overflow-y-auto rounded border p-2 font-mono text-xs">
        {(p.entries as ModObject[]).map((entry, i) => (
          <div
            key={`${String(entry.id)}:${i}`}
            className={
              entry.level === "error"
                ? "text-destructive"
                : entry.level === "warning"
                  ? "text-amber-600"
                  : ""
            }
          >
            {String(entry.text)}
          </div>
        ))}
      </div>
    </section>
  )
}

function PlatformForm({
  node,
  busy,
  keepFormDraftEditable,
  submit
}: {
  node: FunctionUiNode
  busy: boolean
  keepFormDraftEditable?: boolean
  submit(value: string): Promise<void>
}) {
  const p = node.props,
    source = JSON.stringify(p.values)
  const [state, setState] = useState({ source, values: p.values as ModObject })
  const [error, setError] = useState("")
  if (state.source !== source) setState({ source, values: p.values as ModObject })
  const values = state.source === source ? state.values : (p.values as ModObject)
  const set = (name: string, value: string | number) =>
    setState({ source, values: { ...values, [name]: value } })
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (busy) return
        try {
          const text = JSON.stringify(values)
          platformFormValues(p, text)
          setError("")
          void submit(text).catch(() => setError("保存未完成，请核对后重试"))
        } catch {
          setError("请检查必填项和字段格式")
        }
      }}
    >
      {p.label && <h3 className="font-medium">{String(p.label)}</h3>}
      {(p.fields as ModObject[]).map((field) => (
        <label key={String(field.name)} className="grid gap-1 text-sm">
          {String(field.label)}
          {field.type === "select" ? (
            <select
              disabled={busy && !keepFormDraftEditable}
              required={field.required === true}
              className="devclaw-select"
              value={String(values[String(field.name)] ?? "")}
              onChange={(event) => set(String(field.name), event.target.value)}
            >
              <option value="">请选择</option>
              {(field.options as string[]).map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
          ) : (
            <input
              disabled={busy && !keepFormDraftEditable}
              required={field.required === true}
              type={field.type === "number" ? "number" : "text"}
              maxLength={2000}
              className="devclaw-input"
              value={String(values[String(field.name)] ?? "")}
              onChange={(event) =>
                set(
                  String(field.name),
                  field.type === "number" && event.target.value !== ""
                    ? Number(event.target.value)
                    : event.target.value
                )
              }
            />
          )}
        </label>
      ))}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy} className="rounded border px-3 py-2">
        {String(p.submitLabel ?? "保存")}
      </button>
    </form>
  )
}

import { parameterFields, parameterNumber, type ParameterDraft } from "@/lib/flow-parameter-form"
import type { ModJson, ModObject } from "../../../../shared/mods/types"
import { StringArrayParameter } from "./StringArrayParameter"

/** Simple forms keep required fields editable and never require a JSON detour. */
export function SimpleActionParameters({
  title,
  value,
  schema,
  draft,
  allowMissing = false,
  onChange,
  onDraftChange
}: {
  title: string
  value: ModObject
  schema?: ModObject
  draft?: ParameterDraft
  allowMissing?: boolean
  onChange(value: ModObject): void
  onDraftChange(value: ParameterDraft): void
}) {
  const fields = parameterFields(schema)
  const other = Object.keys(value).filter((key) => !fields.some((field) => field.key === key))
  const update = (key: string, next: ModJson | undefined) => {
    const result = { ...value }
    if (next === undefined) delete result[key]
    else result[key] = next
    const errors = { ...draft?.numberErrors }
    const numbers = { ...draft?.numbers }
    delete errors[key]
    delete numbers[key]
    onDraftChange({ ...draft, dirty: true, numbers, numberErrors: errors })
    onChange(result)
  }
  return (
    <section aria-label={title} className="space-y-3">
      {fields.length === 0 && <p className="text-xs text-muted-foreground">无需填写参数。</p>}
      {fields.map((field) => {
        const set = Object.hasOwn(value, field.key)
        const required = field.required && !allowMissing
        const enabled = set || required
        const actual = value[field.key]
        const label = `${title} · ${field.title}`
        const inputClass = "devclaw-input w-full min-w-0 text-sm"
        return (
          <div key={field.key} className="grid min-w-0 gap-1">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                {field.title}
                {required ? "（必填）" : "（可选）"}
              </span>
              {!required && (
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    aria-label={`设置 ${label}`}
                    checked={set}
                    onChange={(event) =>
                      update(
                        field.key,
                        event.target.checked
                          ? (field.enum?.[0] ??
                              (field.type === "array" ? [] : field.type === "string" ? "" : field.type === "boolean" ? false : 0))
                          : undefined
                      )
                    }
                  />
                  设置
                </label>
              )}
            </div>
            {field.type === "array" ? <StringArrayParameter label={label} value={actual}
              schema={field.schema} disabled={!enabled} onChange={(next) => update(field.key, next)} /> : field.enum ? (
              <select
                aria-label={label}
                className="devclaw-select w-full min-w-0 text-sm"
                disabled={!enabled}
                value={set ? String(field.enum.findIndex((item) => item === actual)) : ""}
                onChange={(event) => update(field.key, field.enum![Number(event.target.value)])}
              >
                <option value="">请选择</option>
                {field.enum.map((item, index) => (
                  <option key={index} value={index}>
                    {String(item)}
                  </option>
                ))}
              </select>
            ) : field.type === "boolean" ? (
              <select
                aria-label={label}
                className="devclaw-select w-full min-w-0 text-sm"
                disabled={!enabled}
                value={set ? String(actual) : ""}
                onChange={(event) => update(field.key, event.target.value === "true")}
              >
                <option value="">请选择</option>
                <option value="true">是</option>
                <option value="false">否</option>
              </select>
            ) : (
              <input
                aria-label={label}
                className={inputClass}
                disabled={!enabled}
                inputMode={field.type === "string" ? "text" : "decimal"}
                value={draft?.numbers?.[field.key] ?? (set ? String(actual) : "")}
                onChange={(event) => {
                  const raw = event.target.value
                  if (field.type === "string") update(field.key, raw)
                  else {
                    const number = parameterNumber(raw, field.type === "integer")
                    if (number !== undefined) update(field.key, number)
                    else
                      onDraftChange({
                        ...draft,
                        dirty: true,
                        numbers: { ...draft?.numbers, [field.key]: raw },
                        numberErrors: {
                          ...draft?.numberErrors,
                          [field.key]: `${field.title}：请输入完整数字。`
                        }
                      })
                  }
                }}
              />
            )}
            {field.description && (
              <p className="text-xs text-muted-foreground">{field.description}</p>
            )}
          </div>
        )
      })}
      {!!other.length && (
        <details className="text-sm">
          <summary className="cursor-pointer">其他保留字段（只读，{other.length} 项）</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg border p-2 text-xs">
            {JSON.stringify(Object.fromEntries(other.map((key) => [key, value[key]])), null, 2)}
          </pre>
          <p className="mt-1 text-xs text-muted-foreground">
            这些字段完整保留，也会作为固定输入。请在高级编辑中修改。
          </p>
        </details>
      )}
    </section>
  )
}

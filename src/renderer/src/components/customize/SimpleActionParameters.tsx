import { parameterFields, parameterNumber, type ParameterDraft } from "@/lib/flow-parameter-form"
import type { ModJson, ModObject } from "../../../../shared/mods/types"

/** Simple forms keep required fields editable and never require a JSON detour. */
export function SimpleActionParameters({
  title,
  value,
  schema,
  draft,
  onChange,
  onDraftChange
}: {
  title: string
  value: ModObject
  schema?: ModObject
  draft?: ParameterDraft
  onChange(value: ModObject): void
  onDraftChange(value: ParameterDraft): void
}) {
  const fields = parameterFields(schema)
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
        const enabled = set || field.required
        const actual = value[field.key]
        const label = `${title} · ${field.title}`
        const inputClass =
          "w-full min-w-0 rounded-lg border bg-background p-2 text-sm disabled:opacity-50"
        return (
          <div key={field.key} className="grid min-w-0 gap-1">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                {field.title}
                {field.required ? "（必填）" : "（可选）"}
              </span>
              {!field.required && (
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
                              (field.type === "string" ? "" : field.type === "boolean" ? false : 0))
                          : undefined
                      )
                    }
                  />
                  设置
                </label>
              )}
            </div>
            {field.enum ? (
              <select
                aria-label={label}
                className={inputClass}
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
                className={inputClass}
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
    </section>
  )
}

import { useMemo } from "react"
import { Button } from "@/components/ui/button"
import {
  parameterError,
  parameterFields,
  parameterNumber,
  parseParameterObject,
  type ParameterDraft
} from "@/lib/flow-parameter-form"
import type { ModObject, ModJson } from "../../../../shared/mods/types"

const fieldClass =
  "w-full min-w-0 rounded-lg border bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/20"

export function FlowParameterEditor({
  title,
  value,
  schema,
  draft,
  allowMissing,
  validateSchema = true,
  sourceMissing,
  onChange,
  onDraftChange
}: {
  title: string
  value: ModObject
  schema?: ModObject
  draft?: ParameterDraft
  allowMissing?: boolean | string[]
  validateSchema?: boolean
  sourceMissing?: boolean
  onChange(value: ModObject): void
  onDraftChange(value: ParameterDraft): void
}) {
  const fields = useMemo(() => parameterFields(schema), [schema])
  const mode = draft?.mode ?? (fields.length ? "form" : "json")
  const error = parameterError(value, schema, draft, allowMissing, validateSchema)
  const covered = new Set(fields.map((field) => field.key))
  const other = Object.keys(value).filter((key) => !covered.has(key))
  const update = (key: string, next: ModJson | undefined, raw?: string) => {
    const numbers = { ...draft?.numbers }
    const numberErrors = { ...draft?.numberErrors }
    delete numberErrors[key]
    if (raw === undefined) delete numbers[key]
    else numbers[key] = raw
    onDraftChange({ ...draft, json: undefined, numbers, numberErrors, dirty: true })
    const result = { ...value }
    if (next === undefined) delete result[key]
    else result[key] = next
    onChange(result)
  }
  return (
    <section
      role="region"
      aria-label={`${title}参数`}
      className="min-w-0 space-y-3 rounded-xl border bg-background/60 p-3 sm:p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-medium">{title}</h4>
          <p className="text-xs text-muted-foreground">只修改你设置的参数，其他内容完整保留。</p>
        </div>
        <div className="flex flex-wrap gap-1">
          <Button
            type="button"
            size="sm"
            variant={mode === "form" ? "secondary" : "ghost"}
            disabled={!fields.length}
            aria-label={`${title}：表单`}
            onClick={() => onDraftChange({ ...draft, mode: "form" })}
          >
            表单
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "json" ? "secondary" : "ghost"}
            aria-label={`${title}：JSON`}
            onClick={() => onDraftChange({ ...draft, mode: "json" })}
          >
            高级 JSON
          </Button>
        </div>
      </div>
      {sourceMissing && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          所选来源的版本不在当前目录中。参数保持原样；请刷新目录并重新选择来源，核对后再使用表单。
        </p>
      )}
      {!fields.length && (
        <p className="text-xs text-muted-foreground">
          此来源没有可直接编辑的简单参数声明，请使用 JSON；不会根据名称猜测字段。
        </p>
      )}
      {(allowMissing === true || (Array.isArray(allowMissing) && allowMissing.length > 0)) && (
        <p className="text-xs text-muted-foreground">
          必填输入可以由前一步补齐。运行时合并并校验，上方固定输入覆盖同名输出。
        </p>
      )}
      {!validateSchema && (
        <p className="text-xs text-muted-foreground">
          此步骤已停用，参数可留待启用前配置；尚未完成的 JSON 或数字草稿仍需修正。
        </p>
      )}
      {mode === "json" || !fields.length ? (
        <label className="grid gap-1 text-xs">
          {title}（JSON 对象）
          <textarea
            className={`${fieldClass} font-mono`}
            rows={5}
            aria-label={title}
            aria-invalid={!!error}
            value={draft?.json ?? JSON.stringify(value, null, 2)}
            onChange={(event) => {
              const json = event.target.value
              onDraftChange({ ...draft, json, numbers: {}, numberErrors: {}, dirty: true })
              const parsed = parseParameterObject(json)
              if (parsed) onChange(parsed)
            }}
          />
        </label>
      ) : (
        <div className="space-y-3">
          {draft?.json !== undefined && !parseParameterObject(draft.json) ? (
            <p className="text-sm text-destructive">
              高级 JSON 草稿尚未完成。请回到高级 JSON 修正，表单暂时保留上一份有效值。
            </p>
          ) : (
            fields.map((field) => {
              const present = Object.hasOwn(value, field.key)
              const actual = value[field.key]
              const label = `${title} · ${field.title}`
              const mismatch =
                present &&
                (field.type === "integer"
                  ? typeof actual !== "number" || !Number.isSafeInteger(actual)
                  : typeof actual !== field.type)
              const inputClass = `${fieldClass} disabled:opacity-50`
              return (
                <div key={field.key} className="min-w-0 space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-medium">
                      {field.title}{" "}
                      <span className="font-normal text-muted-foreground">
                        {field.required ? "必填" : "可选"} · {field.type}
                      </span>
                    </span>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        aria-label={`设置 ${label}`}
                        checked={present}
                        onChange={(event) =>
                          update(
                            field.key,
                            event.target.checked
                              ? (field.enum?.[0] ??
                                  (field.type === "string"
                                    ? ""
                                    : field.type === "boolean"
                                      ? false
                                      : 0))
                              : undefined
                          )
                        }
                      />
                      设置此参数
                    </label>
                  </div>
                  {mismatch ? (
                    <p className="break-words text-xs text-destructive">
                      原值 {JSON.stringify(actual)} 与类型不符，已保留。请用高级 JSON
                      修正，或取消后重新设置。
                    </p>
                  ) : field.enum ? (
                    <select
                      className={inputClass}
                      aria-label={label}
                      disabled={!present}
                      value={present ? String(field.enum.findIndex((item) => item === actual)) : ""}
                      onChange={(event) =>
                        update(field.key, field.enum![Number(event.target.value)])
                      }
                    >
                      {!present && <option value="">未设置</option>}
                      {present && !field.enum.some((item) => item === actual) && (
                        <option value="-1">原值不在枚举中：{JSON.stringify(actual)}</option>
                      )}
                      {field.enum.map((item, index) => (
                        <option key={index} value={index}>
                          {typeof item === "string" ? item || "空字符串" : String(item)}
                        </option>
                      ))}
                    </select>
                  ) : field.type === "boolean" ? (
                    <select
                      className={inputClass}
                      aria-label={label}
                      disabled={!present}
                      value={present ? String(actual) : ""}
                      onChange={(event) => update(field.key, event.target.value === "true")}
                    >
                      {!present && <option value="">未设置</option>}
                      <option value="true">是（true）</option>
                      <option value="false">否（false）</option>
                    </select>
                  ) : (
                    <input
                      className={inputClass}
                      aria-label={label}
                      disabled={!present}
                      inputMode={field.type === "string" ? "text" : "decimal"}
                      value={present ? (draft?.numbers?.[field.key] ?? String(actual)) : ""}
                      placeholder={present ? undefined : "未设置"}
                      onChange={(event) => {
                        const text = event.target.value
                        if (field.type === "string") update(field.key, text)
                        else {
                          const number = parameterNumber(text, field.type === "integer")
                          if (number !== undefined) update(field.key, number, text)
                          else
                            onDraftChange({
                              ...draft,
                              json: undefined,
                              numbers: { ...draft?.numbers, [field.key]: text },
                              numberErrors: {
                                ...draft?.numberErrors,
                                [field.key]: `${field.title}：数字草稿尚未完成，请修正后保存或运行。`
                              },
                              dirty: true
                            })
                        }
                      }}
                    />
                  )}
                  {field.description && (
                    <p className="whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
                      {field.description}
                    </p>
                  )}
                </div>
              )
            })
          )}
          {other.length > 0 && (
            <p className="break-words text-xs text-muted-foreground">
              另有 {other.length} 个字段完整保留：{other.join("、")}。在高级 JSON 中查看或修改。
            </p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="break-words text-xs text-destructive">
          {title}：{error}
        </p>
      )}
    </section>
  )
}

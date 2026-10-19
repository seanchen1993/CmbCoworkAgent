import type { ModJson, ModObject } from "../../../../shared/mods/types"

/** Edit individual strings without splitting, trimming or silently discarding existing values. */
export function StringArrayParameter({ label, value, schema, disabled, onChange }: {
  label: string
  value: ModJson | undefined
  schema: ModObject
  disabled: boolean
  onChange(value: string[]): void
}) {
  if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string")))
    return <p role="alert" className="text-xs text-destructive">
      原值与字符串列表类型不符，已保留。请在高级 JSON 中修正，或取消后重新设置。
    </p>
  const values = (value ?? []) as string[]
  const max = typeof schema.maxItems === "number" ? Math.min(schema.maxItems, 128) : 128
  return <fieldset disabled={disabled} className="space-y-2">
    {values.map((item, index) => <div key={index} className="flex min-w-0 gap-2">
      <textarea rows={1} aria-label={`${label} · 第${index + 1}项`} className="devclaw-input min-w-0 flex-1 text-sm"
        value={item} onChange={(event) => onChange(values.map((old, i) => i === index ? event.target.value : old))} />
      <button type="button" aria-label={`移除 ${label} · 第${index + 1}项`}
        className="shrink-0 rounded border px-2 text-xs" onClick={() => onChange(values.filter((_, i) => i !== index))}>移除</button>
    </div>)}
    <button type="button" aria-label={`添加 ${label}`} disabled={values.length >= max}
      className="rounded border px-2 py-1 text-xs disabled:opacity-50"
      onClick={() => onChange([...values, ""])}>添加一项</button>
  </fieldset>
}

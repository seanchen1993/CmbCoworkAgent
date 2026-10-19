import { isDeepStrictEqual } from "node:util"
import { mergeUpdatedInput } from "./updated-input"

export interface HookInputMergeSource {
  hookId: string
  order: number
  pluginId?: string
}
export interface HookInputMergeDiagnostic {
  field: string
  previous: HookInputMergeSource
  current: HookInputMergeSource
  resolution: "later-hook-wins"
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
const emptyObject = (value: unknown) => object(value) && !Object.keys(value).length
const label = (value: string, max: number) => {
  // eslint-disable-next-line no-control-regex -- User keys may contain controls; never emit them.
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ")
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean
}

/** Observations only. Ordinary deep-merge behavior and final native checks remain authoritative. */
export class HookInputMergeTracker {
  private applied: Record<string, unknown> = {}
  private readonly writes = new Map<string, { value: unknown; source: HookInputMergeSource }>()
  private nextOrder = 0
  readonly order: HookInputMergeSource[] = []
  readonly diagnostics: HookInputMergeDiagnostic[] = []
  truncated = false

  observe(hookId: string, patch: Record<string, unknown>, pluginId?: string) {
    const clean = mergeUpdatedInput({}, patch)
    if (!Object.keys(clean).length) return []
    const source = {
      hookId: label(hookId, 160),
      order: ++this.nextOrder,
      ...(pluginId ? { pluginId: label(pluginId, 160) } : {})
    }
    if (hookId.length > 160 || (pluginId?.length ?? 0) > 160) this.truncated = true
    if (this.order.length < 128) this.order.push(source)
    else this.truncated = true
    const added: HookInputMergeDiagnostic[] = []
    const visit = (value: unknown, before: unknown, path: string, depth: number) => {
      if (depth > 32 || path.length > 1024) {
        this.truncated = true
        return
      }
      if (object(value) && Object.keys(value).length) {
        for (const [key, child] of Object.entries(value))
          visit(
            child,
            object(before) ? before[key] : undefined,
            path + "/" + key.replace(/~/g, "~0").replace(/\//g, "~1"),
            depth + 1
          )
        return
      }
      // Empty objects do not erase existing object fields under the original deep merge.
      if (emptyObject(value) && object(before)) return
      // Exact/ancestor lookup is bounded by path depth. Scan descendants only when a whole
      // prior object is actually being replaced, not for every unrelated leaf in large inputs.
      const candidates = new Set<string>()
      let ancestor = path
      while (ancestor) {
        if (this.writes.has(ancestor)) candidates.add(ancestor)
        ancestor = ancestor.slice(0, ancestor.lastIndexOf("/"))
      }
      if (object(before))
        for (const field of this.writes.keys())
          if (field.startsWith(path + "/")) candidates.add(field)
      for (const field of candidates) {
        const previous = this.writes.get(field)!
        if (
          !emptyObject(previous.value) &&
          (field !== path || !isDeepStrictEqual(previous.value, value))
        ) {
          if (this.diagnostics.length < 32) {
            if (path.length > 180) this.truncated = true
            const diagnostic: HookInputMergeDiagnostic = {
              field: label(path, 180),
              previous: previous.source,
              current: source,
              resolution: "later-hook-wins"
            }
            this.diagnostics.push(diagnostic)
            added.push(diagnostic)
          } else this.truncated = true
        }
        this.writes.delete(field)
      }
      if (this.writes.size < 2048) this.writes.set(path, { value, source })
      else this.truncated = true
    }
    for (const [key, value] of Object.entries(clean))
      visit(value, this.applied[key], "/" + key.replace(/~/g, "~0").replace(/\//g, "~1"), 1)
    this.applied = mergeUpdatedInput(this.applied, clean)
    return added
  }
}

export function hookInputMergeNotice(diagnostics: HookInputMergeDiagnostic[], truncated = false) {
  if (!diagnostics.length && !truncated) return undefined
  return (
    "原生 Hook 输入合并诊断（原生链按配置顺序后者生效，整体最终输入仍须通过权限与必需业务检查）：\n" +
    diagnostics
      .map(
        (row) =>
          `${row.field}：${row.previous.order}. ${row.previous.hookId}${row.previous.pluginId ? " [" + row.previous.pluginId + "]" : ""} → ${row.current.order}. ${row.current.hookId}${row.current.pluginId ? " [" + row.current.pluginId + "]" : ""}`
      )
      .join("\n") +
    (truncated ? "\n诊断已按数量、深度或标签长度上限截断；输入合并和业务检查仍按原规则执行。" : "")
  )
}

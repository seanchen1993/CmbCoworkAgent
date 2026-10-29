import { useEffect, useRef, useState } from "react"
import type { ClawView } from "../../../../shared/mods/claw"
import { useAppStore } from "@/lib/store"
import { FunctionPluginApproval } from "../customize/FunctionPluginApproval"

function identity(threadId: string, binding: ClawView, account: number) {
  return JSON.stringify([account, threadId, binding.workspace, binding.bindingRevision,
    binding.enabled, binding.applicable, binding.active,
    binding.active?.capabilities.map((selected) => {
      const source = binding.capabilities.find((item) => item.pluginId === selected.pluginId)
      return source ? [source.pluginId, source.name, source.digest] : null
    })])
}

/** Reauthorize only the exact source already selected by the user; never migrate a selection. */
export function ClawRecoveryApproval({ threadId, binding, disabled, onReload }: {
  threadId: string
  binding: ClawView
  disabled: boolean
  onReload(): Promise<unknown>
}) {
  const account = useAppStore((state) => state.accountRevision)
  const live = useRef(false)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const scope = identity(threadId, binding, account)
  const latest = useRef({ scope, disabled })
  latest.current = { scope, disabled }
  const pending = useRef<symbol | null>(null)
  const [operation, setOperation] = useState({ scope, busy: false, error: "" })
  if (operation.scope !== scope) setOperation({ scope, busy: false, error: "" })
  const busy = operation.scope === scope && operation.busy
  const selected = binding.active?.capabilities ?? []
  const rows = selected.flatMap((item) => {
    const source = binding.capabilities.find((candidate) => candidate.pluginId === item.pluginId &&
      candidate.name === item.name && candidate.digest === item.digest)
    if (source?.state === "ready") return []
    return [{ selected: item, source }]
  })
  if (!rows.length) return null
  return (
    <section aria-label="核对当前组合权限" className="space-y-3 rounded-xl border p-4">
      {rows.map(({ selected: item, source }) => (
        <article key={item.pluginId} data-claw-recovery-plugin={item.pluginId} className="space-y-2">
          <p className="text-sm font-medium">{item.name}</p>
          {source?.state === "needs-approval" && source.digest ? (
            <FunctionPluginApproval mod={source} threadId={threadId} workspace={binding.workspace}
              busy={disabled || busy || !binding.enabled || !binding.applicable}
              showConfiguration={false}
              onApprove={() => {
                if (pending.current || disabled || !binding.enabled || !binding.applicable) return
                const token = Symbol()
                pending.current = token
                setOperation({ scope, busy: true, error: "" })
                const current = () => live.current && latest.current.scope === scope && !latest.current.disabled &&
                  useAppStore.getState().accountRevision === account
                void (async () => {
                  try {
                    const fresh = await window.api.mods.clawView(threadId)
                    if (!current() || identity(threadId, fresh, account) !== scope)
                      throw Error("RECOVERY_SCOPE_CHANGED")
                    const exact = fresh.capabilities.find((candidate) => candidate.pluginId === item.pluginId &&
                      candidate.name === item.name && candidate.digest === item.digest &&
                      candidate.state === "needs-approval")
                    if (!exact) throw Error("RECOVERY_SCOPE_CHANGED")
                    await window.api.mods.approveFunction(threadId, exact.pluginId, item.digest, fresh.workspace)
                    if (!current()) return
                    await onReload()
                  } catch (error) {
                    if (current()) setOperation({ scope, busy: false, error:
                      error instanceof Error && error.message === "RECOVERY_SCOPE_CHANGED"
                        ? "组合已变化，请重新打开核对。" : "暂时未能确认权限，请重新核对。" })
                  } finally {
                    if (pending.current === token) pending.current = null
                    if (current()) setOperation((previous) => previous.scope === scope
                      ? { ...previous, busy: false } : previous)
                  }
                })()
              }} />
          ) : <p className="text-xs text-muted-foreground">版本已变化或来源不可用，请从上方“插件”核对。</p>}
        </article>
      ))}
      {operation.scope === scope && operation.error &&
        <p role="alert" className="text-xs text-destructive">{operation.error}</p>}
    </section>
  )
}

import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import type { FunctionCompatibilityReport, FunctionSdkCompatibilitySummary } from "../../../../shared/mods/v2/compatibility"
import { functionEventUsage } from "../../../../shared/mods/v2/compatibility-usage"

const statusText = {
  bounded: "已接入这些规则的触发入口",
  partial: "部分规则可以使用",
  unsupported: "有规则暂时无法生效",
  unverified: "有规则还需要确认"
}

export function FunctionCompatibilityCheck(props: {
  threadId: string
  pluginId: string
  digest: string
  expectedWorkspace?: string
  disabled: boolean
}) {
  return (
    <Check
      key={JSON.stringify([props.threadId, props.pluginId, props.digest, props.expectedWorkspace])}
      {...props}
    />
  )
}

function Check({
  threadId,
  pluginId,
  digest,
  disabled,
  expectedWorkspace
}: {
  threadId: string
  pluginId: string
  digest: string
  expectedWorkspace?: string
  disabled: boolean
}) {
  const live = useRef(true)
  const pending = useRef(false)
  const generation = useRef(0)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<FunctionCompatibilityReport>()
  const [sdk, setSdk] = useState<FunctionSdkCompatibilitySummary>()
  const [error, setError] = useState("")
  useEffect(() => {
    live.current = true
    const invalidate = () => {
      generation.current++
      pending.current = false
      setBusy(false)
      setReport(undefined)
      setSdk(undefined)
      setError("")
    }
    const stop = window.api.mods.onConfigurationChanged(invalidate)
    window.addEventListener("mods:configuration-changed", invalidate)
    return () => {
      live.current = false
      generation.current++
      stop()
      window.removeEventListener("mods:configuration-changed", invalidate)
    }
  }, [])
  async function check() {
    if (pending.current) return
    pending.current = true
    const request = ++generation.current
    const current = () => live.current && generation.current === request
    setBusy(true)
    setReport(undefined)
    setSdk(undefined)
    setError("")
    try {
      const result = await window.api.mods.checkFunctionCompatibility(
        threadId,
        pluginId,
        digest,
        expectedWorkspace
      )
      if (!current()) return
      if (result.digest !== digest) throw Error("MODS_APPROVAL_STALE")
      if (result.sdkCompatibility && result.sdkCompatibility.digest !== digest)
        throw Error("MODS_APPROVAL_STALE")
      setReport(result.compatibility)
      setSdk(result.sdkCompatibility)
    } catch (cause) {
      if (current()) {
        const message = cause instanceof Error ? cause.message : ""
        setError(
          message.includes("MODS_SECRET_CODE_APPROVAL_REQUIRED")
            ? "这个版本尚未获准读取已保存的敏感参数。请先核对并批准插件代码，再重新检查。"
            : message.includes("MODS_CHECK_BUSY")
              ? "另一个插件正在检查，请稍后重试。"
              : message.includes("MODS_APPROVAL_STALE") || message.includes("MODS_SCOPE_CHANGED")
                ? "插件或项目已变化，请刷新列表后重新检查。"
                : "检查未完成，请刷新列表后重试。"
        )
      }
    } finally {
      if (current()) {
        pending.current = false
        setBusy(false)
      }
    }
  }
  return (
    <div className="space-y-2 text-xs" data-function-compatibility>
      <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => void check()}>
        {busy ? "正在检查兼容性…" : "检查社区兼容性"}
      </Button>
      <p className="text-muted-foreground">
        检查事件入口与源码中使用的接口；不会授权灵件或执行事件回调。
      </p>
      {error && <p role="alert">{error}</p>}
      {report && (
        <div role="status" className="rounded border p-2 space-y-2">
          <strong>{statusText[report.status]}</strong>
          <p className="leading-relaxed text-muted-foreground">
            这是兼容性检查，尚未验证整包的实际效果。仍需批准能力，并试用作者提供的功能。
          </p>
          <div className="rounded bg-muted/40 p-3 space-y-2">
            <p className="font-medium">{!sdk ? "接口检查结果不可用，请更新应用后重试"
              : sdk.strictCompatible ? "所识别的接口未发现已知不兼容" : "有接口暂不支持或需要确认"}</p>
            {sdk?.diagnostics.length ? <ul className="max-h-48 overflow-auto space-y-2">
              {sdk.diagnostics.map((item, index) => <li key={`${item.file}:${item.line}:${index}`}>
                <p>{item.message}</p>
                {item.file && <p className="text-muted-foreground break-all">{item.file}:{item.line}</p>}
              </li>)}
            </ul> : null}
            <p className="text-muted-foreground">接口检查不代表已在当前项目运行通过。</p>
          </div>
          <ul className="max-h-64 space-y-2 overflow-auto">
            {report.registrations.map((registration) => {
              const events = registration.supportedEvents
              const usage = functionEventUsage(events[0] ?? registration.pattern)
              return (
                <li key={registration.id} className="rounded-lg bg-muted/40 p-3 leading-5">
                  <p className="font-medium">
                    {usage.when} · {events.length ? "已有入口" : "尚无可确认入口"}
                  </p>
                  <p>{usage.effect}</p>
                  <p className="text-muted-foreground">{usage.range}</p>
                  {registration.unavailableEvents.length > 0 && (
                    <p>
                      有 {registration.unavailableEvents.length} 个入口暂未接通，相应规则不会生效。
                    </p>
                  )}
                  {registration.unverifiedEvents.length > 0 && (
                    <p>还有入口尚未验证，需联系作者确认。</p>
                  )}
                  <details className="mt-1">
                    <summary className="cursor-pointer text-muted-foreground">
                      作者细节与完整触发范围
                    </summary>
                    <p className="break-all">{registration.pattern}</p>
                    <p className="break-all">
                      {registration.events.join("、") || "没有已知事件匹配"}
                    </p>
                  </details>
                </li>
              )
            })}
          </ul>
          {report.diagnostics.length > 0 && (
            <details open>
              <summary className="cursor-pointer">{report.diagnostics.length} 项说明</summary>
              <ul className="space-y-2 mt-2 max-h-64 overflow-auto">
                {report.diagnostics.map((item, index) => (
                  <li key={index}>
                    <code className="break-all">{item.pattern || "无事件注册"}</code>：{item.impact}
                    {item.events.length > 0 && (
                      <details>
                        <summary className="cursor-pointer">
                          涉及 {item.events.length} 个事件
                        </summary>
                        <p className="break-all">{item.events.join("、")}</p>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  )
}

import { useEffect, useRef, useState } from "react"
import type { AuthoringDocument } from "../../../../shared/mods/authoring"
import type {
  AuthoringPreviewAction,
  AuthoringPreviewView
} from "../../../../shared/mods/authoring-preview"

let nextRequest = 0
const buttonClass = "rounded border px-3 py-2 text-sm disabled:opacity-50"
const inputClass = "w-full rounded border bg-background p-2 text-sm"
interface Props {
  threadId: string
  workspace: string
  document: AuthoringDocument
  dirty: boolean
}
export function AuthoringPreviewPanel(props: Props): React.JSX.Element {
  const { threadId, workspace, document, dirty } = props
  return (
    <Preview
      key={JSON.stringify([
        threadId,
        workspace,
        document.id,
        document.currentRevision,
        document.source.digest,
        dirty
      ])}
      {...props}
    />
  )
}
function Preview({ threadId, workspace, document, dirty }: Props): React.JSX.Element {
  const [report, setReport] = useState<AuthoringPreviewView | null>(null)
  const [catalog, setCatalog] = useState<AuthoringPreviewView | null>(null)
  const [kind, setKind] = useState<"command" | "tool" | "rule">("command")
  const [target, setTarget] = useState("")
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState("")
  const alive = useRef(false)
  const pending = useRef<{ requestId: string; cancelled: boolean } | null>(null)
  const scope = { threadId, expectedWorkspace: workspace }
  useEffect(() => {
    alive.current = true
    const active = pending
    return () => {
      alive.current = false
      if (active.current) {
        active.current.cancelled = true
        void window.api.mods.authoringPreview
          .cancel({ threadId, expectedWorkspace: workspace, requestId: active.current.requestId })
          .catch(() => undefined)
      }
    }
  }, [threadId, workspace])
  const run = async (action: AuthoringPreviewAction) => {
    if (dirty || pending.current) return
    const owner = { requestId: `preview-${Date.now()}-${++nextRequest}`, cancelled: false }
    pending.current = owner
    setBusy(true)
    setCancelling(false)
    setError("")
    setReport(null)
    try {
      const value = await window.api.mods.authoringPreview.start({
        ...scope,
        id: document.id,
        revision: document.currentRevision,
        sourceDigest: document.source.digest,
        requestId: owner.requestId,
        action
      })
      if (!alive.current || pending.current !== owner || owner.cancelled) return
      if (
        value.requestId !== owner.requestId ||
        value.id !== document.id ||
        value.revision !== document.currentRevision ||
        value.sourceDigest !== document.source.digest ||
        value.action !== action.kind
      ) {
        setError("预览结果与当前源码不一致，请重新检查。")
        return
      }
      setReport(value)
      if (action.kind === "inspect") {
        setCatalog(value)
        setTarget(value.commands[0]?.name ?? "")
      }
    } catch (error) {
      if (!alive.current || pending.current !== owner) return
      const message = error instanceof Error ? error.message : ""
      if (owner.cancelled || message.includes("AUTHORING_PREVIEW_CANCELLED"))
        setError("试用已取消。")
      else if (message.includes("AUTHORING_PREVIEW_SOURCE_CHANGED"))
        setError("保存的版本已变化，请重新打开草稿后预览。")
      else if (message.includes("AUTHORING_PREVIEW_BUSY"))
        setError("上一次试用还未结束，请稍后重试。")
      else setError("试用未完成，文件仍保留。请检查样例输入后重试。")
    } finally {
      if (pending.current === owner) pending.current = null
      if (alive.current) {
        setBusy(false)
        setCancelling(false)
      }
    }
  }
  const cancel = async () => {
    const owner = pending.current
    if (!owner || owner.cancelled) return
    owner.cancelled = true
    setCancelling(true)
    try {
      await window.api.mods.authoringPreview.cancel({ ...scope, requestId: owner.requestId })
    } catch {
      if (alive.current) setError("取消请求未确认，正在等待预览结束。")
    }
  }
  const options = kind === "tool" ? (catalog?.tools ?? []) : (catalog?.commands ?? [])
  return (
    <section aria-label="已保存源码预览" className="space-y-3 rounded border p-3">
      <h3 className="font-medium">用样例试用 · v{document.currentRevision}</h3>
      <p className="text-sm text-muted-foreground">
        用你输入的样例检查已保存的版本。这里不访问项目文件、网络或模型，也不会安装插件。
      </p>
      {dirty && (
        <p role="status" className="text-sm">
          请先保存修改，再用样例试用。
        </p>
      )}
      <button
        className={buttonClass}
        disabled={dirty || busy}
        onClick={() => void run({ kind: "inspect", target: "", input: "" })}
      >
        查看可试用的功能
      </button>
      {catalog && (
        <>
          <label className="block text-sm">
            样例类型
            <select
              aria-label="预览样例类型"
              className={inputClass}
              disabled={busy}
              value={kind}
              onChange={(event) => {
                const value = event.target.value as typeof kind
                setKind(value)
                setTarget((value === "tool" ? catalog.tools : catalog.commands)[0]?.name ?? "")
              }}
            >
              <option value="command">命令或流程步骤</option>
              <option value="tool">工具</option>
              <option value="rule">提示词规则</option>
            </select>
          </label>
          {kind !== "rule" && (
            <label className="block text-sm">
              选择要试用的功能
              <select
                aria-label="预览入口"
                className={inputClass}
                disabled={busy}
                value={target}
                onChange={(event) => setTarget(event.target.value)}
              >
                <option value="">请选择功能</option>
                {options.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name} · {item.description}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block text-sm">
            {kind === "tool" ? "样例输入（JSON 对象）" : "样例输入"}
            <textarea
              aria-label="预览样例输入"
              className={inputClass}
              value={input}
              maxLength={16000}
              disabled={busy}
              onChange={(event) => setInput(event.target.value)}
            />
          </label>
          <button
            className={buttonClass}
            disabled={busy || dirty || (kind !== "rule" && !target)}
            onClick={() => void run({ kind, target: kind === "rule" ? "" : target, input })}
          >
            运行这个样例
          </button>
        </>
      )}
      {busy && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status" className="text-sm">
            {cancelling ? "正在取消试用…" : "正在检查或运行样例…"}
          </p>
          <button className={buttonClass} disabled={cancelling} onClick={() => void cancel()}>
            取消试用
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {report && (
        <div className="space-y-2" aria-label="隔离预览报告">
          <p className="text-sm">
            {report.action === "inspect"
              ? "功能列表已准备好。选择一项并输入样例，就可以开始试用。"
              : "样例运行结束，结果如下。"}
          </p>
          {report.failures > 0 && (
            <p role="alert" className="text-sm text-destructive">
              包含 {report.failures} 次失败或备用处理，请先查看问题再继续。
            </p>
          )}
          <ul className="text-sm">
            <li>代码类型检查：{report.checks.types ? "未发现错误" : "存在问题"}</li>
            <li>触发方式检查：{report.checks.events ? "已通过支持范围检查" : "部分不支持或未验证"}</li>
            <li>
              接口用法检查：{report.checks.sdk ? "未发现不支持或未验证的用法" : "存在不支持或未验证用法"}
            </li>
          </ul>
          {report.diagnostics.length > 0 && (
            <details>
              <summary className="text-sm">查看检查详情（{report.diagnostics.length}）</summary>
              <ul className="space-y-1 text-xs">
                {report.diagnostics.map((item, index) => (
                  <li className="whitespace-pre-wrap break-all" key={index}>
                    {item.source}: {item.message}
                  </li>
                ))}
              </ul>
              {report.omittedDiagnostics > 0 && (
                <p className="text-xs">另有 {report.omittedDiagnostics} 条检查详情未显示。</p>
              )}
            </details>
          )}
          {report.action !== "inspect" && (
            <details open>
              <summary className="text-sm">本次样例输出</summary>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded border p-2 text-xs">
                {JSON.stringify(report.result, null, 2)}
              </pre>
            </details>
          )}
          {!!report.panes.length && (
            <div>
              <p className="text-sm">面板内容预览（仅查看，不能点击操作）</p>
              {report.panes.map((pane, index) => (
                <details key={index} open>
                  <summary className="break-all text-sm">{pane.title}</summary>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded border p-2 text-xs">
                    {pane.text}
                  </pre>
                </details>
              ))}
              {report.paneTextTruncated && (
                <p className="text-xs">内容较长，这里只显示一部分。</p>
              )}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            安装后使用时，仍需确认权限，并检查真实任务的结果。
          </p>
        </div>
      )}
    </section>
  )
}

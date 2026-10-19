import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import type {
  PluginDerivationCopy,
  PluginDerivationProposal,
  PluginDerivationScope
} from "../../../../shared/plugin-derivation"

// Keep input when navigating away, without retaining source text or stale host candidates.
const drafts = new Map<string, string>()
function saveDraft(key: string, value: string) {
  drafts.delete(key)
  if (value) drafts.set(key, value)
  while (drafts.size > 32) drafts.delete(drafts.keys().next().value!)
}

function FilePreview({ file }: { file: PluginDerivationProposal["files"][number] }) {
  const [open, setOpen] = useState(false)
  const [full, setFull] = useState(false)
  const addition = file.after.startsWith(file.before)
    ? file.after.slice(file.before.length).trim()
    : null
  let configurationAddition: string | null = null
  if (file.path === "board_core/board_config.json") {
    try {
      const before = JSON.parse(file.before)
      const after = JSON.parse(file.after)
      if (
        !before.workflow?.templates?.["devclaw-composed"] &&
        after.workflow?.templates?.["devclaw-composed"]
      )
        configurationAddition = JSON.stringify(
          after.workflow.templates["devclaw-composed"],
          null,
          2
        )
    } catch {
      /* Full before/after remains available if JSON cannot be summarized. */
    }
  }
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)} className="rounded border p-3">
      <summary className="cursor-pointer break-all">{file.path}</summary>
      {open && (
        <div className="mt-3 min-w-0 space-y-3">
          {configurationAddition && (
            <div>
              <p className="mb-1 font-medium">新增“自选项目步骤”选项</p>
              <pre
                aria-label="新增节点组合配置"
                className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-xs"
              >
                {configurationAddition}
              </pre>
            </div>
          )}
          {addition && (
            <div>
              <p className="mb-1 font-medium">
                {file.before ? "本次新增的业务要求" : "新增文件内容"}
              </p>
              <pre
                aria-label={file.before ? "本次新增的业务要求" : "新增文件内容"}
                className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-xs"
              >
                {addition}
              </pre>
            </div>
          )}
          <details onToggle={(event) => setFull(event.currentTarget.open)}>
            <summary className="cursor-pointer">查看完整修改前后</summary>
            {full && (
              <div className="mt-3 grid min-w-0 gap-3 lg:grid-cols-2">
                {[
                  ["修改前", file.before],
                  ["修改后", file.after]
                ].map(([label, text]) => (
                  <div key={label} className="min-w-0">
                    <p className="mb-1 font-medium">{label}</p>
                    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 text-xs">
                      {text}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </details>
        </div>
      )}
    </details>
  )
}

export function DerivedPluginProposal({
  scope,
  copy,
  active,
  disabled,
  onSaved,
  onPending
}: {
  scope: PluginDerivationScope
  copy: PluginDerivationCopy
  active: boolean
  disabled: boolean
  onSaved(copy: PluginDerivationCopy): void
  onPending(pending: boolean): void
}) {
  const draftKey = JSON.stringify([scope.threadId, scope.expectedWorkspace, copy.copyId])
  const [instruction, setInstruction] = useState(() => drafts.get(draftKey) ?? "")
  const [proposalKind, setProposalKind] = useState<"business" | "nodes" | "flow">("business")
  const [proposal, setProposal] = useState<PluginDerivationProposal | null>(null)
  const [busy, setBusy] = useState<"generating" | "saving" | null>(null)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const sequence = useRef(0)
  const live = useRef(true)
  const pending = useRef<{ requestId?: string; proposalId?: string }>({})
  const running = useRef(false)
  const currentScope = useRef(scope)
  currentScope.current = scope
  const pendingCallback = useRef(onPending)
  pendingCallback.current = onPending

  function cancelHost() {
    const ids = pending.current
    pending.current = {}
    if (ids.requestId || ids.proposalId)
      void window.api.pluginDerivation
        .cancelProposal({ ...currentScope.current, ...ids })
        .catch(() => undefined)
  }
  function discard(message = "已取消，需求草稿已保留。") {
    sequence.current++
    cancelHost()
    running.current = false
    setBusy(null)
    setProposal(null)
    setNotice(message)
    onPending(false)
  }
  function cleanup() {
    live.current = false
    sequence.current++
    cancelHost()
    pendingCallback.current(false)
  }
  useEffect(() => {
    live.current = true
    return cleanup
    // The parent keys this editor by scope and copy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (!active && busy !== "saving") discard("需求草稿已保留，回来后可重新生成。")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
  const stale = !!proposal && proposal.baseDigest !== copy.digest

  async function generate(kind: "business" | "nodes" | "flow" = "business") {
    if (running.current || disabled || (kind === "business" && !instruction.trim())) return
    setProposalKind(kind)
    cancelHost()
    const token = ++sequence.current
    const requestId = crypto.randomUUID()
    pending.current = { requestId }
    running.current = true
    setBusy("generating")
    setProposal(null)
    setError("")
    setNotice("")
    onPending(true)
    try {
      const input = { ...scope, copyId: copy.copyId, expectedDigest: copy.digest, requestId }
      const value =
        kind === "flow"
          ? await window.api.pluginDerivation.prepareFlowComposition(input)
          : kind === "nodes"
            ? await window.api.pluginDerivation.prepareNodeComposition(input)
            : await window.api.pluginDerivation.propose({
                ...input,
                instruction: instruction.trim()
              })
      if (!live.current || sequence.current !== token) {
        void window.api.pluginDerivation
          .cancelProposal({ ...scope, proposalId: value.proposalId })
          .catch(() => undefined)
        return
      }
      pending.current = { requestId, proposalId: value.proposalId }
      setProposal(value)
    } catch (cause) {
      if (live.current && sequence.current === token) {
        setError(cause instanceof Error ? cause.message : String(cause))
        onPending(false)
      }
    } finally {
      if (live.current && sequence.current === token) {
        running.current = false
        setBusy(null)
      }
    }
  }
  async function apply() {
    if (!proposal || stale || running.current || disabled) return
    const token = ++sequence.current
    running.current = true
    setBusy("saving")
    setError("")
    try {
      const value = await window.api.pluginDerivation.applyProposal({
        ...scope,
        proposalId: proposal.proposalId
      })
      if (!live.current || sequence.current !== token) return
      pending.current = {}
      setProposal(null)
      onPending(false)
      onSaved(value)
      setNotice(
        proposalKind === "flow"
          ? "完整流程组合配置已保存。请检查并安装此副本，再到项目会话的“项目能力”选择完整流程。"
          : proposalKind === "nodes"
            ? "“自选项目步骤”已保存。接下来检查能否安装。"
            : "业务要求已保存到技能文件。接下来检查能否安装。"
      )
    } catch (cause) {
      if (live.current && sequence.current === token)
        setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (live.current && sequence.current === token) {
        running.current = false
        setBusy(null)
      }
    }
  }
  return (
    <section
      aria-label="描述需求生成修改"
      className="min-w-0 space-y-3 rounded-lg border p-3 text-sm"
    >
      <label className="block space-y-2">
        <span className="font-medium">告诉我你想怎么改</span>
        <textarea
          value={instruction}
          maxLength={8000}
          disabled={disabled || !!busy}
          className="block min-h-28 w-full min-w-0 rounded border bg-background p-2"
          placeholder="例如：保留 AutoBiz 的检查步骤，增加数据开发要求，产物包括 SQL 和数据质量报告。"
          onChange={(event) => {
            const value = event.target.value
            saveDraft(draftKey, value)
            setInstruction(value)
            if (proposal) discard("需求已修改，请重新生成建议。")
          }}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        用当前聊天选择的模型，为技能说明补充业务要求，保留原有步骤、检查和人工确认。
        先查看修改内容，确认后才保存。关闭应用前，你输入的需求会保留。
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={disabled || !!busy || !instruction.trim()}
          onClick={() => void generate()}
        >
          {busy === "generating" ? "正在生成修改建议…" : proposal ? "重新生成建议" : "生成修改建议"}
        </Button>
        {(proposal || busy === "generating") && (
          <Button variant="outline" disabled={busy === "saving"} onClick={() => discard()}>
            取消本次建议
          </Button>
        )}
      </div>
      <div className="space-y-2 rounded border p-3" aria-label="安装前添加自选步骤选项">
        <p className="font-medium">需要自己选择项目步骤？</p>
        <p className="text-xs text-muted-foreground">
          安装前为支持的 AutoBiz
          副本添加“自选项目步骤”选项。安装后可组合这个插件的步骤，原有检查和人工确认继续生效。先查看配置变化，再确认保存；不支持此选项的插件仍使用原模板。
        </p>
        <Button
          variant="outline"
          disabled={disabled || !!busy || !!proposal || copy.status === "installed"}
          onClick={() => void generate("nodes")}
        >
          添加自选步骤选项
        </Button>
        {copy.status === "installed" && (
          <p className="text-xs text-muted-foreground">
            要给已安装的插件添加此选项，请先创建新副本，再修改和安装。
          </p>
        )}
      </div>
      <div className="space-y-2 rounded border p-3" aria-label="安装前准备完整流程组合">
        <p className="font-medium">需要把完整流程接到其他流程后面？</p>
        <p className="text-xs text-muted-foreground">
          为支持的插件副本准备完整流程组合配置，保留原有技能、检查和人工确认。
          先核对新增文件并保存，再检查和安装此副本。安装后，在项目会话的“项目能力”中选择完整流程并安排顺序。
          保存后查看可用状态；暂不支持时，按页面提示使用原项目入口。
        </p>
        <Button
          variant="outline"
          disabled={disabled || !!busy || !!proposal || copy.status === "installed"}
          onClick={() => void generate("flow")}
        >
          用于完整流程组合
        </Button>
        {copy.status === "installed" && (
          <p className="text-xs text-muted-foreground">请先创建新副本，再准备完整流程组合。</p>
        )}
      </div>
      {busy === "generating" && <p role="status">正在准备修改建议。确认保存前不会改动文件。</p>}
      {proposal && (
        <div className="min-w-0 space-y-3" aria-label="修改建议预览">
          <p className="break-words font-medium">{proposal.summary}</p>
          <p className="text-xs text-muted-foreground">
            请核对 · {proposal.files.length} 个{proposalKind === "business" ? "技能" : "配置"}
            文件将被{proposalKind === "flow" ? "新增" : "修改"}。展开查看修改前后的内容。
          </p>
          {proposal.files.map((file) => (
            <FilePreview key={`${proposal.proposalId}:${file.path}`} file={file} />
          ))}
          {stale && <p role="alert">副本已变化。请重新生成建议后再保存，需求草稿已保留。</p>}
          <Button disabled={disabled || !!busy || stale} onClick={() => void apply()}>
            {busy === "saving"
              ? "正在保存修改…"
              : proposalKind === "flow"
                ? "确认保存完整流程配置"
                : proposalKind === "nodes"
                  ? "确认添加自选步骤选项"
                  : "确认保存修改"}
          </Button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="break-words text-destructive">
          {error} 需求草稿已保留，可重试。
          {error.includes("源码已变化") && (
            <span className="mt-1 block">
              {proposal ? "请先取消本次建议，再点" : "请点"}
              “检查能否安装”更新副本信息，然后重新生成。
            </span>
          )}
        </p>
      )}
    </section>
  )
}

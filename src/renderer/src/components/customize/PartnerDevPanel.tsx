import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type {
  PartnerDevMessageReply,
  PartnerDevRunView,
  PartnerDevStatus
} from "../../../../shared/bot/partner-dev"
import type { ExpertMemoryList } from "../../../../shared/bot/expert-memory"
import { ExpertMemoryPanel } from "./ExpertMemoryPanel"

const ERRORS: Record<string, string> = {
  FORBIDDEN: "当前身份没有操作权限。",
  UNAUTHENTICATED: "本地连接凭据已失效，请检查启动配置。",
  VERSION_CONFLICT: "资料已更新，请刷新后重试。",
  INPUT_CHANGED: "配置或资料已变化；请核对。若上次写入结果未知，请用原内容重试。",
  OUTCOME_UNKNOWN: "上次执行结果不确定，不会自动重跑。",
  NODE_OFFLINE: "本地服务未连接。",
  NOT_CONFIGURED: "请先创建专家，再启用本机。",
  STORAGE_FAILURE: "本地私有数据目录或配置不可用，请检查启动说明。",
  STORAGE_UNAVAILABLE: "系统安全存储不可用，未保存明文凭据。",
  DEPENDENCY_UNAVAILABLE: "本地服务暂不可用，请检查启动状态。",
  INVALID_PAYLOAD: "输入不符合文本测试版约束。",
  MEMORY_CHANGED: "记忆已变化，此次分析失效。是否重新分析由你决定。",
  PAYLOAD_TOO_LARGE: "记忆超过上限，请先整理或停用条目。"
}
function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return (
    ERRORS[Object.keys(ERRORS).find((k) => text.includes(k)) ?? ""] ??
    "操作未完成，请检查本地服务与权限。"
  )
}
const RUN_LABELS: Record<string, string> = {
  waiting_node: "等待本机启用",
  queued: "排队中",
  starting: "准备分析",
  running: "模拟分析中",
  succeeded: "模拟分析完成",
  failed: "分析未完成",
  cancelled: "已取消",
  outcome_unknown: "结果未知，不会自动重跑"
}

export function PartnerDevPanel(): React.JSX.Element {
  const [status, setStatus] = useState<PartnerDevStatus | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const [name, setName] = useState("需求领域专家"),
    [instructions, setInstructions] = useState(
      "聚焦本产品业务需求，区分事实与假设，明确范围、澄清问题和验收标准。"
    )
  const [text, setText] = useState("新任务：增加按日期查询交易的能力，先梳理权限与边界。"),
    [taskNumber, setTaskNumber] = useState(""),
    [runId, setRunId] = useState("")
  const [run, setRun] = useState<PartnerDevRunView | null>(null),
    [messages, setMessages] = useState<string[]>([]),
    [memories, setMemories] = useState<ExpertMemoryList | null>(null)
  const busyRef = useRef(false),
    selection = useRef({ runId: "", taskNumber: "" }),
    epoch = useRef(0),
    currentBot = useRef<string | null>(null)
  useEffect(() => {
    selection.current = { runId, taskNumber }
  }, [runId, taskNumber])
  const acceptStatus = (current: PartnerDevStatus) => {
    const key = JSON.stringify([
      current.url,
      current.spaceId,
      current.ownerPrincipalId,
      current.groupId,
      current.botId
    ])
    if (currentBot.current !== key) {
      currentBot.current = key
      setMemories(null)
      setRun(null)
      setTaskNumber("")
      setRunId("")
      setMessages([])
      selection.current = { runId: "", taskNumber: "" }
    }
    if (!current.connected) {
      setMemories(null)
      setRun(null)
    }
    setStatus(current)
  }
  useEffect(() => {
    let alive = true,
      timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      const request = epoch.current,
        currentRequest = () => alive && request === epoch.current
      try {
        const current = await window.api.partnerDev.getStatus()
        if (!currentRequest()) return
        acceptStatus(current)
        if (current.connected && current.botId && current.canManageExpertMemory !== false) {
          try {
            const list = await window.api.partnerDev.listExpertMemories()
            if (!currentRequest()) return
            setMemories(list)
          } catch (e) {
            if (!currentRequest()) return
            setMemories(null)
            setError(errorText(e))
            // Losing expert maintenance rights does not revoke a separately
            // authorized Task result. Never render stale cache, still inspect.
          }
        } else {
          setMemories(null)
        }
        if (!selection.current.taskNumber && current.lastTaskNumber)
          setTaskNumber(current.lastTaskNumber)
        const id = selection.current.runId || current.lastRunId
        if (!selection.current.runId && id) setRunId(id)
        if (current.connected && id) {
          const value = await window.api.partnerDev.inspectRun({ runId: id })
          if (currentRequest() && (!selection.current.runId || selection.current.runId === id))
            setRun(value)
        }
      } catch (e) {
        if (currentRequest()) {
          setError(errorText(e))
          setMemories(null)
          setRun(null)
        }
      } finally {
        if (alive) timer = setTimeout(() => void refresh(), 2000)
      }
    }
    void refresh()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [])
  const action = async (fn: () => Promise<unknown>): Promise<void> => {
    if (busyRef.current) return
    epoch.current++
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await fn()
      acceptStatus(await window.api.partnerDev.getStatus())
    } catch (e) {
      setError(errorText(e))
      setMemories(null)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  const reply = (value: PartnerDevMessageReply) => {
    setMessages((old) => [...old.slice(-9), value.notice])
    if (value.taskNumber) {
      setTaskNumber(value.taskNumber)
      setText(`${value.taskNumber}：补充业务规则：仅允许查询本人有权限的交易。`)
    }
    if (value.runId) {
      setRunId(value.runId)
      setRun(null)
    }
  }
  const connected = !!status?.connected,
    local = status?.connectionMode === "local-default"
  return (
    <div className="flex-1 min-w-0 overflow-y-auto p-6" data-testid="partner-dev-panel">
      <div className="mx-auto max-w-3xl space-y-4">
        <header>
          <h2 className="text-xl font-semibold">DevClaw 伙伴</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            让领域专家参与需求澄清与分析。当前为本地模拟测试，不读取代码、服务会话使用负责人明确选择的模型，开发演示仍使用模拟模型或招乎。
          </p>
        </header>
        {(error || status?.lastError) && (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 p-3 text-sm text-destructive"
          >
            {error ?? ERRORS[status!.lastError!] ?? "本地状态异常，请检查启动配置。"}
          </p>
        )}
        <section className="space-y-3 rounded-xl border p-4">
          <h3 className="font-medium">我的专家</h3>
          {!status?.botId ? (
            <>
              <Input
                aria-label="专家名称"
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
              />
              <textarea
                aria-label="专家职责"
                value={instructions}
                rows={3}
                maxLength={16384}
                onChange={(e) => setInstructions(e.target.value)}
                className="w-full rounded-md border bg-background p-2 text-sm"
              />
              <p className="text-xs text-muted-foreground">
                支持你手工保存的长期记忆，不自动学习聊天。创建后不会自动执行任务，数据目录自动准备。
              </p>
              <Button
                disabled={busy || !connected || !name.trim() || !instructions.trim()}
                onClick={() =>
                  void action(() => window.api.partnerDev.createExpert({ name, instructions }))
                }
              >
                创建专家
              </Button>
            </>
          ) : (
            <>
              <p className="text-sm font-medium">{status.expertName ?? "当前领域专家"}</p>
              <details>
                <summary className="cursor-pointer text-sm">长期记忆</summary>
                <ExpertMemoryPanel
                  connected={connected}
                  botId={status.botId}
                  busy={busy}
                  memories={memories}
                  canManage={status.canManageExpertMemory}
                  onChange={setMemories}
                  action={action}
                />
              </details>
            </>
          )}
        </section>
        <section
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
          aria-label="本地状态"
        >
          <div role="status" className="text-sm">
            本机：
            {!connected
              ? "未连接"
              : status?.activeRunId
                ? "执行中"
                : status?.nodeEnabled
                  ? "已启用"
                  : "未启用"}
            <span className="ml-3 text-muted-foreground">模拟模型</span>
            <p className="mt-1 text-xs text-muted-foreground">
              专家数据目录自动准备，无需选择代码仓库。
            </p>
          </div>
          {status?.nodeEnabled ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void action(() => window.api.partnerDev.stopNode())}
            >
              停止本机
            </Button>
          ) : (
            <Button
              disabled={busy || !connected || !status?.botId || !status.expertMemoryAdopted}
              onClick={() => {
                if (
                  window.confirm(
                    `允许“${status?.expertName ?? "当前专家"}”使用本机进行文本分析（授权24小时）？\n数据目录：${status?.expertDataPath ?? "应用私有目录"}\n不读取代码，服务会话使用负责人明确选择的模型，开发演示仍使用模拟模型。`
                  )
                )
                  void action(() => window.api.partnerDev.startExpert())
              }}
            >
              启用本机
            </Button>
          )}
        </section>
        <section className="space-y-3 rounded-xl border p-4">
          <h3 className="font-medium">任务</h3>
          <p className="text-xs text-muted-foreground">
            模拟 @专家：用“新任务：内容”开始，按任务编号继续澄清。发送仅保存，点击“分析需求”才执行。
          </p>
          <textarea
            aria-label="任务消息"
            value={text}
            rows={3}
            maxLength={16384}
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded-md border bg-background p-2 text-sm"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={busy || !connected || !status?.botId || !text.trim()}
              onClick={() =>
                void action(async () =>
                  reply(await window.api.partnerDev.sendMessage({ mentioned: true, text }))
                )
              }
            >
              发送给专家
            </Button>
            <Button
              variant="outline"
              disabled={busy || !connected || !taskNumber}
              onClick={() =>
                void action(async () =>
                  reply(await window.api.partnerDev.analyzeTask({ taskNumber }))
                )
              }
            >
              分析需求
            </Button>
            {taskNumber && <span className="text-xs text-muted-foreground">{taskNumber}</span>}
          </div>
          <div className="space-y-1 text-sm" aria-live="polite">
            {messages.map((message, i) => (
              <p key={i} className="rounded bg-muted/40 p-2">
                {message}
              </p>
            ))}
          </div>
          {run && (
            <div className="space-y-2 rounded-md border p-3">
              <p className="text-sm">{RUN_LABELS[run.status] ?? run.status}</p>
              {run.result && (
                <pre
                  className="whitespace-pre-wrap break-words text-sm"
                  data-testid="partner-result"
                >
                  {run.result.text}
                </pre>
              )}
              {run.memorySnapshot !== undefined && (
                <details data-testid="run-memory-snapshot">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    {run.memorySnapshot === null
                      ? "此次未使用长期记忆"
                      : `此次使用 ${run.memorySnapshot.memories.length} 条记忆`}
                  </summary>
                  {run.memorySnapshot?.memories.map((m) => (
                    <p key={m.id} className="break-all text-xs">
                      v{m.version} · {m.text}
                    </p>
                  ))}
                </details>
              )}
              {["queued", "waiting_node"].includes(run.status) && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void action(async () =>
                      setRun(
                        await window.api.partnerDev.cancelPending({
                          runId: run.runId,
                          expectedVersion: run.version
                        })
                      )
                    )
                  }
                >
                  取消等待中的分析
                </Button>
              )}
            </div>
          )}
        </section>
        <details className="space-y-3 rounded-xl border p-4" data-testid="partner-advanced">
          <summary className="cursor-pointer text-sm text-muted-foreground">高级设置与调试</summary>
          <div className="space-y-3 pt-3">
            {!local && (
              <div className="flex gap-2">
                <Button
                  disabled={busy}
                  onClick={() => void action(() => window.api.partnerDev.importConnection())}
                >
                  导入连接文件
                </Button>
                <Button
                  disabled={busy || !status?.configured}
                  onClick={() => void action(() => window.api.partnerDev.connect())}
                >
                  连接服务
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || !connected}
                  onClick={() => void action(() => window.api.partnerDev.disconnect())}
                >
                  断开
                </Button>
              </div>
            )}
            <p className="break-all text-xs text-muted-foreground">
              服务：{status?.url ?? "初始化中"}
              <br />
              专家数据目录：{status?.expertDataPath ?? "创建专家后自动生成"}
              <br />
              运行目录：{status?.workspacePath ?? "自动准备"}
              <br />
              节点：{status?.nodeId ?? "—"} · 专家：{status?.botId ?? "—"}
            </p>
            <Button
              variant="outline"
              disabled={busy || !status?.configured}
              onClick={() => void action(() => window.api.partnerDev.chooseWorkspace())}
            >
              更换运行目录（不授予源码权限）
            </Button>
            <Button
              variant="outline"
              disabled={busy || !connected || !status?.groupId}
              onClick={() => void action(() => window.api.partnerDev.revokeLocalAuthorization())}
            >
              撤销本机授权
            </Button>
            <Input
              aria-label="任务编号"
              placeholder="查询已有 TASK-编号"
              value={taskNumber}
              onChange={(e) => setTaskNumber(e.target.value)}
            />
            <Input
              aria-label="执行编号"
              placeholder="查询已有执行编号"
              value={runId}
              onChange={(e) => {
                setRunId(e.target.value)
                setRun(null)
              }}
            />
          </div>
        </details>
      </div>
    </div>
  )
}

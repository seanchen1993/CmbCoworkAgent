import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type {
  PartnerDevMessageReply,
  PartnerDevRunView,
  PartnerDevStatus
} from "../../../../shared/bot/partner-dev"

const ERRORS: Record<string, string> = {
  FORBIDDEN: "当前身份或授权不允许此操作。",
  UNAUTHENTICATED: "凭据已失效，请重新导入本地连接文件。",
  VERSION_CONFLICT: "版本已变化，请刷新后重试。",
  INPUT_CHANGED: "尚有结果未知的写入，请以完全相同的内容重试，不能直接换新指令。",
  OUTCOME_UNKNOWN: "上次执行结果不确定，不会自动重跑。",
  NODE_OFFLINE: "请先连接本地控制服务。",
  NOT_CONFIGURED: "请完成连接、工作区与团队配置。",
  STORAGE_FAILURE: "连接文件须为私有、当前用户拥有的普通文件；请检查启动说明。",
  STORAGE_UNAVAILABLE: "系统安全存储不可用，未保存明文凭据。",
  DEPENDENCY_UNAVAILABLE: "本地服务不可用或连接中断，请检查启动状态。",
  INVALID_PAYLOAD: "参数不符合当前文本开发版约束。"
}
function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const code = Object.keys(ERRORS).find((k) => text.includes(k))
  return code ? ERRORS[code] : "操作未完成，请检查本地服务与当前权限。"
}
const RUN_LABELS: Record<string, string> = {
  waiting_node: "等待负责人节点",
  queued: "排队中",
  starting: "已领取",
  running: "模拟执行中",
  succeeded: "模拟完成",
  failed: "失败",
  cancelled: "已取消",
  outcome_unknown: "结果未知（不会自动重跑）"
}

export function PartnerDevPanel(): React.JSX.Element {
  const [status, setStatus] = useState<PartnerDevStatus | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const [name, setName] = useState("需求领域专家"),
    [instructions, setInstructions] = useState(
      "聚焦本产品的业务需求，区分事实与假设，明确范围、澄清问题和验收标准。"
    )
  const [groupId, setGroupId] = useState(""),
    [mentioned, setMentioned] = useState(true),
    [text, setText] = useState("新任务：增加按日期查询交易的能力，先梳理权限与边界。")
  const [taskNumber, setTaskNumber] = useState(""),
    [runId, setRunId] = useState(""),
    [run, setRun] = useState<PartnerDevRunView | null>(null),
    [messages, setMessages] = useState<string[]>([])
  const busyRef = useRef(false),
    selection = useRef({ runId: "", taskNumber: "" })
  useEffect(() => {
    selection.current = { runId, taskNumber }
  }, [runId, taskNumber])
  useEffect(() => {
    let alive = true,
      timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      try {
        const current = await window.api.partnerDev.getStatus()
        if (!alive) return
        setStatus(current)
        if (!selection.current.taskNumber && current.lastTaskNumber)
          setTaskNumber(current.lastTaskNumber)
        const id = selection.current.runId || current.lastRunId
        if (!selection.current.runId && id) setRunId(id)
        if (current.connected && id) {
          const inspected = await window.api.partnerDev.inspectRun({ runId: id })
          if (alive) setRun(inspected)
        }
      } catch (e) {
        if (alive) setError(errorText(e))
      } finally {
        if (alive)
          timer = setTimeout(() => {
            void refresh()
          }, 2000)
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
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await fn()
      setStatus(await window.api.partnerDev.getStatus())
    } catch (e) {
      setError(errorText(e))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  const reply = (value: PartnerDevMessageReply) => {
    setMessages((old) => [...old.slice(-19), value.notice])
    if (value.taskNumber) {
      setTaskNumber(value.taskNumber)
      setText(`${value.taskNumber}：补充业务规则：仅允许查询本人有权限的交易。`)
    }
    if (value.runId) {
      setRunId(value.runId)
      setRun(null)
    }
  }
  const connected = !!status?.connected
  return (
    <div className="flex-1 min-w-0 overflow-y-auto p-6" data-testid="partner-dev-panel">
      <div className="mx-auto max-w-4xl space-y-5">
        <header>
          <h2 className="text-xl font-semibold">DevClaw 伙伴 · 开发联调</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            独立专家 / 协作团队 + 负责人本地节点 +
            假招乎。当前只使用模拟模型，不读取仓库，不调用真实招乎或真实模型。
          </p>
        </header>
        <div className="rounded-lg border bg-muted/30 p-3 text-sm" role="status">
          控制服务：{connected ? "已连接" : "未连接"}　节点：
          {status?.nodeEnabled ? "已启用" : "未启用"}　模型：模拟返回
          {status?.activeRunId && <span>　执行：{status.activeRunId}</span>}
        </div>
        {(error || status?.lastError) && (
          <p
            className="rounded-md border border-destructive/30 p-3 text-sm text-destructive"
            role="alert"
          >
            {error ?? ERRORS[status!.lastError!] ?? "节点连接失败，请手动重新连接。"}
          </p>
        )}
        <section className="space-y-3 rounded-xl border p-4">
          <h3 className="font-medium">1. 负责人连接与工作区</h3>
          <p className="text-xs text-muted-foreground">
            先按本地启动说明生成 connection.json。凭据只由 App 主进程保管；重开 App
            需手动连接、启用节点。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy}
              onClick={() => void action(() => window.api.partnerDev.importConnection())}
            >
              导入连接文件
            </Button>
            <Button
              variant="outline"
              disabled={busy || !status?.configured}
              onClick={() => void action(() => window.api.partnerDev.connect())}
            >
              连接服务
            </Button>
            <Button
              variant="outline"
              disabled={busy || !status?.configured}
              onClick={() => void action(() => window.api.partnerDev.chooseWorkspace())}
            >
              选择工作区
            </Button>
            <Button
              variant="outline"
              disabled={busy || !connected}
              onClick={() => void action(() => window.api.partnerDev.disconnect())}
            >
              断开
            </Button>
          </div>
          <div className="break-all text-xs text-muted-foreground">
            服务：{status?.url ?? "未导入"}
            <br />
            负责人：{status?.ownerPrincipalId ?? "—"}　业务身份：
            {status?.businessPrincipalId ?? "—"}　节点：{status?.nodeId ?? "—"}
            <br />
            工作区：{status?.workspacePath ?? "未选择（不使用当前聊天目录）"}
          </div>
        </section>
        <section className="space-y-3 rounded-xl border p-4">
          <h3 className="font-medium">2. 专家、团队与节点授权</h3>
          {!status?.groupId && (
            <>
              <label className="block text-sm">
                专家名称
                <Input
                  aria-label="专家名称"
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="block text-sm">
                专家指令
                <textarea
                  aria-label="专家指令"
                  className="mt-1 w-full rounded-md border bg-background p-2 text-sm"
                  rows={3}
                  maxLength={16384}
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                />
              </label>
              <Button
                disabled={busy || !connected}
                onClick={() =>
                  void action(() => window.api.partnerDev.createTeam({ name, instructions }))
                }
              >
                创建单专家团队
              </Button>
              <div className="flex gap-2">
                <Input
                  aria-label="已有团队 ID"
                  placeholder="或填入已有 Group ID（单专家团队）"
                  value={groupId}
                  onChange={(e) => setGroupId(e.target.value)}
                />
                <Button
                  variant="outline"
                  disabled={busy || !connected || !groupId}
                  onClick={() => void action(() => window.api.partnerDev.bindTeam({ groupId }))}
                >
                  绑定已有团队
                </Button>
              </div>
            </>
          )}
          {status?.groupId && (
            <p className="break-all text-xs text-muted-foreground">
              Group：{status.groupId}　专家：{status.botId}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || !connected || !status?.groupId || !status.workspacePath}
              onClick={() => void action(() => window.api.partnerDev.authorizeTeam())}
            >
              授权团队使用此节点（24小时）
            </Button>
            <Button
              variant="outline"
              disabled={busy || !connected || !status?.workspacePath || status.nodeEnabled}
              onClick={() => void action(() => window.api.partnerDev.enableNode())}
            >
              启用本地节点
            </Button>
            <Button
              variant="outline"
              disabled={busy || !status?.nodeEnabled}
              onClick={() => void action(() => window.api.partnerDev.stopNode())}
            >
              停止节点并等待清理
            </Button>
            <Button
              variant="outline"
              disabled={busy || !connected || !status?.groupId}
              onClick={() => void action(() => window.api.partnerDev.revokeTeam())}
            >
              撤销团队授权
            </Button>
          </div>
        </section>
        <section className="space-y-3 rounded-xl border p-4">
          <h3 className="font-medium">3. 假招乎群 · 业务人员入口</h3>
          <p className="text-xs text-muted-foreground">
            新任务只创建任务；TASK-编号用于明确澄清。点击分析需求才入队。本页模拟业务身份，没有回复串，也不默认读取整群消息。
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={mentioned}
              onChange={(e) => setMentioned(e.target.checked)}
            />
            结构化 @DevClaw伙伴
          </label>
          <textarea
            aria-label="假招乎消息"
            className="w-full rounded-md border bg-background p-2 text-sm"
            rows={3}
            value={text}
            maxLength={16384}
            onChange={(e) => setText(e.target.value)}
          />
          <Button
            disabled={busy || !connected || !status?.groupId || !text.trim()}
            onClick={() =>
              void action(async () =>
                reply(await window.api.partnerDev.sendMessage({ mentioned, text }))
              )
            }
          >
            发送消息
          </Button>
          <div className="flex gap-2">
            <Input
              aria-label="任务编号"
              placeholder="TASK-1"
              value={taskNumber}
              onChange={(e) => setTaskNumber(e.target.value)}
            />
            <Button
              disabled={busy || !connected || !taskNumber}
              onClick={() =>
                void action(async () =>
                  reply(await window.api.partnerDev.analyzeTask({ taskNumber }))
                )
              }
            >
              分析需求
            </Button>
          </div>
          <div className="space-y-1 text-sm" aria-live="polite">
            {messages.map((message, i) => (
              <p key={i} className="rounded bg-muted/40 p-2">
                {message}
              </p>
            ))}
          </div>
          <label className="block text-xs text-muted-foreground">
            执行编号（可查询持久结果）
            <Input
              aria-label="执行编号"
              value={runId}
              onChange={(e) => {
                setRunId(e.target.value)
                setRun(null)
              }}
            />
          </label>
          {run && (
            <div className="space-y-2 rounded-lg border p-3">
              <p className="text-sm">{RUN_LABELS[run.status] ?? run.status}</p>
              {run.result && (
                <pre
                  className="whitespace-pre-wrap break-words text-sm"
                  data-testid="partner-result"
                >
                  {run.result.text}
                </pre>
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
                  取消未领取任务
                </Button>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

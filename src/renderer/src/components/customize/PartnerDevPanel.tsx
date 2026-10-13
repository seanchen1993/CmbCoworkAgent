import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type {
  PartnerDevMessageReply,
  PartnerDevRunView,
  PartnerDevStatus
} from "../../../../shared/bot/partner-dev"
import type { GroupMemoryList, GroupMemoryWrite } from "../../../../shared/bot/group-memory"
import { GroupMemoryPanel, memorySourceLabel } from "./GroupMemoryPanel"

const ERRORS: Record<string, string> = {
  FORBIDDEN: "当前身份或授权不允许此操作。",
  UNAUTHENTICATED: "凭据已失效，请重新导入本地连接文件。",
  VERSION_CONFLICT: "版本已变化，请刷新后重试。",
  INPUT_CHANGED:
    "任务、来源或专家版本已变化，或有结果未知写入。请核对；未知写入须以相同内容重试，不能盲换指令。",
  OUTCOME_UNKNOWN: "上次执行结果不确定，不会自动重跑。",
  NODE_OFFLINE: "请先连接本地控制服务。",
  NOT_CONFIGURED: "请完成连接、工作区与团队配置。",
  STORAGE_FAILURE: "连接文件须为私有、当前用户拥有的普通文件；请检查启动说明。",
  STORAGE_UNAVAILABLE: "系统安全存储不可用，未保存明文凭据。",
  DEPENDENCY_UNAVAILABLE: "本地服务不可用或连接中断，请检查启动状态。",
  INVALID_PAYLOAD: "参数不符合当前文本开发版约束。",
  MEMORY_CHANGED: "团队记忆已变化，上次分析失效。请查看结果，是否重新分析由你决定。",
  PAYLOAD_TOO_LARGE: "记忆超过条数或装配预算，请先整理或停用条目。"
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
  const [useMemory, setUseMemory] = useState(false)
  const [memories, setMemories] = useState<GroupMemoryList | null>(null)
  const [memoryDraft, setMemoryDraft] = useState<GroupMemoryWrite | null>(null)
  const [lastTask, setLastTask] = useState<{ id: string; version: number; text: string } | null>(
    null
  )
  const [taskNumber, setTaskNumber] = useState(""),
    [runId, setRunId] = useState(""),
    [run, setRun] = useState<PartnerDevRunView | null>(null),
    [messages, setMessages] = useState<string[]>([])
  const busyRef = useRef(false),
    selection = useRef({ runId: "", taskNumber: "" }),
    requestEpoch = useRef(0),
    currentTeam = useRef<string | null>(null)
  useEffect(() => {
    selection.current = { runId, taskNumber }
  }, [runId, taskNumber])
  useEffect(() => {
    let alive = true,
      timer: ReturnType<typeof setTimeout> | undefined
    const refresh = async () => {
      const epoch = requestEpoch.current
      const currentRequest = () => alive && epoch === requestEpoch.current
      try {
        const current = await window.api.partnerDev.getStatus()
        if (!currentRequest()) return
        if (currentTeam.current !== current.groupId) {
          currentTeam.current = current.groupId
          setMemories(null)
          setMemoryDraft(null)
          setLastTask(null)
          setRun(null)
        }
        setStatus(current)
        if (current.connected && current.groupId) {
          const list = await window.api.partnerDev.listMemories()
          if (!currentRequest()) return
          setMemories(list)
        } else if (alive) {
          setMemories(null)
          setMemoryDraft(null)
          setLastTask(null)
        }
        if (!selection.current.taskNumber && current.lastTaskNumber)
          setTaskNumber(current.lastTaskNumber)
        const id = selection.current.runId || current.lastRunId
        if (!selection.current.runId && id) setRunId(id)
        if (current.connected && id) {
          const inspected = await window.api.partnerDev.inspectRun({ runId: id })
          if (currentRequest() && (!selection.current.runId || selection.current.runId === id))
            setRun(inspected)
        }
      } catch (e) {
        if (currentRequest()) {
          setError(errorText(e))
          setMemories(null)
          setRun(null)
        }
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
    requestEpoch.current++
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await fn()
      const current = await window.api.partnerDev.getStatus()
      if (currentTeam.current !== current.groupId) {
        currentTeam.current = current.groupId
        setMemories(null)
        setMemoryDraft(null)
        setLastTask(null)
        setRun(null)
      }
      setStatus(current)
    } catch (e) {
      setError(errorText(e))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }
  const reply = (value: PartnerDevMessageReply, submitted?: string) => {
    setMessages((old) => [...old.slice(-19), value.notice])
    if (value.taskNumber) {
      setTaskNumber(value.taskNumber)
      setText(`${value.taskNumber}：补充业务规则：仅允许查询本人有权限的交易。`)
    }
    if (submitted !== undefined)
      setLastTask(
        value.taskId && value.taskVersion
          ? { id: value.taskId, version: value.taskVersion, text: submitted }
          : null
      )
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
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  aria-label="新专家使用团队记忆"
                  checked={useMemory}
                  onChange={(e) => setUseMemory(e.target.checked)}
                />
                允许此专家使用本团队已确认的显式记忆（不自动记住聊天）
              </label>
              <Button
                disabled={busy || !connected}
                onClick={() =>
                  void action(() =>
                    window.api.partnerDev.createTeam({ name, instructions, useMemory })
                  )
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
                reply(await window.api.partnerDev.sendMessage({ mentioned, text }), text)
              )
            }
          >
            发送消息
          </Button>
          {lastTask && (
            <Button
              variant="outline"
              disabled={busy || !connected || !memories?.canManage}
              onClick={() =>
                setMemoryDraft({
                  text: lastTask.text.slice(0, 512),
                  source: { kind: "task", taskId: lastTask.id, taskVersion: lastTask.version }
                })
              }
            >
              从本次澄清准备团队记忆（预填前512字，须编辑确认）
            </Button>
          )}
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
              {run.result?.text === "MEMORY_CHANGED" && (
                <p className="text-sm text-destructive">
                  记忆变更使此次分析失效；未发布旧结果，也不会自动重跑。可明确点击分析需求重新执行。
                </p>
              )}
              {run.result?.outcome === "succeeded" && (
                <Button
                  variant="outline"
                  disabled={busy || !memories?.canManage}
                  onClick={() =>
                    setMemoryDraft({
                      text: run.result!.text.slice(0, 512),
                      source: { kind: "result", runId: run.runId }
                    })
                  }
                >
                  从结果准备团队记忆（模拟内容须核实）
                </Button>
              )}
              {run.memorySnapshot !== undefined && (
                <div
                  className="space-y-1 border-t pt-2 text-xs text-muted-foreground"
                  data-testid="run-memory-snapshot"
                >
                  <p>
                    {run.memorySnapshot === null
                      ? "此次专家未启用记忆"
                      : `此次使用记忆修订 ${run.memorySnapshot.revision} · ${run.memorySnapshot.memories.length}条`}
                  </p>
                  {run.memorySnapshot?.memories.map((m) => (
                    <p key={m.id} className="break-all">
                      v{m.version} · {m.text} · {memorySourceLabel(m.source)}
                    </p>
                  ))}
                </div>
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
        <GroupMemoryPanel
          connected={connected}
          groupId={status?.groupId ?? null}
          busy={busy}
          memories={memories}
          draft={memoryDraft}
          onChange={setMemories}
          action={action}
        />
      </div>
    </div>
  )
}

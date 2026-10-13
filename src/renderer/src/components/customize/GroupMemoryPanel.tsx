import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import type {
  GroupMemory,
  GroupMemoryList,
  GroupMemorySource,
  GroupMemoryWrite
} from "../../../../shared/bot/group-memory"

export function memorySourceLabel(source: GroupMemorySource): string {
  if (source.kind === "task") return `任务 ${source.taskId} · v${source.taskVersion}`
  if (source.kind === "result") return `执行结果 ${source.runId}`
  return "管理员手工说明"
}
export function GroupMemoryPanel(props: {
  connected: boolean
  groupId: string | null
  busy: boolean
  memories: GroupMemoryList | null
  draft: GroupMemoryWrite | null
  onChange: (value: GroupMemoryList) => void
  action: (fn: () => Promise<unknown>) => Promise<void>
}): React.JSX.Element {
  const [text, setText] = useState("")
  const [source, setSource] = useState<GroupMemorySource>({ kind: "manual" })
  const [editing, setEditing] = useState<GroupMemory | null>(null)
  useEffect(() => {
    setText("")
    setSource({ kind: "manual" })
    setEditing(null)
  }, [props.groupId])
  useEffect(() => {
    if (props.draft) {
      setText(props.draft.text)
      setSource(props.draft.source)
      setEditing(null)
    }
  }, [props.draft])
  const current = props.memories
  const enabled = current?.botPolicies.every((p) => p.memoryPolicy === "explicit_only") ?? false
  const disabled = props.busy || !props.connected || !props.groupId || !current?.canManage
  const save = (status: "active" | "disabled") =>
    props.action(async () => {
      const value = editing
        ? await window.api.partnerDev.updateMemory({
            text,
            source,
            memoryId: editing.id,
            expectedVersion: editing.version,
            status
          })
        : await window.api.partnerDev.createMemory({ text, source })
      props.onChange(value)
      setText("")
      setSource({ kind: "manual" })
      setEditing(null)
    })
  return (
    <section className="space-y-3 rounded-xl border p-4" data-testid="group-memory-panel">
      <h3 className="font-medium">4. 团队长期记忆</h3>
      <p className="text-xs text-muted-foreground">
        属于当前 Group，存于控制服务 MySQL，不属于负责人个人。仅手工确认发布，不自动吸收群消息。
        不同团队即使使用同一专家，也不会共享这里的资料。
      </p>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>
          当前专家：{current ? (enabled ? "允许显式记忆" : "尚未启用记忆") : "等待连接团队"}
        </span>
        {current && (
          <span>
            记忆修订：{current.revision} ·{" "}
            {current.memories.filter((m) => m.status === "active").length}/10 条有效
          </span>
        )}
        {!enabled && (
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() =>
              void props.action(async () => {
                await window.api.partnerDev.enableTeamMemory()
                props.onChange(await window.api.partnerDev.listMemories())
              })
            }
          >
            发布并采用允许记忆的新专家版本
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        启用需专家维护者和团队管理员权限，只改当前团队绑定，不自动升级其他团队。此操作停止本地节点，之后需手动启用。
      </p>
      <label className="block text-sm">
        跨任务可复用的记忆（最多512字符）
        <textarea
          aria-label="团队记忆正文"
          value={text}
          maxLength={512}
          rows={3}
          className="mt-1 w-full rounded-md border bg-background p-2 text-sm"
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <p className="break-all text-xs text-muted-foreground">
        来源：{memorySourceLabel(source)}
        {editing && ` · 编辑版本 v${editing.version}`}
      </p>
      <p className="text-xs text-muted-foreground">
        适合业务术语、长期系统约束和共同约定；本次需求范围、未核实代码判断和上线批准不应直接长期化。
        发布、修改或停用会使使用旧记忆的在途分析失效，不会自动重跑；停用不会擦除历史结果。
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={disabled || !text.trim()}
          onClick={() => void save(editing?.status ?? "active")}
        >
          {editing ? "确认修改" : "确认发布到本团队"}
        </Button>
        <Button
          variant="outline"
          disabled={props.busy}
          onClick={() => {
            setText("")
            setSource({ kind: "manual" })
            setEditing(null)
          }}
        >
          清空候选
        </Button>
        {source.kind !== "manual" && (
          <Button
            variant="outline"
            disabled={props.busy}
            onClick={() => setSource({ kind: "manual" })}
          >
            改为手工说明
          </Button>
        )}
      </div>
      <div className="space-y-2" aria-live="polite">
        {current?.memories.map((memory) => (
          <article
            key={memory.id}
            className="space-y-2 rounded-md border p-3"
            data-testid="group-memory-entry"
          >
            <p className="whitespace-pre-wrap break-words text-sm">{memory.text}</p>
            <p className="break-all text-xs text-muted-foreground">
              {memory.status === "active" ? "有效" : "已停用"} · v{memory.version} ·{" "}
              {memorySourceLabel(memory.source)}
              <br />
              修改人：{memory.updatedBy} · {memory.updatedAt}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={disabled}
                onClick={() => {
                  setEditing(memory)
                  setText(memory.text)
                  setSource(memory.source)
                }}
              >
                编辑
              </Button>
              {memory.status === "active" ? (
                <Button
                  variant="outline"
                  disabled={disabled}
                  onClick={() =>
                    void props.action(async () =>
                      props.onChange(
                        await window.api.partnerDev.disableMemory({
                          memoryId: memory.id,
                          expectedVersion: memory.version
                        })
                      )
                    )
                  }
                >
                  停用
                </Button>
              ) : (
                <Button
                  variant="outline"
                  disabled={disabled}
                  onClick={() =>
                    void props.action(async () =>
                      props.onChange(
                        await window.api.partnerDev.updateMemory({
                          memoryId: memory.id,
                          expectedVersion: memory.version,
                          text: memory.text,
                          source: memory.source,
                          status: "active"
                        })
                      )
                    )
                  }
                >
                  重新启用
                </Button>
              )}
            </div>
          </article>
        ))}
        {current && !current.memories.length && (
          <p className="text-sm text-muted-foreground">
            尚无已发布记忆，可以从任务澄清准备候选，或手工填写。
          </p>
        )}
      </div>
    </section>
  )
}

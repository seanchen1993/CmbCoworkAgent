import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { ExpertMemory, ExpertMemoryList } from "../../../../shared/bot/expert-memory"

export function ExpertMemoryPanel(props: {
  connected: boolean
  botId: string | null
  busy: boolean
  memories: ExpertMemoryList | null
  canManage?: boolean
  onChange: (value: ExpertMemoryList) => void
  action: (fn: () => Promise<unknown>) => Promise<void>
}): React.JSX.Element {
  const [text, setText] = useState(""),
    [query, setQuery] = useState(""),
    [editing, setEditing] = useState<ExpertMemory | null>(null)
  useEffect(() => {
    setText("")
    setQuery("")
    setEditing(null)
  }, [props.botId])
  const disabled = props.busy || !props.connected || !props.memories?.canManage
  const save = () =>
    props.action(async () => {
      const list = editing
        ? await window.api.partnerDev.updateExpertMemory({
            memoryId: editing.id,
            expectedVersion: editing.version,
            text,
            status: editing.status
          })
        : await window.api.partnerDev.createExpertMemory({ text })
      props.onChange(list)
      setText("")
      setEditing(null)
    })
  return (
    <div className="space-y-3 pt-3" data-testid="expert-memory-panel">
      <p className="text-xs text-muted-foreground">
        由专家维护者手工确认，供采用此专家记忆的任务共享。不自动学习聊天；请勿保存仅限某个招乎群的私有资料。
      </p>
      {props.canManage === false && (
        <p className="text-sm text-muted-foreground">
          只有当前专家维护者可以管理长期记忆；任务仍按已授权的专家快照执行。
        </p>
      )}
      <Input
        aria-label="检索专家记忆"
        placeholder="检索记忆关键词"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <textarea
        aria-label="专家记忆正文"
        placeholder="例如：本产品的业务日以交易日历为准。最多512字符。"
        rows={3}
        maxLength={512}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        className="w-full rounded-md border bg-background p-2 text-sm"
      />
      <div className="flex gap-2">
        <Button disabled={disabled || !text.trim()} onClick={() => void save()}>
          {editing ? "保存修改" : "保存到专家记忆"}
        </Button>
        {editing && (
          <Button
            variant="outline"
            disabled={props.busy}
            onClick={() => {
              setEditing(null)
              setText("")
            }}
          >
            取消编辑
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        记忆变更会使使用旧资料的在途分析失效，不自动重跑；停用不会擦除历史结果。
      </p>
      <div className="space-y-2" aria-live="polite">
        {!props.connected && (
          <p className="text-sm text-muted-foreground">
            连接恢复前无法核对权限，暂不展示本地缓存正文。
          </p>
        )}
        {props.connected &&
          props.memories?.memories
            .filter((m) => m.text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
            .map((memory) => (
              <article
                key={memory.id}
                className="space-y-2 rounded-md border p-3"
                data-testid="expert-memory-entry"
              >
                <p className="whitespace-pre-wrap break-words text-sm">{memory.text}</p>
                <p className="text-xs text-muted-foreground">
                  {memory.status === "active" ? "有效" : "已停用"} · {memory.updatedAt}
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    disabled={disabled}
                    onClick={() => {
                      setEditing(memory)
                      setText(memory.text)
                    }}
                  >
                    编辑
                  </Button>
                  <Button
                    variant="outline"
                    disabled={disabled}
                    onClick={() =>
                      void props.action(async () => {
                        props.onChange(
                          memory.status === "active"
                            ? await window.api.partnerDev.disableExpertMemory({
                                memoryId: memory.id,
                                expectedVersion: memory.version
                              })
                            : await window.api.partnerDev.updateExpertMemory({
                                memoryId: memory.id,
                                expectedVersion: memory.version,
                                text: memory.text,
                                status: "active"
                              })
                        )
                        if (editing?.id === memory.id) {
                          setEditing(null)
                          setText("")
                        }
                      })
                    }
                  >
                    {memory.status === "active" ? "停用" : "重新启用"}
                  </Button>
                </div>
              </article>
            ))}
        {props.connected && props.memories && !props.memories.memories.length && (
          <p className="text-sm text-muted-foreground">
            尚无记忆。先保存少量长期有效的业务约定即可。
          </p>
        )}
      </div>
    </div>
  )
}

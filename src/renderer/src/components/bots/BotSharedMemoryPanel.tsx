import { useBotSharedMemoryMutation } from "@/lib/use-bot-shared-memory-mutation"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"
import { botApi } from "@/lib/bot-api"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { FolderOpen, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { CoworkBot, BotMemory } from "../../../../shared/bot-types"
import {
  BOT_SHARED_MEMORY_TEXT_LIMIT,
  type BotSharedMemoryScope
} from "../../../../shared/bot-memory"
import { MemoryCard } from "./BotMemoryPanel"
import { useBotViewVisibility } from "@/lib/use-bot-view-visibility"

export function BotSharedMemoryPanel({
  bot,
  scope,
  close
}: {
  bot: CoworkBot
  scope: BotSharedMemoryScope
  close(): void
}) {
  const viewVisible = useBotViewVisibility()
  const [items, setItems] = useState<BotMemory[]>([]),
    [text, setText] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const currentDataEpoch = useBotWorkspaceStore((state) => state.snapshot?.dataEpoch)
  const supported = useBotWorkspaceStore((state) =>
    Boolean(
      state.host?.capabilities?.includes("mutation-data-epoch-v2") &&
      state.host.capabilities.includes("memory-mutation-epoch")
    )
  )
  const [dataEpoch] = useState(currentDataEpoch)
  const lifetime = useRef({ mounted: false, generation: 0 }),
    sequence = useRef({ value: 0 })
  useLayoutEffect(() => {
    const owner = lifetime.current,
      counter = sequence.current
    owner.mounted = true
    owner.generation++
    return () => {
      owner.mounted = false
      owner.generation++
      counter.value++
    }
  }, [])
  const current = useCallback(
    () => Boolean(dataEpoch) && useBotWorkspaceStore.getState().snapshot?.dataEpoch === dataEpoch,
    [dataEpoch]
  )
  const reload = useCallback(async () => {
    if (!lifetime.current.mounted || !current()) return
    const request = ++sequence.current.value
    const next = await botApi.sharedMemories({ botId: bot.id, botRevision: bot.revision, scope })
    if (lifetime.current.mounted && current() && request === sequence.current.value) {
      setItems(next)
      setLoaded(true)
      setError(null)
    }
  }, [bot.id, bot.revision, scope, current])
  const session = useBotSharedMemoryMutation(bot.id, scope, async (receipt, live) => {
    if (!live()) return
    await reload()
    if (!live()) return
    if (receipt.input.operation === "save" && !receipt.input.request.id) setText("")
  })
  const sessionRef = useRef(session)
  sessionRef.current = session
  useEffect(() => {
    if (!viewVisible || !current() || session.restored) return
    let alive = true
    const counter = sequence.current
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        if (!sessionRef.current.isSaving()) await reload()
      } catch (failure) {
        if (alive && current())
          setError(failure instanceof Error ? failure.message : "共享记忆读取失败")
      } finally {
        if (alive && current()) timer = setTimeout(() => void refresh(), 3000)
      }
    }
    void refresh()
    return () => {
      alive = false
      counter.value++
      clearTimeout(timer)
    }
  }, [reload, viewVisible, current, session.restored])
  const disabled = !supported || !dataEpoch || session.fieldsDisabled
  const save = async () => {
    if (!supported || !dataEpoch || !loaded || !text.trim()) return
    await session.save(() => {
      const nonce = crypto.randomUUID()
      return {
        operation: "save",
        dataEpoch,
        nonce,
        request: {
          botId: bot.id,
          botRevision: bot.revision,
          scope,
          text,
          nonce,
          expectedDataEpoch: dataEpoch
        }
      }
    })
  }
  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-xl border bg-muted/25 p-4">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          {scope === "project" ? <FolderOpen size={15} /> : <Users size={15} />}
          {scope === "project" ? "同项目的 Bot 共用" : "我的所有 Bot 共用"}
        </h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {scope === "project"
            ? "仅项目目录相同的 Bot 可检索；切换项目后使用对应项目的记忆。"
            : "供当前本机用户的所有 Bot 使用，适合通用工作偏好。"}
          共享内容由你填写，私聊不会自动公开；自动整理不会修改。
        </p>
        {scope === "project" && (
          <p className="break-all text-xs text-muted-foreground">{bot.workspacePath}</p>
        )}
      </div>
      {(error || session.error) && !session.restored && (
        <p role="alert" className="text-sm text-destructive">
          {session.error ?? error}
        </p>
      )}
      {(session.restored || !supported || !dataEpoch) && (
        <p role="alert" className="text-xs text-muted-foreground">
          {session.restored
            ? "工作区数据已恢复，请关闭后重新打开核对原操作。"
            : "请更新 Bot 后台后修改共享记忆，原内容保持不变。"}
        </p>
      )}
      <BotPendingSaveRecovery
        record={session.record}
        dataEpoch={session.epoch}
        discard={session.discard}
        onRepaired={session.refreshRecord}
        operationLabel="共享记忆操作"
      />
      {(session.pending || session.acknowledged) && (
        <div className="space-y-2 rounded-lg border p-3 text-xs" role="status">
          <p>
            {session.acknowledged
              ? "原操作已确认，重试只核对本机记录和当前列表。"
              : "有一次共享记忆操作尚未确认，重试只提交原请求。"}
          </p>
          {session.pending && (
            <p className="break-all text-muted-foreground">
              {session.pending.operation === "delete"
                ? "删除"
                : session.pending.request.id
                  ? "修订"
                  : "新增"}{" "}
              · {session.pending.request.id ?? "新记忆"}
            </p>
          )}
          <Button
            type="button"
            size="sm"
            disabled={!supported || session.saveDisabled}
            onClick={() => void session.save()}
          >
            核对原记忆操作
          </Button>
        </div>
      )}
      {!loaded && !error && <p className="text-sm text-muted-foreground">正在读取共享记忆…</p>}
      {loaded && !items.length && (
        <p className="py-5 text-center text-sm text-muted-foreground">此范围还没有共享记忆</p>
      )}
      {items.map((memory) => (
        <MemoryCard
          key={memory.id}
          memory={memory}
          reload={reload}
          close={close}
          actions={{
            session,
            save: (text, revision) =>
              session.save(() => {
                const nonce = crypto.randomUUID()
                return {
                  operation: "save",
                  dataEpoch: session.epoch,
                  nonce,
                  request: {
                    botId: bot.id,
                    botRevision: bot.revision,
                    scope,
                    id: memory.id,
                    revision,
                    text,
                    nonce,
                    expectedDataEpoch: session.epoch
                  }
                }
              }),
            remove: (revision) =>
              session.save(() => {
                const nonce = crypto.randomUUID()
                return {
                  operation: "delete",
                  dataEpoch: session.epoch,
                  nonce,
                  request: {
                    botId: bot.id,
                    botRevision: bot.revision,
                    scope,
                    id: memory.id,
                    revision,
                    nonce,
                    expectedDataEpoch: session.epoch
                  }
                }
              })
          }}
        />
      ))}
      <form
        className="space-y-3 border-t pt-4"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <label htmlFor={`shared-memory-${bot.id}-${scope}`} className="text-sm font-medium">
          添加共享记忆
        </label>
        <textarea
          id={`shared-memory-${bot.id}-${scope}`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={disabled}
          maxLength={BOT_SHARED_MEMORY_TEXT_LIMIT}
          rows={4}
          className="w-full rounded-lg border border-input bg-background p-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          placeholder={
            scope === "project"
              ? "这个项目的技术约定、术语或已确认经验"
              : "希望所有 Bot 了解的工作偏好"
          }
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            保存后将用于此范围内 Bot 的后续任务。
          </span>
          <Button disabled={disabled || !loaded || !text.trim()}>
            {session.busy ? "保存中…" : "保存共享记忆"}
          </Button>
        </div>
      </form>
    </div>
  )
}

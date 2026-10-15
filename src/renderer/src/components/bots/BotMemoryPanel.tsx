import { botErrorMessage } from "@/lib/bot-error-message"
import { useEffect, useRef, useState } from "react"
import { Check, Loader2, Pencil, Plus, Share2, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { BotClient, BotDefinition, BotMemory } from "../../../../shared/bots/contracts"

export function BotMemoryPanel({
  botId,
  client,
  peers
}: {
  botId: string
  client: BotClient
  peers: BotDefinition[]
}) {
  const [entries, setEntries] = useState<BotMemory[] | null>(null)
  const [editing, setEditing] = useState<BotMemory | "new" | null>(null)
  const [name, setName] = useState("")
  const [content, setContent] = useState("")
  const [deleting, setDeleting] = useState<string | null>(null)
  const [sharing, setSharing] = useState<string | null>(null)
  const [recipient, setRecipient] = useState("")
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lock = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    let disposed = false
    client
      .listMemory(botId)
      .then((result) => {
        if (!disposed) setEntries(result)
      })
      .catch((cause) => {
        if (!disposed) setError(botErrorMessage(cause))
      })
    return () => {
      disposed = true
      mounted.current = false
    }
  }, [botId, client])
  const edit = (entry: BotMemory | "new") => {
    setEditing(entry)
    setError(null)
    setDeleting(null)
    setSharing(null)
    setName(entry === "new" ? "" : entry.name)
    setContent(entry === "new" ? "" : entry.content)
  }
  const mutate = async (operation: () => Promise<unknown>) => {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError(null)
    try {
      await operation()
      const result = await client.listMemory(botId)
      if (mounted.current) {
        setEntries(result)
        setEditing(null)
        setDeleting(null)
        setSharing(null)
      }
    } catch (cause) {
      if (mounted.current) setError(botErrorMessage(cause, "保存失败"))
    } finally {
      lock.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <section className="bot-detail-section">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="!mb-0">私有记忆</h3>
        <button
          className="bot-icon-button"
          aria-label="添加记忆"
          disabled={busy}
          onClick={() => edit("new")}
        >
          <Plus size={16} />
        </button>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        此 Bot 保存的偏好和经验。你可以随时修改或删除。
      </p>
      {error && (
        <p role="alert" className="mb-3 text-xs text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mb-3 text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      {editing ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            void mutate(() =>
              client.writeMemory(botId, {
                name,
                content,
                ...(editing === "new" ? {} : { id: editing.id, expectedVersion: editing.version })
              })
            )
          }}
        >
          <label className="bot-field">
            名称
            <input
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="bot-field">
            内容
            <textarea
              required
              rows={6}
              maxLength={12_000}
              value={content}
              onChange={(event) => setContent(event.target.value)}
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setEditing(null)}
            >
              取消
            </Button>
            <Button size="sm" disabled={busy || !name.trim() || !content.trim()}>
              保存
            </Button>
          </div>
        </form>
      ) : entries ? (
        entries.length ? (
          entries.map((entry) => (
            <article className="bot-task-item" key={entry.id}>
              <div className="flex items-center justify-between gap-2">
                <h4 className="truncate font-medium">{entry.name}</h4>
                <div className="flex shrink-0">
                  <button
                    className="bot-icon-button"
                    aria-label={`分享 ${entry.name}`}
                    disabled={busy}
                    onClick={() => {
                      setSharing(entry.id)
                      setRecipient("")
                      setDeleting(null)
                      setNotice(null)
                    }}
                  >
                    <Share2 size={13} />
                  </button>
                  <button
                    className="bot-icon-button"
                    aria-label={`编辑 ${entry.name}`}
                    disabled={busy}
                    onClick={() => edit(entry)}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    className="bot-icon-button"
                    aria-label={`删除 ${entry.name}`}
                    disabled={busy}
                    onClick={() => {
                      setDeleting(entry.id)
                      setSharing(null)
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
              <p>{entry.content}</p>
              {sharing === entry.id && (
                <div className="mt-3 space-y-3">
                  <label className="bot-field">
                    分享给
                    <select
                      value={recipient}
                      onChange={(event) => setRecipient(event.target.value)}
                    >
                      <option value="">选择 Bot</option>
                      {peers
                        .filter((bot) => bot.id !== botId && !bot.archived)
                        .map((bot) => (
                          <option key={bot.id} value={bot.id}>
                            {bot.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <p className="text-xs text-muted-foreground">
                    仅复制这条记忆，后续修改互不影响。
                  </p>
                  <div className="flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => setSharing(null)}
                    >
                      取消
                    </Button>
                    <Button
                      size="sm"
                      disabled={busy || !recipient}
                      onClick={() =>
                        void mutate(async () => {
                          await client.shareMemory(botId, entry.id, entry.version, recipient)
                          if (mounted.current) setNotice("已将这条记忆分享给所选 Bot。")
                        })
                      }
                    >
                      分享
                    </Button>
                  </div>
                </div>
              )}
              {deleting === entry.id && (
                <div className="mt-2 flex items-center gap-2 text-xs">
                  <span className="flex-1">删除这条记忆？</span>
                  <button
                    className="bot-icon-button"
                    disabled={busy}
                    aria-label="确认删除记忆"
                    onClick={() =>
                      void mutate(() => client.removeMemory(botId, entry.id, entry.version))
                    }
                  >
                    <Check size={16} />
                  </button>
                  <button
                    className="bot-icon-button"
                    disabled={busy}
                    aria-label="取消删除"
                    onClick={() => setDeleting(null)}
                  >
                    <X size={16} />
                  </button>
                </div>
              )}
            </article>
          ))
        ) : (
          <p className="text-muted-foreground">还没有保存记忆。</p>
        )
      ) : (
        !error && <Loader2 className="size-4 animate-spin" />
      )}
    </section>
  )
}

import { botApi } from "@/lib/bot-api"
import { useEffect, useId, useRef, useState } from "react"
import { KeyRound, Loader2, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "./BotDialog"
import {
  botSecretProtectionDescription,
  type BotSecretCatalog,
  type BotSecretMetadata
} from "../../../../shared/bot-secrets"

/** Values live only in the mounted form, never in workspace drafts or local storage. */
export function BotSecrets({ botId, name, close }: { botId: string; name: string; close(): void }) {
  const [catalog, setCatalog] = useState<BotSecretCatalog | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [editing, setEditing] = useState<BotSecretMetadata | "new" | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  useEffect(() => {
    let active = true
    void botApi
      .secrets(botId)
      .then((value) => {
        if (active) {
          setCatalog(value)
          setFailure(null)
        }
      })
      .catch((error) => {
        if (active) setFailure(error instanceof Error ? error.message : "凭据列表无法加载")
      })
    return () => {
      active = false
    }
  }, [botId, revision])
  const remove = async (item: BotSecretMetadata) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setFailure(null)
    try {
      await botApi.deleteSecret({ botId, id: item.id, revision: item.revision })
      setCatalog(
        (value) => value && { ...value, items: value.items.filter((entry) => entry.id !== item.id) }
      )
      setRemoving(null)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "删除失败，请刷新后重试")
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound size={19} />
            {name} 的凭据
          </DialogTitle>
          <DialogDescription>
            为这个 Bot 保存网站密码。使用时显示目标网站并请求审批，密码不进入聊天或模型上下文。
          </DialogDescription>
        </DialogHeader>
        {catalog && (
          <div className="flex gap-2 rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
            <ShieldCheck size={16} className="mt-0.5 shrink-0" />
            <p>{botSecretProtectionDescription(catalog)}</p>
          </div>
        )}
        {failure && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 rounded-lg bg-destructive/5 p-3 text-sm text-destructive"
          >
            <span>{failure}</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setRevision((value) => value + 1)}
            >
              <RefreshCw size={14} />
              刷新
            </Button>
          </div>
        )}
        {!catalog && !failure && (
          <p role="status" className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 size={16} className="animate-spin" />
            正在加载凭据…
          </p>
        )}
        {editing ? (
          <SecretForm
            key={editing === "new" ? "new" : `${editing.id}:${editing.revision}`}
            botId={botId}
            item={editing === "new" ? undefined : editing}
            saved={() => {
              setEditing(null)
              setRevision((value) => value + 1)
            }}
            cancel={() => setEditing(null)}
          />
        ) : (
          catalog && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">
                  网站密码{" "}
                  <span className="ml-1 text-muted-foreground">{catalog.items.length}</span>
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setRemoving(null)
                    setEditing("new")
                  }}
                >
                  <Plus size={15} />
                  添加凭据
                </Button>
              </div>
              {!catalog.items.length && (
                <div className="rounded-xl border border-dashed px-6 py-9 text-center">
                  <KeyRound className="mx-auto mb-3 text-muted-foreground" size={24} />
                  <p className="text-sm">还没有保存凭据</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    添加后，Bot 可申请填入指定网站的密码框。
                  </p>
                </div>
              )}
              <ul className="space-y-2">
                {catalog.items.map((item) => (
                  <li key={item.id} className="rounded-xl border p-3">
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 rounded-lg bg-muted p-2">
                        <KeyRound size={16} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="break-words text-sm font-medium">{item.name}</p>
                        <p className="mt-1 break-all text-xs text-muted-foreground">
                          {item.origin}
                        </p>
                        {item.description && (
                          <p className="mt-1 break-words text-xs text-muted-foreground">
                            {item.description}
                          </p>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        aria-label={`替换 ${item.name}`}
                        onClick={() => {
                          setRemoving(null)
                          setEditing(item)
                        }}
                      >
                        替换
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busy}
                        aria-label={`删除凭据 ${item.name}`}
                        onClick={() => setRemoving(item.id)}
                      >
                        <Trash2 size={15} />
                      </Button>
                    </div>
                    {removing === item.id && (
                      <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
                        <p className="flex-1 text-xs text-muted-foreground">
                          删除后，尚未执行的使用授权会失效。
                        </p>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => setRemoving(null)}
                        >
                          取消
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          disabled={busy}
                          onClick={() => void remove(item)}
                        >
                          {busy && <Loader2 size={14} className="animate-spin" />}确认删除凭据
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )
        )}
      </DialogContent>
    </Dialog>
  )
}

function SecretForm({
  botId,
  item,
  saved,
  cancel
}: {
  botId: string
  item?: BotSecretMetadata
  saved(): void
  cancel(): void
}) {
  const id = useId()
  const [name, setName] = useState(item?.name ?? "")
  const [origin, setOrigin] = useState(item?.origin ?? "")
  const [description, setDescription] = useState(item?.description ?? "")
  const [value, setValue] = useState("")
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  return (
    <form
      className="space-y-4"
      autoComplete="off"
      onSubmit={async (event) => {
        event.preventDefault()
        if (pending.current || !value || !name.trim() || !origin.trim()) return
        pending.current = true
        setBusy(true)
        setFailure(null)
        const input = {
          botId,
          ...(item ? { id: item.id, revision: item.revision } : {}),
          name,
          origin: origin.trim(),
          description,
          value
        }
        setValue("")
        try {
          await botApi.saveSecret(input)
          saved()
        } catch (error) {
          setFailure(
            `${error instanceof Error ? error.message : "保存失败"}；重试时请重新输入密码。`
          )
        } finally {
          input.value = ""
          pending.current = false
          setBusy(false)
        }
      }}
    >
      <h3 className="text-sm font-medium">{item ? "替换凭据" : "添加凭据"}</h3>
      <div className="space-y-2">
        <label htmlFor={`${id}-name`} className="text-xs font-medium">
          凭据名称
        </label>
        <Input
          id={`${id}-name`}
          value={name}
          maxLength={120}
          required
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          placeholder="例如：研发平台登录"
        />
      </div>
      <div className="space-y-2">
        <label htmlFor={`${id}-origin`} className="text-xs font-medium">
          允许使用的网站
        </label>
        <Input
          id={`${id}-origin`}
          value={origin}
          maxLength={8192}
          required
          type="url"
          disabled={busy}
          onChange={(event) => setOrigin(event.target.value)}
          placeholder="https://dev.example.com"
        />
        <p className="text-xs text-muted-foreground">
          填写完整网站地址，不含页面路径。不会自动授权其他子域名。
        </p>
      </div>
      <div className="space-y-2">
        <label htmlFor={`${id}-description`} className="text-xs font-medium">
          用途说明（可选）
        </label>
        <Input
          id={`${id}-description`}
          value={description}
          maxLength={400}
          disabled={busy}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="帮助 Bot 选择正确凭据，请勿填写密码"
        />
      </div>
      <div className="space-y-2">
        <label htmlFor={`${id}-value`} className="text-xs font-medium">
          {item ? "新密码" : "密码"}
        </label>
        <Input
          id={`${id}-value`}
          value={value}
          maxLength={16000}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          required
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
        />
        {item && (
          <p className="text-xs text-muted-foreground">
            原密码不会回显。保存后，旧版本的使用授权会失效。
          </p>
        )}
      </div>
      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setValue("")
            cancel()
          }}
        >
          取消
        </Button>
        <Button type="submit" disabled={busy || !value || !name.trim() || !origin.trim()}>
          {busy && <Loader2 size={15} className="animate-spin" />}
          {item ? "保存替换" : "保存凭据"}
        </Button>
      </div>
    </form>
  )
}
